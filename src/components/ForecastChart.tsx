import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDate, formatMoney } from "../lib/format";

type DailyBalance = { dateMs: number; balanceCents: number };

export function ForecastChart({
  dailyBalances,
  currency,
  safetyThresholdCents,
}: {
  dailyBalances: DailyBalance[];
  currency: string;
  safetyThresholdCents: number;
}) {
  const data = dailyBalances.map((d) => ({
    date: d.dateMs,
    balance: d.balanceCents / 100,
  }));

  return (
    <div className="h-72 w-full rounded-lg border border-slate-800 bg-slate-900/60 p-4">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke="#1e293b" strokeDasharray="3 3" />
          <XAxis
            dataKey="date"
            tickFormatter={(v) => formatDate(v)}
            stroke="#64748b"
            fontSize={12}
            minTickGap={24}
          />
          <YAxis
            stroke="#64748b"
            fontSize={12}
            tickFormatter={(v) => formatMoney(v * 100, currency)}
            width={90}
          />
          <Tooltip
            contentStyle={{ background: "#0f172a", border: "1px solid #1e293b", borderRadius: 8 }}
            labelFormatter={(v) => formatDate(Number(v))}
            formatter={(value) => [formatMoney(Number(value) * 100, currency), "Projected balance"]}
          />
          <ReferenceLine y={safetyThresholdCents / 100} stroke="#f87171" strokeDasharray="4 4" />
          <Line type="stepAfter" dataKey="balance" stroke="#34d399" strokeWidth={2} dot={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
