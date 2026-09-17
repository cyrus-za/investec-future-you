/** Deterministic, dependency-free formatters for server-side insight text. */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "15 Jul" (UTC) — matches the frontend's short date style closely enough for copy. */
export function shortDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}

/** Whole-rand amount with thousands separators, e.g. 124_700 → "R1,247". */
export function formatRand(cents: number, symbol = "R"): string {
  const rand = Math.round(Math.abs(cents) / 100);
  const grouped = String(rand).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${cents < 0 ? "-" : ""}${symbol}${grouped}`;
}

/** Signed percentage string, e.g. 0.452 → "+45%". */
export function formatPct(ratio: number): string {
  const pct = Math.round(ratio * 100);
  return `${pct >= 0 ? "+" : ""}${pct}%`;
}
