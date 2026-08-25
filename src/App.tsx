import { useQuery } from "convex/react";
import { useEffect, useState } from "react";
import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { AccountPicker } from "./components/AccountPicker";
import { AffordabilityCalculator } from "./components/AffordabilityCalculator";
import { BalanceSummaryCards } from "./components/BalanceSummaryCards";
import { ForecastChart } from "./components/ForecastChart";
import { RecurringTimeline } from "./components/RecurringTimeline";
import { SyncButton } from "./components/SyncButton";

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

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-50">Future You</h1>
          <p className="mt-1 max-w-xl text-sm text-slate-400">
            Forecasts your available balance forward using detected recurring payments from your
            Investec account, and tells you whether a purchase is likely to cause a shortfall
            before your next payday.
          </p>
        </div>
        <div className="flex flex-col items-end gap-3">
          {accounts && (
            <AccountPicker accounts={accounts} selectedId={selectedId} onChange={setSelectedId} />
          )}
          <SyncButton />
        </div>
      </header>

      {accounts && accounts.length === 0 && (
        <p className="rounded-lg border border-slate-800 bg-slate-900/60 p-6 text-sm text-slate-400">
          No accounts synced yet. Click "Sync now" to pull data from Investec.
        </p>
      )}

      {forecast && (
        <div className="space-y-6">
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
        </div>
      )}

      <footer className="mt-10 border-t border-slate-800 pt-4 text-xs text-slate-500">
        Forecasts are estimates based on detected patterns in past transactions — not guarantees.
        Built for the Investec Q3 2026 "Future You" bounty.
      </footer>
    </div>
  );
}

export default App;
