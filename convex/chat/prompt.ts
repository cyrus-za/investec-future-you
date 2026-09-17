/**
 * Pure helpers for the "Chat with Future You" coach: the system prompt, the
 * deterministic ACCOUNT CONTEXT block, and small formatters. No Convex
 * imports so everything here is trivially unit-testable.
 *
 * Design principle: the model never sees raw transactions. It only sees
 * structured summaries produced by the deterministic forecast engine
 * (account name, balances, recurring items, projections) plus whatever the
 * tools in ./tools.ts return.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Format integer cents as "R12,500.00" / "-R1,234.56" (ZAR) or "USD 12.00". */
export function formatMoney(cents: number, currency = "ZAR"): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(Math.round(cents));
  const rand = Math.floor(abs / 100);
  const cent = String(abs % 100).padStart(2, "0");
  const grouped = rand.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const prefix = currency === "ZAR" ? "R" : `${currency} `;
  return `${sign}${prefix}${grouped}.${cent}`;
}

/** "Fri 25 Sep 2026" in UTC (the forecast engine steps days in UTC). */
export function formatDay(ms: number): string {
  const d = new Date(ms);
  return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "YYYY-MM-DD" in UTC. */
export function toIsoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Parse a "YYYY-MM-DD" date into UTC ms. Dates before `todayMs` are clamped
 * to today (you can't buy something in the past). Returns null if unparseable.
 */
export function parseIsoDay(value: unknown, todayMs: number): number | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(ms)) return null;
  const todayStart = Date.UTC(
    new Date(todayMs).getUTCFullYear(),
    new Date(todayMs).getUTCMonth(),
    new Date(todayMs).getUTCDate(),
  );
  return ms < todayStart ? todayMs : ms;
}

export function formatPercent(fraction: number): string {
  return `${Math.round(fraction * 100)}%`;
}

export function cadenceWord(cadence: string): string {
  switch (cadence) {
    case "weekly":
      return "weekly";
    case "biweekly":
      return "every 2 weeks";
    case "monthly":
      return "monthly";
    default:
      return "irregular";
  }
}

/** Approximate monthly cost of a recurring series, or null for irregular ones. */
export function monthlyEquivalentCents(cadence: string, typicalAmountCents: number): number | null {
  switch (cadence) {
    case "weekly":
      return Math.round((typicalAmountCents * 52) / 12);
    case "biweekly":
      return Math.round((typicalAmountCents * 26) / 12);
    case "monthly":
      return typicalAmountCents;
    default:
      return null;
  }
}

export const SYSTEM_PROMPT = `You are "Future You", the cashflow coach inside a personal-finance dashboard built on the user's own Investec transaction history. Context: South Africa. Currency is ZAR, written like R1,250.00. People get paid on "payday" and pay bills by "debit order".

WHAT YOU MAY USE
- The ACCOUNT CONTEXT block below (computed by the app's deterministic, rules-based forecast engine — not by AI).
- Results returned by your tools, which call that same engine.
Every number, date and merchant you mention MUST come from one of those two places. Never estimate, extrapolate, round beyond what is shown, or invent a figure. If the data cannot answer the question, say so plainly and say what would be needed.

WHEN TO CALL TOOLS
- "Will I make it to payday?", "what does my month look like?" -> get_forecast
- "Can I afford X?" / any hypothetical purchase -> check_affordability (convert the amount to rand; if the user gives only a day of the month, use the next occurrence of that day on or after today)
- Subscriptions, debit orders, biggest costs, income -> list_recurring (or the context block if it already answers it)
- "What if I cancel X?" -> simulate_cancellation
- Alerts, anomalies, missed payments -> list_insights
Simple factual questions already answered by the context block need no tool call.

HOW TO ANSWER
- Everything about the future is a projection. Say "projected", "estimated", "likely", "based on detected patterns". Never say "will", "guaranteed" or "safe".
- Quote the figures behind each claim (amount, date, confidence where available).
- No personalised financial advice: do not tell the user to buy, sell, invest, borrow, or which product to choose. Describe what the projection shows and let them decide.
- Format: one-line answer first, then 2-5 short bullets ("- "), then exactly one line starting with "Next step:" naming a concrete, small action the user can take in the app or with their bank.
- If the reply contains a projection, end with the single line: "Estimate based on detected patterns in your synced Investec data — not financial advice."
- Keep it under ~150 words. Plain text only (no headings, no tables, no markdown links). You may use **bold** for the key figure.
- Do not mention tool names, JSON, or implementation details; say "the forecast" or "your recurring payments".
- If asked something unrelated to this account's money, politely steer back to what you can help with.
- Do not repeat back the whole context; answer the question.`;

// ---------------------------------------------------------------------------
// Account context block
// ---------------------------------------------------------------------------

export type ContextForecast = {
  accountName: string;
  currency: string;
  balanceAsOf: number | null;
  startingBalanceCents: number;
  minBalanceCents: number;
  minBalanceAtMs: number;
  firstBreachAtMs: number | null;
  nextPaydayAtMs: number | null;
  daysUntilPayday: number | null;
  dailyBalances: { dateMs: number; balanceCents: number }[];
};

export type ContextSeries = {
  label: string;
  direction: "debit" | "credit";
  cadence: string;
  typicalAmountCents: number;
  predictedNextAt: number;
  confidence: number;
  isPayday: boolean;
  category?: string;
  anomalyKind?: string;
  anomalyDetail?: string;
};

export const CONTEXT_TOP_N = 8;

/**
 * Compact, deterministic summary injected into every conversation so that
 * simple questions ("when is payday?", "what's my rent?") need no tool call.
 */
export function buildContextBlock(input: {
  nowMs: number;
  forecast: ContextForecast | null;
  series: ContextSeries[];
  safetyThresholdCents?: number;
}): string {
  const { nowMs, forecast, series } = input;
  const threshold = input.safetyThresholdCents ?? 0;
  const lines: string[] = [];
  lines.push(`ACCOUNT CONTEXT (deterministic; computed ${formatDay(nowMs)} UTC)`);
  lines.push(`- Today: ${formatDay(nowMs)} (${toIsoDay(nowMs)})`);

  if (!forecast) {
    lines.push("- No account data is available yet (nothing synced). Tell the user to sync their Investec account first.");
    return lines.join("\n");
  }

  const cur = forecast.currency;
  const money = (c: number) => formatMoney(c, cur);
  const endBalance =
    forecast.dailyBalances[forecast.dailyBalances.length - 1]?.balanceCents ?? forecast.startingBalanceCents;
  const horizonDays = Math.max(0, forecast.dailyBalances.length - 1);

  lines.push(`- Account: ${forecast.accountName} (${cur})`);
  lines.push(
    `- Balance the forecast starts from: ${money(forecast.startingBalanceCents)}` +
      (forecast.balanceAsOf ? ` (as of ${formatDay(forecast.balanceAsOf)})` : ""),
  );

  const payday = series.find((s) => s.isPayday);
  if (forecast.nextPaydayAtMs !== null && forecast.daysUntilPayday !== null) {
    lines.push(
      `- Next projected payday: ${formatDay(forecast.nextPaydayAtMs)} (in ${forecast.daysUntilPayday} day${
        forecast.daysUntilPayday === 1 ? "" : "s"
      })` + (payday ? `, typically ${money(payday.typicalAmountCents)} from ${payday.label}` : ""),
    );
  } else {
    lines.push("- Next payday: not detected (no regular monthly income found in the synced history)");
  }

  lines.push(
    `- ${horizonDays}-day projection: lowest ${money(forecast.minBalanceCents)} on ${formatDay(
      forecast.minBalanceAtMs,
    )}; ends at ${money(endBalance)}; first dip to/below ${money(threshold)}: ${
      forecast.firstBreachAtMs === null ? "none within the horizon" : formatDay(forecast.firstBreachAtMs)
    }`,
  );

  const forecastable = series.filter((s) => s.cadence !== "irregular");
  const irregularCount = series.length - forecastable.length;
  const top = forecastable
    .slice()
    .sort((a, b) => b.typicalAmountCents - a.typicalAmountCents)
    .slice(0, CONTEXT_TOP_N);

  if (top.length === 0) {
    lines.push("- Recurring items: none detected yet (a merchant must appear 2+ times with a steady interval)");
  } else {
    lines.push(`- Top ${top.length} recurring items by typical amount (of ${forecastable.length} forecastable):`);
    top.forEach((s, i) => {
      const sign = s.direction === "credit" ? "+" : "-";
      const extras: string[] = [];
      if (s.isPayday) extras.push("PAYDAY");
      if (s.category) extras.push(s.category);
      if (s.anomalyKind) extras.push(`anomaly: ${s.anomalyKind}${s.anomalyDetail ? ` (${s.anomalyDetail})` : ""}`);
      lines.push(
        `  ${i + 1}. ${s.label}: ${sign}${money(s.typicalAmountCents)} ${cadenceWord(s.cadence)}, next ${formatDay(
          s.predictedNextAt,
        )}, confidence ${formatPercent(s.confidence)}` + (extras.length ? ` [${extras.join("; ")}]` : ""),
      );
    });
  }
  if (irregularCount > 0) {
    lines.push(
      `- ${irregularCount} other merchant${irregularCount === 1 ? "" : "s"} recur without a steady interval and are NOT in the forecast.`,
    );
  }
  lines.push(
    "- Assumptions: recurring items repeat exactly as detected; one-off spending, pending card holds and interest are not modelled; confidence is a heuristic, not a probability.",
  );
  return lines.join("\n");
}

export { DAY_MS };
