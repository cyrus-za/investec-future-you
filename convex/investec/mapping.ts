/**
 * Heuristics for mapping Investec transaction metadata onto our domain model.
 *
 * Ported from the household-budget app's worker/src/investec/mapping.ts
 * (Cloudflare-Workers-specific bits removed; logic is unchanged).
 */

/** Extract the last 4 digits from Investec `cardNumber` like "402261xxxxxx0011". */
export function extractLast4(cardNumber?: string | null): string | null {
  if (!cardNumber) return null;
  const m = /(\d{4})\s*$/.exec(cardNumber);
  return m ? m[1] : null;
}

/**
 * Derive a "merchant" candidate from the description.
 * Investec descriptions can look like: "KURUMAN FRESH PRODUCE H KURUMAN ZA" or
 * "YOCO   *ARUKAH HEALTH KURUMAN ZA". We take the first token group up to the
 * first 2-letter country code.
 */
export function deriveMerchantName(description: string): string {
  const cleaned = normaliseDescription(description);
  const parts = cleaned.split(" ");
  const trimmed = parts.filter((p, i) => {
    if (i === parts.length - 1 && /^[A-Z]{2}$/u.test(p)) return false;
    return true;
  });
  return trimmed.join(" ");
}

/**
 * Collapse the runs of internal whitespace Investec pads descriptions with
 * ("Amazon Retail            Lagos        ZA" -> "Amazon Retail Lagos ZA").
 */
export function normaliseDescription(description: string | null | undefined): string {
  return (description ?? "").replace(/\s+/gu, " ").trim();
}

/**
 * Determine posting time as UTC ms from Investec ISO date fields.
 *
 * Prefers transactionDate (the real economic date) over postingDate, falls
 * back to actionDate, then postingDate, then now() as a last resort.
 *
 * Why this order: in the sandbox, `postingDate` can be days (card purchases)
 * or months (savings products: "2027-01-02") in the FUTURE relative to the
 * real purchase date, `valueDate` is often a far-future month-end and
 * `actionDate` is simply the date the data was generated. `transactionDate`
 * is the only field that consistently reflects when money actually moved.
 */
export function derivePostedAtMs(tx: {
  postingDate?: string | null;
  transactionDate?: string | null;
  actionDate?: string | null;
  valueDate?: string | null;
}): number {
  const iso =
    (tx.transactionDate && tx.transactionDate.trim()) ||
    (tx.actionDate && tx.actionDate.trim()) ||
    (tx.valueDate && tx.valueDate.trim()) ||
    (tx.postingDate && tx.postingDate.trim()) ||
    null;
  if (!iso) return Date.now();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  if (!m) return Date.parse(iso) || Date.now();
  const SAST = 2 * 60 * 60 * 1000;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - SAST;
}

/** Amount in signed cents. Investec "amount" is positive, with type indicating sign. */
export function deriveAmountCents(amount: number, type: string | null | undefined): number {
  const cents = Math.round(amount * 100);
  if (type && type.toUpperCase() === "DEBIT") return -cents;
  return cents;
}

/**
 * Compose a stable, unique id for a transaction when Investec doesn't give one.
 * `postedOrder` is intentionally excluded — Investec can renumber transactions
 * within a posting date between API calls.
 */
type IdentifiableTx = {
  uuid?: string | null;
  accountId: string;
  postingDate?: string | null;
  transactionDate?: string | null;
  amount: number;
  description: string;
  postedOrder?: number | null;
};

function contentHashId(tx: IdentifiableTx): string {
  const stableDate =
    (tx.transactionDate && tx.transactionDate.trim()) ||
    (tx.postingDate && tx.postingDate.trim()) ||
    "";
  const key = [
    tx.accountId,
    stableDate,
    String(tx.amount),
    tx.description.slice(0, 40),
  ].join("|");
  let hash = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return `${tx.accountId}-${stableDate || "x"}-${hash.toString(16)}`;
}

export function deriveTransactionId(tx: IdentifiableTx): string {
  if (tx.uuid) return tx.uuid;
  return contentHashId(tx);
}

/**
 * Assign a unique, stable id to every transaction in one API response.
 *
 * Investec's `uuid` is normally unique, but the sandbox's savings products
 * return several rows sharing one uuid (all with postedOrder 0), which would
 * make a plain upsert-by-uuid silently collapse them into a single row. The
 * first row keeps the bare uuid (so ids already stored stay stable); any
 * later row that collides gets `<uuid>~<contentHash>` so it is still
 * deterministic across syncs. Returns ids positionally aligned with `txs`.
 */
export function assignTransactionIds(txs: IdentifiableTx[]): string[] {
  const seen = new Set<string>();
  return txs.map((tx) => {
    let id = deriveTransactionId(tx);
    if (seen.has(id)) {
      id = `${id}~${contentHashId(tx).split("-").pop()}`;
      // Still colliding (identical content twice)? Fall back to a counter.
      let n = 2;
      while (seen.has(id)) id = `${id}~${n++}`;
    }
    seen.add(id);
    return id;
  });
}

/**
 * Normalise a merchant/description string for fuzzy matching by stripping
 * trailing all-numeric tokens (order reference numbers, e.g.
 * "CORICRAFT 498773082" -> "CORICRAFT").
 */
export function merchantBaseName(s: string): string {
  const words = s.toUpperCase().trim().split(/\s+/);
  while (words.length > 0 && /^\d+$/.test(words[words.length - 1])) {
    words.pop();
  }
  return words.join(" ");
}

/**
 * Returns true when two merchant/description strings likely refer to the
 * same merchant, after stripping trailing numeric references.
 */
export function merchantMatches(a: string, b: string): boolean {
  const na = merchantBaseName(a);
  const nb = merchantBaseName(b);
  if (na.length < 3 || nb.length < 3) return false;
  const shorter = na.length <= nb.length ? na : nb;
  const longer = na.length <= nb.length ? nb : na;
  return longer.startsWith(shorter) || merchantPrefixTokensMatch(na, nb);
}

function merchantPrefixTokensMatch(a: string, b: string): boolean {
  const aTokens = a.split(/\s+/u);
  const bTokens = b.split(/\s+/u);
  let shared = 0;
  for (let i = 0; i < Math.min(aTokens.length, bTokens.length); i++) {
    const left = aTokens[i];
    const right = bTokens[i];
    const matches =
      left === right ||
      (left.length >= 3 &&
        right.length >= 3 &&
        (left.startsWith(right) || right.startsWith(left)));
    if (!matches) break;
    shared++;
  }
  return shared >= 4;
}
