import type { CadenceLabel } from "../recurring/detect";

const DAY_MS = 24 * 60 * 60 * 1000;

export type ForecastSeriesInput = {
  merchantKey: string;
  label: string;
  direction: "debit" | "credit";
  cadence: CadenceLabel;
  typicalAmountCents: number; // positive magnitude
  intervalDays: number;
  predictedNextAt: number;
  confidence: number;
  isPayday: boolean;
};

export type ForecastEvent = {
  dateMs: number;
  merchantKey: string;
  label: string;
  direction: "debit" | "credit";
  amountCents: number; // signed
  confidence: number;
  isPayday: boolean;
};

export type DailyBalance = {
  dateMs: number;
  balanceCents: number;
};

export type ForecastResult = {
  dailyBalances: DailyBalance[];
  events: ForecastEvent[];
  startingBalanceCents: number;
  minBalanceCents: number;
  minBalanceAtMs: number;
  /** First date the projected balance is at/below the safety threshold, or null if it never breaches within the horizon. */
  firstBreachAtMs: number | null;
  /** Next predicted payday occurrence within the horizon (or the first one found, even beyond), or null if no payday series exists. */
  nextPaydayAtMs: number | null;
  daysUntilPayday: number | null;
};

/** Project every occurrence of one series between `fromMs` (inclusive) and
 * `toMs` (inclusive), starting from its `predictedNextAt`. Monthly cadence
 * steps by real calendar months (so day-of-month stays aligned); weekly and
 * biweekly cadences step by a fixed number of days. */
export function projectOccurrences(series: ForecastSeriesInput, fromMs: number, toMs: number): number[] {
  if (series.cadence === "irregular") return [];
  const occurrences: number[] = [];
  let cursor = series.predictedNextAt;
  let guard = 0;
  // Walk backwards first in case predictedNextAt is already past `fromMs`
  // by more than one interval (e.g. viewing a forecast long after the last sync).
  while (cursor > fromMs && guard < 1000) {
    cursor = stepBack(series.cadence, cursor);
    guard++;
  }
  guard = 0;
  while (cursor <= toMs && guard < 1000) {
    if (cursor >= fromMs) occurrences.push(cursor);
    cursor = stepForward(series.cadence, cursor);
    guard++;
  }
  return occurrences;
}

function stepForward(cadence: CadenceLabel, ms: number): number {
  if (cadence === "monthly") {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const days = cadence === "weekly" ? 7 : 14;
  return ms + days * DAY_MS;
}

function stepBack(cadence: CadenceLabel, ms: number): number {
  if (cadence === "monthly") {
    const d = new Date(ms);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, d.getUTCDate());
  }
  const days = cadence === "weekly" ? 7 : 14;
  return ms - days * DAY_MS;
}

export type RunForecastInput = {
  currentBalanceCents: number;
  series: ForecastSeriesInput[];
  horizonDays?: number;
  asOfMs?: number;
  safetyThresholdCents?: number;
  /** Optional hypothetical extra transaction (used by the affordability calculator). */
  hypothetical?: { dateMs: number; amountCents: number; label: string };
};

export function runForecast(input: RunForecastInput): ForecastResult {
  const horizonDays = input.horizonDays ?? 30;
  const asOfMs = input.asOfMs ?? Date.now();
  const safetyThresholdCents = input.safetyThresholdCents ?? 0;
  const horizonEndMs = asOfMs + horizonDays * DAY_MS;

  const events: ForecastEvent[] = [];
  let nextPaydayAtMs: number | null = null;
  for (const s of input.series) {
    if (s.cadence === "irregular") continue;
    const occurrences = projectOccurrences(s, asOfMs, horizonEndMs);
    for (const dateMs of occurrences) {
      const signedAmount = s.direction === "debit" ? -s.typicalAmountCents : s.typicalAmountCents;
      events.push({
        dateMs,
        merchantKey: s.merchantKey,
        label: s.label,
        direction: s.direction,
        amountCents: signedAmount,
        confidence: s.confidence,
        isPayday: s.isPayday,
      });
      if (s.isPayday && (nextPaydayAtMs === null || dateMs < nextPaydayAtMs)) {
        nextPaydayAtMs = dateMs;
      }
    }
  }

  if (input.hypothetical) {
    events.push({
      dateMs: input.hypothetical.dateMs,
      merchantKey: "__hypothetical__",
      label: input.hypothetical.label,
      direction: input.hypothetical.amountCents < 0 ? "debit" : "credit",
      amountCents: input.hypothetical.amountCents,
      confidence: 1,
      isPayday: false,
    });
  }

  events.sort((a, b) => a.dateMs - b.dateMs);

  const dailyBalances: DailyBalance[] = [];
  let balance = input.currentBalanceCents;
  let minBalanceCents = balance;
  let minBalanceAtMs = asOfMs;
  let firstBreachAtMs: number | null = balance <= safetyThresholdCents ? asOfMs : null;
  let eventIdx = 0;

  for (let day = 0; day <= horizonDays; day++) {
    const dateMs = asOfMs + day * DAY_MS;
    while (eventIdx < events.length && events[eventIdx].dateMs <= dateMs) {
      balance += events[eventIdx].amountCents;
      eventIdx++;
    }
    dailyBalances.push({ dateMs, balanceCents: balance });
    if (balance < minBalanceCents) {
      minBalanceCents = balance;
      minBalanceAtMs = dateMs;
    }
    if (firstBreachAtMs === null && balance <= safetyThresholdCents) {
      firstBreachAtMs = dateMs;
    }
  }

  return {
    dailyBalances,
    events,
    startingBalanceCents: input.currentBalanceCents,
    minBalanceCents,
    minBalanceAtMs,
    firstBreachAtMs,
    nextPaydayAtMs,
    daysUntilPayday:
      nextPaydayAtMs === null ? null : Math.round((nextPaydayAtMs - asOfMs) / DAY_MS),
  };
}
