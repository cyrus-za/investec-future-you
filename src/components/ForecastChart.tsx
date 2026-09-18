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

export type ForecastBands = {
  expected: DailyBalance[];
  optimistic: DailyBalance[];
  pessimistic: DailyBalance[];
};

type ChartPoint = {
  date: number;
  balance: number;
  /** Pessimistic value — invisible spacer that the band range stacks on. */
  bandLow?: number;
  /** optimistic - pessimistic — rendered as a translucent band. */
  bandRange?: number;
  optimistic?: number;
  pessimistic?: number;
};

function ChartTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: { payload?: ChartPoint }[];
  currency: string;
}) {
  if (!active || !payload?.length) return null;
  const point = payload[0].payload;
  if (!point) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="text-muted-foreground">{formatDateFull(point.date)}</div>
      <div className="mt-0.5 font-semibold text-foreground">
        {formatMoney(point.balance * 100, currency)}
        <span className="ml-1 font-normal text-muted-foreground">expected</span>
      </div>
      {point.optimistic !== undefined && point.pessimistic !== undefined && (
        <div className="mt-0.5 text-muted-foreground">
          {formatMoney(point.pessimistic * 100, currency)} –{" "}
          {formatMoney(point.optimistic * 100, currency)} range
        </div>
      )}
    </div>
  );
}

export function ForecastChart({
  dailyBalances,
  bands,
  currency,
  safetyThresholdCents,
}: {
  dailyBalances: DailyBalance[];
  /** Optional optimistic/pessimistic envelope around the expected line. */
  bands?: ForecastBands;
  currency: string;
  safetyThresholdCents: number;
}) {
  const data: ChartPoint[] = dailyBalances.map((d, i) => {
    const opt = bands?.optimistic[i]?.balanceCents;
    const pess = bands?.pessimistic[i]?.balanceCents;
    return {
      date: d.dateMs,
      balance: d.balanceCents / 100,
      ...(opt !== undefined && pess !== undefined
        ? {
            bandLow: pess / 100,
            bandRange: (opt - pess) / 100,
            optimistic: opt / 100,
            pessimistic: pess / 100,
          }
        : {}),
    };
  });

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
              {bands && (
                <Area
                  type="monotone"
                  dataKey="bandLow"
                  stackId="band"
                  stroke="none"
                  fill="none"
                  dot={false}
                  isAnimationActive={false}
                />
              )}
              {bands && (
                <Area
                  type="monotone"
                  dataKey="bandRange"
                  stackId="band"
                  stroke="none"
                  fill="var(--primary)"
                  fillOpacity={0.12}
                  dot={false}
                  animationDuration={600}
                />
              )}
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
        {bands && (
          <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-0.5 w-4 rounded bg-primary" /> Expected — all detected payments at
              typical amounts
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2.5 w-4 rounded-sm bg-primary/15" /> Range — only high-confidence
              payments (top) vs. variable bills coming in high (bottom)
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
