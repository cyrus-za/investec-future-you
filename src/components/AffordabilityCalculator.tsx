import { useQuery } from "convex/react";
import { CheckCircle2, Sparkles, XCircle } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { formatDateFull, formatMoney } from "../lib/format";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          Can I afford this?
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">What</label>
            <Input
              className="w-40"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="New TV"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">Amount ({currency})</label>
            <Input
              className="w-32"
              type="number"
              min="0"
              step="0.01"
              value={amountRand}
              onChange={(e) => setAmountRand(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-muted-foreground">When</label>
            <Input
              type="date"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
            />
          </div>
          <Button type="submit">Check</Button>
        </form>

        {submitted && result === undefined && (
          <p className="mt-3 text-sm text-muted-foreground">Calculating…</p>
        )}

        <AnimatePresence mode="wait">
          {submitted && result && (
            <motion.div
              key={`${submitted.label}-${submitted.amountCents}-${submitted.dateMs}`}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.2 }}
              className={`mt-4 flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
                result.canAfford
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-destructive/40 bg-destructive/10 text-destructive"
              }`}
            >
              {result.canAfford ? (
                <CheckCircle2 className="mt-0.5 size-4 shrink-0" />
              ) : (
                <XCircle className="mt-0.5 size-4 shrink-0" />
              )}
              <div>
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
            </motion.div>
          )}
        </AnimatePresence>
      </CardContent>
    </Card>
  );
}
