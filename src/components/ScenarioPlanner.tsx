import { CirclePlus, FlaskConical, Trash2 } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import type { Doc } from "../../convex/_generated/dataModel";
import { cadenceLabel, formatDate, formatMoney } from "../lib/format";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

export type ScenarioEvent = { dateMs: number; amountCents: number; label: string };

export function ScenarioPlanner({
  series,
  currency,
  excludedKeys,
  onExcludedKeysChange,
  extraEvents,
  onExtraEventsChange,
  safeToSpendCents,
  baselineSafeToSpendCents,
}: {
  series: Doc<"recurringSeries">[];
  currency: string;
  excludedKeys: string[];
  onExcludedKeysChange: (keys: string[]) => void;
  extraEvents: ScenarioEvent[];
  onExtraEventsChange: (events: ScenarioEvent[]) => void;
  /** Safe-to-spend under the current scenario. */
  safeToSpendCents: number;
  /** Safe-to-spend with nothing excluded and no extra events (undefined while loading). */
  baselineSafeToSpendCents: number | undefined;
}) {
  const debitSeries = series.filter((s) => s.direction === "debit" && s.cadence !== "irregular");
  const [label, setLabel] = useState("");
  const [amountRand, setAmountRand] = useState("");
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [dateStr, setDateStr] = useState(() => new Date().toISOString().slice(0, 10));

  const scenarioActive = excludedKeys.length > 0 || extraEvents.length > 0;
  const delta =
    scenarioActive && baselineSafeToSpendCents !== undefined
      ? safeToSpendCents - baselineSafeToSpendCents
      : null;

  function toggle(merchantKey: string, include: boolean) {
    onExcludedKeysChange(
      include ? excludedKeys.filter((k) => k !== merchantKey) : [...excludedKeys, merchantKey],
    );
  }

  function addEvent(e: React.FormEvent) {
    e.preventDefault();
    const rand = Number(amountRand);
    if (!label.trim() || !Number.isFinite(rand) || rand <= 0) return;
    const signed = Math.round(rand * 100) * (kind === "expense" ? -1 : 1);
    onExtraEventsChange([
      ...extraEvents,
      { dateMs: new Date(dateStr).getTime(), amountCents: signed, label: label.trim() },
    ]);
    setLabel("");
    setAmountRand("");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FlaskConical className="size-4 text-primary" />
          Scenario planner
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-muted-foreground">
          What-if experiments only — pausing a series here changes the projection, not the real
          payment. Cancel anything for real with the merchant or your bank.
        </p>

        {debitSeries.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              Recurring payments
            </h3>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {debitSeries.map((s) => {
                const included = !excludedKeys.includes(s.merchantKey);
                return (
                  <li key={s.merchantKey} className="flex items-center gap-3 px-3 py-2.5">
                    <Switch
                      checked={included}
                      onCheckedChange={(checked) => toggle(s.merchantKey, checked === true)}
                      aria-label={`Include ${s.label} in forecast`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className={`truncate text-sm ${included ? "text-foreground" : "text-muted-foreground line-through"}`}>
                        {s.label}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {cadenceLabel(s.cadence)} · next {formatDate(s.predictedNextAt)}
                      </div>
                    </div>
                    <Badge variant={s.confidence >= 0.8 ? "default" : "secondary"}>
                      {Math.round(s.confidence * 100)}% sure
                    </Badge>
                    <div className="w-24 text-right text-sm font-medium">
                      {formatMoney(s.typicalAmountCents, currency)}
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <div className="space-y-2">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            One-off what-ifs
          </h3>
          <form onSubmit={addEvent} className="flex flex-wrap items-end gap-2">
            <Input
              className="w-36"
              placeholder="Label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
            <Input
              className="w-28"
              type="number"
              min="0"
              step="0.01"
              placeholder={`Amount (${currency})`}
              value={amountRand}
              onChange={(e) => setAmountRand(e.target.value)}
            />
            <Select value={kind} onValueChange={(v) => setKind(v as "expense" | "income")}>
              <SelectTrigger className="w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="expense">Expense</SelectItem>
                <SelectItem value="income">Income</SelectItem>
              </SelectContent>
            </Select>
            <Input type="date" value={dateStr} onChange={(e) => setDateStr(e.target.value)} />
            <Button type="submit" variant="secondary" size="sm">
              <CirclePlus className="size-4" /> Add
            </Button>
          </form>
          <AnimatePresence initial={false}>
            {extraEvents.map((ev, i) => (
              <motion.div
                key={`${ev.label}-${ev.dateMs}-${i}`}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="flex items-center gap-3 rounded-lg border border-border px-3 py-2 text-sm"
              >
                <span className="flex-1 truncate">{ev.label}</span>
                <span className="text-xs text-muted-foreground">{formatDate(ev.dateMs)}</span>
                <span className={ev.amountCents < 0 ? "text-destructive" : "text-primary"}>
                  {ev.amountCents < 0 ? "−" : "+"}
                  {formatMoney(Math.abs(ev.amountCents), currency)}
                </span>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  onClick={() => onExtraEventsChange(extraEvents.filter((_, j) => j !== i))}
                  aria-label={`Remove ${ev.label}`}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>

        {scenarioActive && (
          <div className="rounded-lg border border-primary/30 bg-primary/5 px-4 py-3 text-sm">
            <span className="text-muted-foreground">Safe to spend under this scenario: </span>
            <span className="font-semibold text-foreground">
              {formatMoney(safeToSpendCents, currency)}
            </span>
            {delta !== null && delta !== 0 && (
              <span className={delta > 0 ? "text-primary" : "text-destructive"}>
                {" "}
                ({delta > 0 ? "+" : "−"}
                {formatMoney(Math.abs(delta), currency)} vs. no changes)
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
