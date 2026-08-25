import { useQuery } from "convex/react";
import { Sparkles } from "lucide-react";
import { motion } from "motion/react";
import { useEffect, useState } from "react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { AccountPicker } from "./components/AccountPicker";
import { AffordabilityCalculator } from "./components/AffordabilityCalculator";
import { BalanceSummaryCards } from "./components/BalanceSummaryCards";
import { ForecastChart } from "./components/ForecastChart";
import { RecurringTimeline } from "./components/RecurringTimeline";
import { SyncButton } from "./components/SyncButton";
import { Skeleton } from "./components/ui/skeleton";

const SAFETY_THRESHOLD_CENTS = 0;
const HORIZON_DAYS = 30;

function App() {
  const accounts = useQuery(api.accounts.list, {});
  const [selectedId, setSelectedId] = useState<Id<"accounts"> | null>(null);

  useEffect(() => {
    if (!selectedId && accounts && accounts.length > 0) {
      setSelectedId(accounts[0]._id);
    }
  }, [accounts, selectedId]);

  const forecast = useQuery(
    api.forecast.queries.getForecast,
    selectedId
      ? { accountId: selectedId, horizonDays: HORIZON_DAYS, safetyThresholdCents: SAFETY_THRESHOLD_CENTS }
      : "skip",
  );
  const series = useQuery(
    api.forecast.queries.listRecurringSeries,
    selectedId ? { accountId: selectedId } : "skip",
  );

  const isLoading = accounts === undefined || (selectedId && forecast === undefined);

  return (
    <div className="min-h-svh bg-gradient-to-b from-background via-background to-primary/[0.03]">
      <div className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
        <header className="mb-8 flex flex-wrap items-start justify-between gap-4">
          <motion.div
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
                <Sparkles className="size-4" />
              </span>
              <h1 className="text-2xl font-bold tracking-tight text-foreground">Future You</h1>
            </div>
            <p className="mt-2 max-w-xl text-sm text-muted-foreground">
              Forecasts your available balance forward using detected recurring payments from
              your Investec account, and tells you whether a purchase is likely to cause a
              shortfall before your next payday.
            </p>
          </motion.div>
          <div className="flex flex-col items-end gap-3">
            {accounts && (
              <AccountPicker accounts={accounts} selectedId={selectedId} onChange={setSelectedId} />
            )}
            <SyncButton />
          </div>
        </header>

        {accounts && accounts.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
            No accounts synced yet. Click "Sync now" to pull data from Investec.
          </div>
        )}

        {isLoading && (
          <div className="space-y-6">
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-24 rounded-xl" />
              ))}
            </div>
            <Skeleton className="h-72 rounded-xl" />
          </div>
        )}

        {forecast && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.25 }}
            className="space-y-6"
          >
            <BalanceSummaryCards
              currency={forecast.currency}
              startingBalanceCents={forecast.startingBalanceCents}
              projectedEndBalanceCents={
                forecast.dailyBalances[forecast.dailyBalances.length - 1]?.balanceCents ??
                forecast.startingBalanceCents
              }
              minBalanceCents={forecast.minBalanceCents}
              minBalanceAtMs={forecast.minBalanceAtMs}
              firstBreachAtMs={forecast.firstBreachAtMs}
              daysUntilPayday={forecast.daysUntilPayday}
            />
            <ForecastChart
              dailyBalances={forecast.dailyBalances}
              currency={forecast.currency}
              safetyThresholdCents={SAFETY_THRESHOLD_CENTS}
            />
            {selectedId && (
              <AffordabilityCalculator
                accountId={selectedId}
                currency={forecast.currency}
                safetyThresholdCents={SAFETY_THRESHOLD_CENTS}
              />
            )}
            <RecurringTimeline series={series ?? []} currency={forecast.currency} />
          </motion.div>
        )}

        <footer className="mt-10 border-t border-border pt-4 text-xs text-muted-foreground">
          Forecasts are estimates based on detected patterns in past transactions — not
          guarantees. Built for the Investec Q3 2026 "Future You" bounty.
        </footer>
      </div>
    </div>
  );
}

export default App;
