import { AlertTriangle, CalendarClock, PiggyBank, TrendingDown, Wallet } from "lucide-react";
import { motion } from "motion/react";
import type { ComponentType } from "react";
import { formatDateFull, formatMoney } from "../lib/format";
import { Card, CardContent } from "./ui/card";

const cardVariants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0 },
};

export function BalanceSummaryCards({
  currency,
  startingBalanceCents,
  projectedEndBalanceCents,
  minBalanceCents,
  minBalanceAtMs,
  firstBreachAtMs,
  daysUntilPayday,
  safeToSpendCents,
  runwayDays,
}: {
  currency: string;
  startingBalanceCents: number;
  projectedEndBalanceCents: number;
  minBalanceCents: number;
  minBalanceAtMs: number;
  firstBreachAtMs: number | null;
  daysUntilPayday: number | null;
  /** Estimated extra spend possible before next payday without breaching the safety buffer. */
  safeToSpendCents?: number;
  /** Days until the projected balance first breaches the safety buffer (null = never). */
  runwayDays?: number | null;
}) {
  return (
    <motion.div
      initial="hidden"
      animate="show"
      transition={{ staggerChildren: 0.06 }}
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4"
    >
      {safeToSpendCents !== undefined && (
        <motion.div variants={cardVariants} className="sm:col-span-2 lg:col-span-4">
          <Card className="border-primary/40 bg-primary/5">
            <CardContent className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-primary/15 p-2.5 text-primary">
                  <PiggyBank className="size-5" />
                </div>
                <div>
                  <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                    Safe to spend{daysUntilPayday !== null ? " until payday" : ""}
                  </div>
                  <div className="mt-0.5 text-3xl font-bold text-foreground">
                    {formatMoney(safeToSpendCents, currency)}
                  </div>
                </div>
              </div>
              <p className="max-w-md text-xs text-muted-foreground">
                The most you could spend extra before{" "}
                {daysUntilPayday !== null ? "your next detected payday" : "the end of the horizon"}{" "}
                while keeping the projected balance above your safety buffer.{" "}
                {runwayDays !== null && runwayDays !== undefined && (
                  <span className="text-destructive">
                    Careful: at current levels your buffer is reached in ~{runwayDays} day
                    {runwayDays === 1 ? "" : "s"}.
                  </span>
                )}{" "}
                Estimate, not a guarantee.
              </p>
            </CardContent>
          </Card>
        </motion.div>
      )}
      <StatCard
        icon={Wallet}
        label="Available now"
        value={formatMoney(startingBalanceCents, currency)}
      />
      <StatCard
        icon={TrendingDown}
        label="Projected at end of horizon"
        value={formatMoney(projectedEndBalanceCents, currency)}
        tone={projectedEndBalanceCents < 0 ? "danger" : "default"}
      />
      <StatCard
        icon={TrendingDown}
        label="Lowest projected balance"
        value={formatMoney(minBalanceCents, currency)}
        sub={formatDateFull(minBalanceAtMs)}
        tone={minBalanceCents < 0 ? "danger" : "default"}
      />
      <StatCard
        icon={CalendarClock}
        label="Days until payday"
        value={daysUntilPayday === null ? "—" : String(daysUntilPayday)}
        sub={daysUntilPayday === null ? "No payday detected yet" : undefined}
      />
      {firstBreachAtMs !== null && (
        <motion.div
          variants={cardVariants}
          className="flex items-start gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive sm:col-span-2 lg:col-span-4"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <p>
            <strong>Cashflow risk:</strong> projected balance drops to or below your safety
            threshold by <strong>{formatDateFull(firstBreachAtMs)}</strong>, based on detected
            recurring payments.
          </p>
        </motion.div>
      )}
    </motion.div>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = "default",
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  value: string;
  sub?: string;
  tone?: "default" | "danger";
}) {
  return (
    <motion.div variants={cardVariants}>
      <Card className="gap-2">
        <CardContent className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {label}
            </div>
            <div
              className={`mt-1 text-2xl font-semibold ${tone === "danger" ? "text-destructive" : "text-foreground"}`}
            >
              {value}
            </div>
            {sub && <div className="mt-1 text-xs text-muted-foreground">{sub}</div>}
          </div>
          <div
            className={`rounded-lg p-2 ${tone === "danger" ? "bg-destructive/10 text-destructive" : "bg-primary/10 text-primary"}`}
          >
            <Icon className="size-4" />
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}
