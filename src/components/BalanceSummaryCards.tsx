import { formatDateFull, formatMoney } from "../lib/format";

export function BalanceSummaryCards({
  currency,
  startingBalanceCents,
  projectedEndBalanceCents,
  minBalanceCents,
  minBalanceAtMs,
  firstBreachAtMs,
  daysUntilPayday,
}: {
  currency: string;
  startingBalanceCents: number;
  projectedEndBalanceCents: number;
  minBalanceCents: number;
  minBalanceAtMs: number;
  firstBreachAtMs: number | null;
  daysUntilPayday: number | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
      <Card label="Available now" value={formatMoney(startingBalanceCents, currency)} />
      <Card
        label="Projected at end of horizon"
        value={formatMoney(projectedEndBalanceCents, currency)}
        tone={projectedEndBalanceCents < 0 ? "danger" : "default"}
      />
      <Card
        label="Lowest projected balance"
        value={formatMoney(minBalanceCents, currency)}
        sub={formatDateFull(minBalanceAtMs)}
        tone={minBalanceCents < 0 ? "danger" : "default"}
      />
      <Card
        label="Days until payday"
        value={daysUntilPayday === null ? "—" : String(daysUntilPayday)}
        sub={daysUntilPayday === null ? "No payday detected yet" : undefined}
      />
      {firstBreachAtMs !== null && (
        <div className="sm:col-span-2 lg:col-span-4 rounded-lg border border-red-500/40 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          ⚠️ Cashflow risk: projected balance drops to or below your safety threshold by{" "}
          <strong>{formatDateFull(firstBreachAtMs)}</strong>, based on detected recurring
          payments.
        </div>
      )}
    </div>
  );
}

function Card({
  label,
  value,
  sub,
  tone = "default",
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "danger";
}) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <div className="text-xs uppercase tracking-wide text-slate-400">{label}</div>
      <div className={`mt-1 text-2xl font-semibold ${tone === "danger" ? "text-red-400" : "text-slate-50"}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-slate-500">{sub}</div>}
    </div>
  );
}
