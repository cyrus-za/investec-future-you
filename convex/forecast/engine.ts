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
  /** 0 = perfectly fixed amount, higher = more variable. Used for the pessimistic band. */
  amountVariance?: number;
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

export type ForecastBands = {
  /** All detected series at their typical amounts. Identical to `dailyBalances`. */
  expected: DailyBalance[];
  /** Only high-confidence series (confidence >= 0.6) — the "if only the bills we're sure about hit" case. */
  optimistic: DailyBalance[];
  /** Every series at typicalAmountCents * (1 + amountVariance) — the "if variable bills come in high" case. */
  pessimistic: DailyBalance[];
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
  /** How much extra you could spend today without the expected projection
   * dropping below the safety threshold before the next payday (or horizon
   * end if no payday is detected). Estimate only — never a guarantee. */
  safeToSpendCents: number;
  /** Days from asOfMs until the expected projection first breaches the
   * safety threshold, or null if it never does within the horizon. */
  runwayDays: number | null;
  bands: ForecastBands;
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

/** Project every occurrence of every series into a sorted event list.
 * `debitMultiplier` scales debit magnitudes only (pessimistic band) —
 * income is never scaled up, so the pessimistic band stays conservative.
 * `minConfidence` filters out low-confidence series (optimistic band). */
function buildEvents(
  series: ForecastSeriesInput[],
  asOfMs: number,
  horizonEndMs: number,
  opts?: { minConfidence?: number; debitMultiplier?: (s: ForecastSeriesInput) => number },
): { events: ForecastEvent[]; nextPaydayAtMs: number | null } {
  const events: ForecastEvent[] = [];
  let nextPaydayAtMs: number | null = null;
  for (const s of series) {
    if (s.cadence === "irregular") continue;
    if (opts?.minConfidence !== undefined && s.confidence < opts.minConfidence) continue;
    const multiplier = s.direction === "debit" && opts?.debitMultiplier ? opts.debitMultiplier(s) : 1;
    const occurrences = projectOccurrences(s, asOfMs, horizonEndMs);
    for (const dateMs of occurrences) {
      const signedAmount = s.direction === "debit" ? -s.typicalAmountCents : s.typicalAmountCents;
      events.push({
        dateMs,
        merchantKey: s.merchantKey,
        label: s.label,
        direction: s.direction,
        amountCents: Math.round(signedAmount * multiplier),
        confidence: s.confidence,
        isPayday: s.isPayday,
      });
      if (s.isPayday && (nextPaydayAtMs === null || dateMs < nextPaydayAtMs)) {
        nextPaydayAtMs = dateMs;
      }
    }
  }
  return { events, nextPaydayAtMs };
}

/** Walk a sorted event list day-by-day and produce the running balance series. */
function computeDailyBalances(
  startingBalanceCents: number,
  events: ForecastEvent[],
  asOfMs: number,
  horizonDays: number,
): DailyBalance[] {
  const dailyBalances: DailyBalance[] = [];
  let balance = startingBalanceCents;
  let eventIdx = 0;
  for (let day = 0; day <= horizonDays; day++) {
    const dateMs = asOfMs + day * DAY_MS;
    while (eventIdx < events.length && events[eventIdx].dateMs <= dateMs) {
      balance += events[eventIdx].amountCents;
      eventIdx++;
    }
    dailyBalances.push({ dateMs, balanceCents: balance });
  }
  return dailyBalances;
}

export function runForecast(input: RunForecastInput): ForecastResult {
  const horizonDays = input.horizonDays ?? 30;
  const asOfMs = input.asOfMs ?? Date.now();
  const safetyThresholdCents = input.safetyThresholdCents ?? 0;
  const horizonEndMs = asOfMs + horizonDays * DAY_MS;

  const { events, nextPaydayAtMs } = buildEvents(input.series, asOfMs, horizonEndMs);

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

  const dailyBalances = computeDailyBalances(input.currentBalanceCents, events, asOfMs, horizonDays);

  let minBalanceCents = input.currentBalanceCents;
  let minBalanceAtMs = asOfMs;
  let firstBreachAtMs: number | null = null;
  for (const day of dailyBalances) {
    if (day.balanceCents < minBalanceCents) {
      minBalanceCents = day.balanceCents;
      minBalanceAtMs = day.dateMs;
    }
    if (firstBreachAtMs === null && day.balanceCents <= safetyThresholdCents) {
      firstBreachAtMs = day.dateMs;
    }
  }

  // Bands: expected = the main series; optimistic = only high-confidence
  // series; pessimistic = every series scaled up by its amount variance.
  // The hypothetical (if any) applies to all three bands.
  const hypotheticalEvents = input.hypothetical
    ? events.filter((e) => e.merchantKey === "__hypothetical__")
    : [];
  const optimistic = buildEvents(input.series, asOfMs, horizonEndMs, { minConfidence: 0.6 });
  optimistic.events.push(...hypotheticalEvents);
  optimistic.events.sort((a, b) => a.dateMs - b.dateMs);
  const pessimistic = buildEvents(input.series, asOfMs, horizonEndMs, {
    debitMultiplier: (s) => 1 + (s.amountVariance ?? 0),
  });
  pessimistic.events.push(...hypotheticalEvents);
  pessimistic.events.sort((a, b) => a.dateMs - b.dateMs);

  const bands: ForecastBands = {
    expected: dailyBalances,
    optimistic: computeDailyBalances(input.currentBalanceCents, optimistic.events, asOfMs, horizonDays),
    pessimistic: computeDailyBalances(input.currentBalanceCents, pessimistic.events, asOfMs, horizonDays),
  };

  // Safe-to-spend: lowest expected balance before the next payday (or
  // horizon end if no payday), minus the safety threshold, floored at 0.
  // The payday day itself is included (salary has landed by end of day).
  const safeToSpendCutoffMs = nextPaydayAtMs ?? horizonEndMs;
  let minBeforePayday = input.currentBalanceCents;
  for (const day of dailyBalances) {
    if (day.dateMs > safeToSpendCutoffMs) break;
    if (day.balanceCents < minBeforePayday) minBeforePayday = day.balanceCents;
  }
  const safeToSpendCents = Math.max(0, minBeforePayday - safetyThresholdCents);

  const runwayDays = firstBreachAtMs === null ? null : Math.round((firstBreachAtMs - asOfMs) / DAY_MS);

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
    safeToSpendCents,
    runwayDays,
    bands,
  };
}
