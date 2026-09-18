import { useMutation, useQuery } from "convex/react";
import { PieChart, RefreshCw, ShoppingBag } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { formatMoney } from "../lib/format";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Skeleton } from "./ui/skeleton";

type MonthsOption = 3 | 6;
const MONTH_OPTIONS: MonthsOption[] = [3, 6];
/** Bars beyond this many categories are folded into a single "Everything else". */
const MAX_BARS = 7;
const BAR_COLOURS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
];
const REST_COLOUR = "var(--muted-foreground)";

type ChartRow = { label: string; rand: number; share: number; colour: string };

function ChartTooltip({
  active,
  payload,
  currency,
}: {
  active?: boolean;
  payload?: { payload?: ChartRow }[];
  currency: string;
}) {
  const row = payload?.[0]?.payload;
  if (!active || !row) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
      <div className="text-muted-foreground">{row.label}</div>
      <div className="mt-0.5 font-semibold text-foreground">
        {formatMoney(row.rand * 100, currency)} / month
      </div>
      <div className="text-muted-foreground">{Math.round(row.share * 100)}% of spend</div>
    </div>
  );
}

export function SpendingBreakdown({
  accountId,
  currency,
}: {
  accountId: Id<"accounts">;
  currency: string;
}) {
  const [months, setMonths] = useState<MonthsOption>(3);
  // Captured once so the query args stay stable across renders. Only used
  // server-side to decide which month is still in progress.
  const [nowMs] = useState(() => Date.now());
  const summary = useQuery(api.categorisation.summary, { accountId, months, nowMs });
  const recompute = useMutation(api.categorisation.recompute);
  const [recomputing, setRecomputing] = useState(false);
  const [autoFailed, setAutoFailed] = useState(false);
  const autoTriggeredFor = useRef<Id<"accounts"> | null>(null);

  // First visit after a sync: transactions exist but have no category yet.
  // Run the (idempotent) categoriser once per account, then the reactive
  // query refreshes on its own.
  useEffect(() => {
    if (!summary || summary.uncategorisedCount === 0) return;
    if (autoTriggeredFor.current === accountId) return;
    autoTriggeredFor.current = accountId;
    setAutoFailed(false);
    setRecomputing(true);
    recompute({ accountId })
      .catch(() => setAutoFailed(true))
      .finally(() => setRecomputing(false));
  }, [summary, accountId, recompute]);

  async function handleRecategorise() {
    setRecomputing(true);
    try {
      await recompute({ accountId });
    } finally {
      setRecomputing(false);
    }
  }

  const monthSelector = (
    <div className="flex items-center gap-1 rounded-lg bg-muted/60 p-0.5">
      {MONTH_OPTIONS.map((m) => (
        <Button
          key={m}
          type="button"
          size="xs"
          variant={months === m ? "secondary" : "ghost"}
          className={months === m ? "bg-background shadow-sm" : "text-muted-foreground"}
          onClick={() => setMonths(m)}
          aria-pressed={months === m}
        >
          {m} months
        </Button>
      ))}
    </div>
  );

  const header = (
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle className="flex items-center gap-2">
          <PieChart className="size-4 text-primary" />
          Where your money goes
        </CardTitle>
        {monthSelector}
      </div>
    </CardHeader>
  );

  // Skeleton while loading, and while uncategorised rows are about to be / are
  // being categorised (unless that attempt failed — then show what we have).
  const isBusy =
    summary === undefined ||
    (summary !== null && summary.uncategorisedCount > 0 && !autoFailed);

  if (isBusy) {
    return (
      <Card>
        {header}
        <CardContent className="space-y-4">
          <Skeleton className="h-52 rounded-lg" />
          <Skeleton className="h-3 rounded-full" />
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-6 rounded-md" />
            ))}
          </div>
          <p className="text-xs text-muted-foreground">
            {summary === undefined ? "Loading spending summary…" : "Categorising transactions…"}
          </p>
        </CardContent>
      </Card>
    );
  }

  if (summary === null || summary.transactionCount === 0 || summary.spendCents === 0) {
    return (
      <Card>
        {header}
        <CardContent>
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <ShoppingBag className="size-4" />
            {summary === null
              ? "No transactions yet for this account. Sync from Investec (or seed the demo account) to see a spending breakdown."
              : `No spending found in the last ${months} months of transaction history.`}
          </p>
        </CardContent>
      </Card>
    );
  }

  // --- Chart data: top categories + "Everything else" ---------------------
  const sorted = summary.averageMonthlyByCategory;
  const head = sorted.slice(0, MAX_BARS);
  const tail = sorted.slice(MAX_BARS);
  const rows: ChartRow[] = head.map((c, i) => ({
    label: c.label,
    rand: c.cents / 100,
    share: c.share,
    colour: i < BAR_COLOURS.length ? BAR_COLOURS[i] : REST_COLOUR,
  }));
  if (tail.length > 0) {
    rows.push({
      label: `Everything else (${tail.length})`,
      rand: tail.reduce((a, c) => a + c.cents, 0) / 100,
      share: tail.reduce((a, c) => a + c.share, 0),
      colour: REST_COLOUR,
    });
  }
  const chartHeight = Math.max(120, rows.length * 34 + 16);

  // --- Fixed vs variable ---------------------------------------------------
  const fixedPct = Math.round(summary.fixedShare * 100);
  const variablePct = 100 - fixedPct;
  const averagingLabels = summary.perMonth
    .filter((m) => summary.averagingMonths.includes(m.month))
    .map((m) => m.label);
  const partialLabel = summary.perMonth.find((m) => m.month === summary.partialMonth)?.label;
  const otherShare = summary.averageMonthlyByCategory.find((c) => c.category === "other")?.share ?? 0;

  const notes: string[] = [
    "Categories come from transparent keyword rules (no AI) and can be wrong for unfamiliar merchants.",
  ];
  if (otherShare > 0) {
    notes.push(`${Math.max(1, Math.round(otherShare * 100))}% of spend didn't match any rule and is shown as "Other".`);
  }
  if (averagingLabels.length === 1) {
    notes.push(`Averages use ${averagingLabels[0]} only.`);
  } else if (averagingLabels.length > 1) {
    notes.push(
      `Averages use ${averagingLabels[0]}–${averagingLabels[averagingLabels.length - 1]} (${averagingLabels.length} complete months).`,
    );
  }
  if (partialLabel && !summary.averagingMonths.includes(summary.partialMonth ?? "")) {
    notes.push(`${partialLabel} is still in progress and excluded from the averages.`);
  }
  if (autoFailed) notes.push("Automatic categorisation failed — try \u201cRecategorise\u201d.");

  return (
    <Card>
      {header}
      <CardContent className="space-y-6">
        {/* (a) Average monthly spend by category */}
        <section>
          <div className="mb-1 flex items-baseline justify-between gap-3">
            <h3 className="text-sm font-medium text-foreground">Average monthly spend by category</h3>
            <span className="text-xs text-muted-foreground">
              {formatMoney(summary.averageMonthlySpendCents, currency)} / month total
            </span>
          </div>
          <div style={{ height: chartHeight }} className="w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 12, bottom: 0, left: 0 }} barCategoryGap={6}>
                <XAxis
                  type="number"
                  hide
                  domain={[0, (max: number) => max * 1.05]}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  width={168}
                  tickLine={false}
                  axisLine={false}
                  stroke="var(--muted-foreground)"
                  fontSize={12}
                  interval={0}
                />
                <Tooltip cursor={{ fill: "var(--muted)", opacity: 0.4 }} content={<ChartTooltip currency={currency} />} />
                <Bar
                  dataKey="rand"
                  radius={[0, 4, 4, 0]}
                  animationDuration={500}
                  label={{
                    position: "right",
                    fill: "var(--muted-foreground)",
                    fontSize: 11,
                    formatter: (value: unknown) => formatMoney(Number(value) * 100, currency),
                  }}
                >
                  {rows.map((r) => (
                    <Cell key={r.label} fill={r.colour} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </section>

        {/* (b) Fixed vs variable */}
        <section>
          <h3 className="mb-2 text-sm font-medium text-foreground">Committed vs flexible</h3>
          <div className="flex h-3 w-full overflow-hidden rounded-full bg-muted" role="img" aria-label={`${fixedPct}% recurring, ${variablePct}% variable`}>
            <div className="h-full bg-primary transition-[width] duration-500" style={{ width: `${fixedPct}%` }} />
            <div className="h-full bg-muted-foreground/40 transition-[width] duration-500" style={{ width: `${variablePct}%` }} />
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-primary" />
              Recurring {fixedPct}% · {formatMoney(summary.averageMonthlyFixedCents, currency)}
            </span>
            <span className="flex items-center gap-1.5">
              <span className="size-2 rounded-full bg-muted-foreground/40" />
              Variable {variablePct}% · {formatMoney(summary.averageMonthlyVariableCents, currency)}
            </span>
          </div>
          <p className="mt-3 text-sm text-foreground">
            <span className="font-semibold">{formatMoney(summary.averageMonthlyFixedCents, currency)}</span>{" "}
            ({fixedPct}%) of your monthly spend is committed to {summary.fixedSeriesCount} recurring
            payment{summary.fixedSeriesCount === 1 ? "" : "s"} the forecast already accounts for;
            the remaining{" "}
            <span className="font-semibold">{formatMoney(summary.averageMonthlyVariableCents, currency)}</span>{" "}
            is day-to-day spending you can actually flex.
          </p>
        </section>

        {/* (c) Top merchants */}
        {summary.topMerchants.length > 0 && (
          <section>
            <h3 className="mb-2 text-sm font-medium text-foreground">
              Top merchants (last {months} months)
            </h3>
            <ul className="divide-y divide-border">
              {summary.topMerchants.map((m) => (
                <li key={m.merchant} className="flex items-center justify-between gap-3 py-1.5 text-sm">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate font-medium">{m.merchant}</span>
                    <Badge variant="secondary" className="hidden shrink-0 sm:inline-flex">
                      {m.label}
                    </Badge>
                  </div>
                  <div className="flex shrink-0 items-baseline gap-2 tabular-nums">
                    <span className="font-medium">{formatMoney(m.cents, currency)}</span>
                    <span className="w-8 text-right text-xs text-muted-foreground">{m.count}×</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Honesty footer */}
        <div className="flex flex-wrap items-start justify-between gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <p className="max-w-prose">{notes.join(" ")}</p>
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={handleRecategorise}
            disabled={recomputing}
            className="shrink-0 text-muted-foreground"
          >
            <RefreshCw className={recomputing ? "animate-spin" : undefined} />
            Recategorise
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
