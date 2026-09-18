import { CalendarRange, Repeat } from "lucide-react";
import { cadenceLabel, formatDate, formatMoney } from "../lib/format";
import { Badge } from "./ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";

type Series = {
  _id: string;
  label: string;
  direction: "debit" | "credit";
  cadence: string;
  typicalAmountCents: number;
  predictedNextAt: number;
  confidence: number;
  isPayday: boolean;
  category?: string;
  anomalyKind?: "amount_spike" | "amount_drop" | "missed_payment";
  anomalyDetail?: string;
  lastAmountCents?: number;
};

/** Per-month equivalent of a series' typical amount (irregular = not forecastable). */
function monthlyEquivalentCents(s: Pick<Series, "cadence" | "typicalAmountCents">): number {
  switch (s.cadence) {
    case "monthly":
      return s.typicalAmountCents;
    case "biweekly":
      return Math.round((s.typicalAmountCents * 26) / 12);
    case "weekly":
      return Math.round((s.typicalAmountCents * 52) / 12);
    default:
      return 0;
  }
}

export function RecurringTimeline({ series, currency }: { series: Series[]; currency: string }) {
  const forecastable = series
    .filter((s) => s.cadence !== "irregular")
    .sort((a, b) => a.predictedNextAt - b.predictedNextAt);
  const irregular = series.filter((s) => s.cadence === "irregular");
  // Stopped (missed) series are excluded: they are unlikely to keep debiting.
  const monthlyDebitsCents = forecastable
    .filter((s) => s.direction === "debit" && s.anomalyKind !== "missed_payment")
    .reduce((sum, s) => sum + monthlyEquivalentCents(s), 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Repeat className="size-4 text-primary" />
          Upcoming recurring payments
        </CardTitle>
      </CardHeader>
      <CardContent>
        {series.length === 0 ? (
          <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
            <CalendarRange className="size-4" />
            No recurring payments detected yet. Sync more transaction history for better
            detection.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Merchant</TableHead>
                <TableHead className="hidden sm:table-cell">Cadence</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Next predicted</TableHead>
                <TableHead className="hidden sm:table-cell">Confidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {forecastable.map((s) => (
                <TableRow key={s._id}>
                  <TableCell className="font-medium whitespace-normal">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {s.label}
                      {s.isPayday && (
                        <Badge className="bg-primary/15 text-primary" variant="secondary">
                          Payday
                        </Badge>
                      )}
                      {s.category && s.category !== "other" && !s.isPayday && (
                        <Badge variant="outline" className="text-muted-foreground capitalize">
                          {s.category}
                        </Badge>
                      )}
                      <AnomalyBadge kind={s.anomalyKind} detail={s.anomalyDetail} />
                    </span>
                  </TableCell>
                  <TableCell className="hidden text-muted-foreground sm:table-cell">
                    {cadenceLabel(s.cadence)}
                  </TableCell>
                  <TableCell
                    className={s.direction === "credit" ? "font-medium text-primary" : "font-medium"}
                  >
                    {s.direction === "credit" ? "+" : "-"}
                    {formatMoney(s.typicalAmountCents, currency)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(s.predictedNextAt)}
                  </TableCell>
                  <TableCell className="hidden sm:table-cell">
                    <ConfidenceBar value={s.confidence} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {monthlyDebitsCents > 0 && (
          <p className="mt-3 flex items-center justify-between gap-2 border-t border-border pt-3 text-sm">
            <span className="text-muted-foreground">Recurring debits per month (estimate)</span>
            <span className="font-semibold tabular-nums">≈ {formatMoney(monthlyDebitsCents, currency)}</span>
          </p>
        )}
        {irregular.length > 0 && (
          <p className="mt-3 text-xs text-muted-foreground">
            {irregular.length} other merchant{irregular.length === 1 ? "" : "s"} seen more than
            once but without a consistent enough interval to forecast (e.g. occasional online
            orders).
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function AnomalyBadge({
  kind,
  detail,
}: {
  kind?: "amount_spike" | "amount_drop" | "missed_payment";
  detail?: string;
}) {
  if (!kind) return null;
  if (kind === "missed_payment") {
    return (
      <Badge variant="destructive" title={detail}>
        Missed
      </Badge>
    );
  }
  if (kind === "amount_spike") {
    return (
      <Badge className="bg-amber-500/15 text-amber-500 dark:text-amber-400" title={detail}>
        {detail ?? "Higher than usual"}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" title={detail}>
      {detail ?? "Lower than usual"}
    </Badge>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100);
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-16 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-muted-foreground">{pct}%</span>
    </div>
  );
}
