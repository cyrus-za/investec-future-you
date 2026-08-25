import { useQuery } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { formatDateFull, formatMoney } from "../lib/format";

export function AffordabilityCalculator({
  accountId,
  currency,
  safetyThresholdCents,
}: {
  accountId: Id<"accounts">;
  currency: string;
  safetyThresholdCents: number;
}) {
  const [amountRand, setAmountRand] = useState("500");
  const [dateStr, setDateStr] = useState(() => new Date().toISOString().slice(0, 10));
  const [label, setLabel] = useState("New purchase");
  const [submitted, setSubmitted] = useState<{ amountCents: number; dateMs: number; label: string } | null>(
    null,
  );

  const result = useQuery(
    api.forecast.queries.checkAffordability,
    submitted
      ? {
          accountId,
          amountCents: submitted.amountCents,
          dateMs: submitted.dateMs,
          label: submitted.label,
          safetyThresholdCents,
        }
      : "skip",
  );

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const rand = Number(amountRand);
    if (!Number.isFinite(rand) || rand <= 0) return;
    setSubmitted({
      amountCents: Math.round(rand * 100),
      dateMs: new Date(dateStr).getTime(),
      label: label.trim() || "New purchase",
    });
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">Can I afford this?</h3>
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col">
          <label className="text-xs text-slate-400">What</label>
          <input
            className="w-40 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="New TV"
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-slate-400">Amount ({currency})</label>
          <input
            className="w-32 rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            type="number"
            min="0"
            step="0.01"
            value={amountRand}
            onChange={(e) => setAmountRand(e.target.value)}
          />
        </div>
        <div className="flex flex-col">
          <label className="text-xs text-slate-400">When</label>
          <input
            className="rounded-md border border-slate-700 bg-slate-950 px-2 py-1.5 text-sm text-slate-100"
            type="date"
            value={dateStr}
            onChange={(e) => setDateStr(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500"
        >
          Check
        </button>
      </form>

      {submitted && result === undefined && (
        <p className="mt-3 text-sm text-slate-500">Calculating…</p>
      )}

      {submitted && result && (
        <div
          className={`mt-4 rounded-md border px-4 py-3 text-sm ${
            result.canAfford
              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
              : "border-red-500/40 bg-red-500/10 text-red-200"
          }`}
        >
          <p className="font-medium">
            {result.canAfford
              ? `Yes — "${submitted.label}" looks affordable.`
              : `Risky — "${submitted.label}" would likely cause a shortfall.`}
          </p>
          <p className="mt-1 text-xs opacity-80">
            Projected lowest balance after this purchase:{" "}
            {formatMoney(result.projectedMinBalanceCents, result.currency)} around{" "}
            {formatDateFull(result.projectedMinBalanceAtMs)}.
            {result.daysUntilPayday !== null &&
              ` Next payday in ${result.daysUntilPayday} day${result.daysUntilPayday === 1 ? "" : "s"}.`}
          </p>
        </div>
      )}
    </div>
  );
}
