import { projectOccurrences, runForecast, type ForecastSeriesInput } from "../forecast/engine";
import type { AnomalyKind, CadenceLabel } from "../recurring/detect";
import { formatRand, shortDate } from "../recurring/format";

const DAY_MS = 24 * 60 * 60 * 1000;

export type InsightSeverity = "info" | "warning" | "critical";
export type InsightKind =
  | AnomalyKind
  | "subscription_creep"
  | "upcoming_cluster"
  | "cashflow_risk";

export type InsightSeriesInput = {
  merchantKey: string;
  label: string;
  direction: "debit" | "credit";
  cadence: CadenceLabel;
  typicalAmountCents: number;
  lastAmountCents?: number;
  intervalDays: number;
  predictedNextAt: number;
  confidence: number;
  isPayday: boolean;
  category?: string;
  anomalyKind?: AnomalyKind;
  anomalyDetail?: string;
};

export type ForecastSummary = {
  firstBreachAtMs: number | null;
  minBalanceCents: number;
  minBalanceAtMs: number;
  nextPaydayAtMs: number | null;
};

export type DerivedInsight = {
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  detail: string;
  relatedMerchantKey?: string;
};

export type DeriveInsightsInput = {
  series: InsightSeriesInput[];
  currentBalanceCents: number;
  /** Reference "now"; required so the function stays deterministic in tests. */
  asOfMs: number;
  /** Pre-computed forecast summary; if omitted, a 30-day forecast is run here. */
  forecastSummary?: ForecastSummary;
  horizonDays?: number;
  currencySymbol?: string;
};

/** Tunables (documented in docs/detection-insights.md). */
export const INSIGHTS = {
  horizonDays: 30,
  /** Subscription creep needs at least this many active subscriptions. */
  subscriptionMinCount: 2,
  /** Subscription creep is a warning above this share of monthly payday income. */
  subscriptionWarnShareOfIncome: 0.1,
  /** Upcoming cluster: >= this many debits inside the window. */
  clusterMinDebits: 3,
  clusterWindowDays: 3,
  /** Cashflow risk is critical when the breach is this close (days) or already happened. */
  cashflowCriticalWithinDays: 7,
} as const;

export const SEVERITY_RANK: Record<InsightSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** Convert a series' typical amount into a per-month figure. */
export function monthlyEquivalentCents(series: { cadence: CadenceLabel; typicalAmountCents: number }): number {
  switch (series.cadence) {
    case "monthly":
      return series.typicalAmountCents;
    case "biweekly":
      return Math.round((series.typicalAmountCents * 26) / 12);
    case "weekly":
      return Math.round((series.typicalAmountCents * 52) / 12);
    default:
      return 0; // irregular series are not forecastable
  }
}

function anomalyInsight(s: InsightSeriesInput, sym: string): DerivedInsight | null {
  if (!s.anomalyKind) return null;
  const last = s.lastAmountCents ?? s.typicalAmountCents;
  const usual = formatRand(s.typicalAmountCents, sym);
  switch (s.anomalyKind) {
    case "amount_spike":
      return {
        kind: "amount_spike",
        severity: "warning",
        title: `${s.label} charged ${formatRand(last, sym)} — ${s.anomalyDetail ?? "more than usual"}`,
        detail: `This ${s.category ?? "recurring"} payment is usually around ${usual}. Worth checking the bill if you weren't expecting the increase.`,
        relatedMerchantKey: s.merchantKey,
      };
    case "amount_drop":
      return {
        kind: "amount_drop",
        severity: "info",
        title: `${s.label} charged ${formatRand(last, sym)} — ${s.anomalyDetail ?? "less than usual"}`,
        detail: `Usually around ${usual}. Lower is good news, unless it means part of the bill wasn't collected.`,
        relatedMerchantKey: s.merchantKey,
      };
    case "missed_payment":
      return {
        kind: "missed_payment",
        severity: "warning",
        title: `${s.label} hasn't gone off as expected`,
        detail: `${s.anomalyDetail ?? "Expected but not seen"}. If you cancelled it, great; if not, check that the ${s.category === "other" ? "payment" : s.category} is still in place.`,
        relatedMerchantKey: s.merchantKey,
      };
  }
}

function subscriptionCreep(series: InsightSeriesInput[], sym: string): DerivedInsight | null {
  const subs = series.filter(
    (s) => s.direction === "debit" && s.category === "subscription" && s.cadence !== "irregular",
  );
  if (subs.length < INSIGHTS.subscriptionMinCount) return null;
  const totalMonthly = subs.reduce((sum, s) => sum + monthlyEquivalentCents(s), 0);
  const payday = series.find((s) => s.isPayday);
  const share = payday ? totalMonthly / monthlyEquivalentCents(payday) : null;
  const names = subs
    .slice()
    .sort((a, b) => monthlyEquivalentCents(b) - monthlyEquivalentCents(a))
    .map((s) => s.label)
    .join(", ");
  const sharePhrase = share !== null ? ` — about ${Math.round(share * 100)}% of your detected monthly income` : "";
  return {
    kind: "subscription_creep",
    severity: share !== null && share >= INSIGHTS.subscriptionWarnShareOfIncome ? "warning" : "info",
    title: `You spend ${formatRand(totalMonthly, sym)}/month on ${subs.length} subscriptions`,
    detail: `${names}${sharePhrase}. Cancelling one you don't use is the easiest saving there is.`,
  };
}

function upcomingClusters(
  series: InsightSeriesInput[],
  asOfMs: number,
  horizonDays: number,
  currentBalanceCents: number,
  sym: string,
): DerivedInsight[] {
  const toMs = asOfMs + horizonDays * DAY_MS;
  const events: { dateMs: number; label: string; amountCents: number }[] = [];
  for (const s of series) {
    if (s.direction !== "debit" || s.cadence === "irregular") continue;
    if (s.anomalyKind === "missed_payment") continue; // stopped series aren't upcoming
    for (const dateMs of projectOccurrences(toForecastInput(s), asOfMs, toMs)) {
      events.push({ dateMs, label: s.label, amountCents: s.typicalAmountCents });
    }
  }
  events.sort((a, b) => a.dateMs - b.dateMs);

  const out: DerivedInsight[] = [];
  let i = 0;
  while (i < events.length) {
    const windowEnd = events[i].dateMs + INSIGHTS.clusterWindowDays * DAY_MS;
    let j = i;
    while (j < events.length && events[j].dateMs <= windowEnd) j++;
    const cluster = events.slice(i, j);
    if (cluster.length >= INSIGHTS.clusterMinDebits) {
      const total = cluster.reduce((sum, e) => sum + e.amountCents, 0);
      const first = cluster[0].dateMs;
      const last = cluster[cluster.length - 1].dateMs;
      const when = first === last ? `on ${shortDate(first)}` : `between ${shortDate(first)} and ${shortDate(last)}`;
      out.push({
        kind: "upcoming_cluster",
        severity: total > currentBalanceCents ? "warning" : "info",
        title: `${cluster.length} recurring debits (${formatRand(total, sym)}) expected ${when}`,
        detail: `${cluster.map((e) => e.label).join(", ")}. ${
          total > currentBalanceCents
            ? "That is more than your current available balance, so timing matters."
            : "Make sure the balance can cover them all at once."
        }`,
      });
      i = j; // skip past this cluster
    } else {
      i++;
    }
  }
  return out;
}

function toForecastInput(s: InsightSeriesInput): ForecastSeriesInput {
  return {
    merchantKey: s.merchantKey,
    label: s.label,
    direction: s.direction,
    cadence: s.cadence,
    typicalAmountCents: s.typicalAmountCents,
    intervalDays: s.intervalDays,
    predictedNextAt: s.predictedNextAt,
    confidence: s.confidence,
    isPayday: s.isPayday,
  };
}

function cashflowRisk(
  summary: ForecastSummary,
  asOfMs: number,
  currentBalanceCents: number,
  sym: string,
): DerivedInsight | null {
  if (summary.firstBreachAtMs === null) return null;
  const daysUntil = Math.round((summary.firstBreachAtMs - asOfMs) / DAY_MS);
  const critical = daysUntil <= INSIGHTS.cashflowCriticalWithinDays;
  const paydayPhrase =
    summary.nextPaydayAtMs !== null && summary.nextPaydayAtMs > summary.firstBreachAtMs
      ? ` Your next detected payday (${shortDate(summary.nextPaydayAtMs)}) lands after that.`
      : "";
  return {
    kind: "cashflow_risk",
    severity: critical ? "critical" : "warning",
    title:
      daysUntil <= 0
        ? `Balance is already at or below ${sym}0`
        : `Balance projected to dip below ${sym}0 around ${shortDate(summary.firstBreachAtMs)}`,
    detail: `Starting from ${formatRand(currentBalanceCents, sym)} and applying your detected recurring payments, the lowest projected point is ${formatRand(summary.minBalanceCents, sym)} on ${shortDate(summary.minBalanceAtMs)}.${paydayPhrase} This is an estimate from past patterns, not a guarantee.`,
  };
}

/**
 * Turn detected series (+ a balance) into a short, prioritised list of plain-
 * language insights. Pure and deterministic: no clock, no database.
 */
export function deriveInsights(input: DeriveInsightsInput): DerivedInsight[] {
  const sym = input.currencySymbol ?? "R";
  const horizonDays = input.horizonDays ?? INSIGHTS.horizonDays;
  const insights: DerivedInsight[] = [];

  const summary =
    input.forecastSummary ??
    (() => {
      const f = runForecast({
        currentBalanceCents: input.currentBalanceCents,
        // Stopped series shouldn't keep draining the projection.
        series: input.series.filter((s) => s.anomalyKind !== "missed_payment").map(toForecastInput),
        horizonDays,
        asOfMs: input.asOfMs,
        safetyThresholdCents: 0,
      });
      return {
        firstBreachAtMs: f.firstBreachAtMs,
        minBalanceCents: f.minBalanceCents,
        minBalanceAtMs: f.minBalanceAtMs,
        nextPaydayAtMs: f.nextPaydayAtMs,
      };
    })();

  const risk = cashflowRisk(summary, input.asOfMs, input.currentBalanceCents, sym);
  if (risk) insights.push(risk);

  for (const s of input.series) {
    const a = anomalyInsight(s, sym);
    if (a) insights.push(a);
  }

  const creep = subscriptionCreep(input.series, sym);
  if (creep) insights.push(creep);

  insights.push(...upcomingClusters(input.series, input.asOfMs, horizonDays, input.currentBalanceCents, sym));

  return insights.sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.title.localeCompare(b.title),
  );
}
