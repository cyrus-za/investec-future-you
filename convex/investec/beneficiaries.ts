/**
 * Best-effort payee-name enrichment for `OnlineBankingPayments`.
 *
 * Investec only exposes YOUR OWN `myReference` in the statement description
 * of an EFT you made — not who you paid. The saved-beneficiaries endpoint
 * fills that gap: `referenceName` is the default reference pre-filled when
 * paying a saved beneficiary, so an exact (case-insensitive) match lets us
 * label the payment with the beneficiary's name instead of a bare reference.
 *
 * Ported from household-budget's worker/src/investec/sync.ts and kept
 * deliberately conservative: when several beneficiaries share a reference we
 * try to tiebreak on lastPaymentAmount + lastPaymentDate, and otherwise leave
 * the description alone rather than guess.
 *
 * Sandbox reality check (docs/investec-api.md): most sandbox beneficiaries
 * have `referenceName: null` and none match a sandbox transaction, so this is
 * a no-op there. It is wired for production, where it does apply.
 */

import type { InvestecBeneficiary } from "./client";
import { normaliseDescription } from "./mapping";

export type BeneficiaryCandidate = {
  name: string;
  lastPaymentAmount: string | null;
  lastPaymentDate: string | null;
};

/** normalised referenceName -> candidates sharing that reference. */
export type BeneficiaryIndex = Map<string, BeneficiaryCandidate[]>;

function normaliseRef(s: string): string {
  return normaliseDescription(s).toUpperCase();
}

export function buildBeneficiaryIndex(beneficiaries: InvestecBeneficiary[]): BeneficiaryIndex {
  const index: BeneficiaryIndex = new Map();
  for (const b of beneficiaries) {
    const key = b.referenceName ? normaliseRef(b.referenceName) : "";
    if (!key) continue;
    const displayName = (b.name || b.beneficiaryName || "").trim();
    if (!displayName) continue;
    const existing = index.get(key) ?? [];
    existing.push({
      name: displayName,
      lastPaymentAmount: b.lastPaymentAmount ?? null,
      lastPaymentDate: b.lastPaymentDate ?? null,
    });
    index.set(key, existing);
  }
  return index;
}

/** Investec formats amounts as "10,000.00" — strip separators before comparing. */
export function parseBeneficiaryAmount(s: string | null): number | null {
  if (!s) return null;
  const n = Number(s.replace(/[,\s]/gu, ""));
  return Number.isFinite(n) ? n : null;
}

/** "dd/MM/yyyy" (or "d/M/yyyy") -> "yyyy-MM-dd"; anything else -> null. */
export function beneficiaryDateToIso(s: string | null): string | null {
  if (!s) return null;
  const parts = s.trim().split("/");
  if (parts.length !== 3) return null;
  const [day, month, year] = parts;
  if (!/^\d{4}$/u.test(year) || !/^\d{1,2}$/u.test(month) || !/^\d{1,2}$/u.test(day)) return null;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Resolve the payee name for an OnlineBankingPayments transaction.
 * Returns null whenever the match is not unambiguous.
 */
export function resolveBeneficiaryName(
  transactionType: string | null | undefined,
  description: string,
  amount: number,
  isoDate: string | null | undefined,
  index: BeneficiaryIndex | undefined,
): string | null {
  if (transactionType !== "OnlineBankingPayments" || !index) return null;
  const candidates = index.get(normaliseRef(description));
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0].name;

  if (isoDate) {
    const tieMatches = candidates.filter((c) => {
      const amt = parseBeneficiaryAmount(c.lastPaymentAmount);
      const date = beneficiaryDateToIso(c.lastPaymentDate);
      return amt !== null && date !== null && amt.toFixed(2) === amount.toFixed(2) && date === isoDate;
    });
    if (tieMatches.length === 1) return tieMatches[0].name;
  }
  return null;
}
