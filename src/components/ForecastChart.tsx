import { TrendingUp } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatDate, formatDateFull, formatMoney } from "../lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";

type DailyBalance = { dateMs: number; balanceCents: number };

function ChartTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: { value?: number }[];
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0] as unknown as { value: number; payload: { date: number } };
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="text-muted-foreground">{formatDateFull(point.payload.date)}</div>
      <div className="mt-0.5 font-semibold text-foreground">
        {formatMoney(point.value * 100, currency)}
      </div>
    </div>
  );
}

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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="size-4 text-primary" />
          Projected balance
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="h-72 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <defs>
                <linearGradient id="balanceFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="var(--primary)" stopOpacity={0.35} />
                  <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(v) => formatDate(v)}
                stroke="var(--muted-foreground)"
                fontSize={12}
                minTickGap={28}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                stroke="var(--muted-foreground)"
                fontSize={12}
                tickFormatter={(v) => formatMoney(v * 100, currency)}
                width={84}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<ChartTooltip currency={currency} />} />
              <ReferenceLine
                y={safetyThresholdCents / 100}
                stroke="var(--destructive)"
                strokeDasharray="4 4"
              />
              <Area
                type="monotone"
                dataKey="balance"
                stroke="var(--primary)"
                strokeWidth={2}
                fill="url(#balanceFill)"
                dot={false}
                animationDuration={600}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </CardContent>
    </Card>
  );
}
