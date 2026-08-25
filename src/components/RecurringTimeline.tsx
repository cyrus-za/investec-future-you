import { cadenceLabel, formatDate, formatMoney } from "../lib/format";

type Series = {
  _id: string;
  label: string;
  direction: "debit" | "credit";
  cadence: string;
  typicalAmountCents: number;
  predictedNextAt: number;
  confidence: number;
  isPayday: boolean;
};

export function RecurringTimeline({ series, currency }: { series: Series[]; currency: string }) {
  const forecastable = series
    .filter((s) => s.cadence !== "irregular")
    .sort((a, b) => a.predictedNextAt - b.predictedNextAt);
  const irregular = series.filter((s) => s.cadence === "irregular");

  if (series.length === 0) {
    return (
      <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4 text-sm text-slate-400">
        No recurring payments detected yet. Sync more transaction history for better detection.
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <h3 className="mb-3 text-sm font-semibold text-slate-200">Upcoming recurring payments</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-slate-500">
              <th className="pb-2 pr-4">Merchant</th>
              <th className="pb-2 pr-4">Cadence</th>
              <th className="pb-2 pr-4">Amount</th>
              <th className="pb-2 pr-4">Next predicted</th>
              <th className="pb-2">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {forecastable.map((s) => (
              <tr key={s._id} className="border-t border-slate-800/60">
                <td className="py-2 pr-4">
                  {s.label}
                  {s.isPayday && (
                    <span className="ml-2 rounded bg-emerald-500/20 px-1.5 py-0.5 text-xs text-emerald-300">
                      Payday
                    </span>
                  )}
                </td>
                <td className="py-2 pr-4 text-slate-400">{cadenceLabel(s.cadence)}</td>
                <td
                  className={`py-2 pr-4 font-medium ${
                    s.direction === "credit" ? "text-emerald-400" : "text-slate-200"
                  }`}
                >
                  {s.direction === "credit" ? "+" : "-"}
                  {formatMoney(s.typicalAmountCents, currency)}
                </td>
                <td className="py-2 pr-4 text-slate-400">{formatDate(s.predictedNextAt)}</td>
                <td className="py-2">
                  <ConfidenceBar value={s.confidence} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {irregular.length > 0 && (
        <p className="mt-3 text-xs text-slate-500">
          {irregular.length} other merchant{irregular.length === 1 ? "" : "s"} seen more than once
          but without a consistent enough interval to forecast (e.g. occasional online orders).
        </p>
      )}
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-slate-800">
        <div
          className="h-full rounded-full bg-emerald-500"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-xs text-slate-500">{pct}%</span>
    </div>
  );
}
