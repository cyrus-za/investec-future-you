/**
 * Heuristics for mapping Investec transaction metadata onto our domain model.
 *
 * Ported from the household-budget app's worker/src/investec/mapping.ts
 * (Cloudflare-Workers-specific bits removed; logic is unchanged).
 */

/** Extract the last 4 digits from Investec `cardNumber` like "402261xxxxxx0011". */
export function extractLast4(cardNumber?: string): string | null {
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
  const cleaned = description.replace(/\s+/gu, " ").trim();
  const parts = cleaned.split(" ");
  const trimmed = parts.filter((p, i) => {
    if (i === parts.length - 1 && /^[A-Z]{2}$/u.test(p)) return false;
    return true;
  });
  return trimmed.join(" ");
}

/**
 * Determine posting time as UTC ms from Investec ISO date fields.
 *
 * Prefers transactionDate (the real economic date) over postingDate, falls
 * back to actionDate, then postingDate, then now() as a last resort.
 */
export function derivePostedAtMs(tx: {
  postingDate?: string;
  transactionDate?: string;
  actionDate?: string;
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
export function deriveAmountCents(amount: number, type: string | undefined): number {
  const cents = Math.round(amount * 100);
  if (type && type.toUpperCase() === "DEBIT") return -cents;
  return cents;
}

/**
 * Compose a stable, unique id for a transaction when Investec doesn't give one.
 * `postedOrder` is intentionally excluded — Investec can renumber transactions
 * within a posting date between API calls.
 */
export function deriveTransactionId(tx: {
  uuid?: string;
  accountId: string;
  postingDate?: string;
  transactionDate?: string;
  amount: number;
  description: string;
  postedOrder?: number;
}): string {
  if (tx.uuid) return tx.uuid;
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
