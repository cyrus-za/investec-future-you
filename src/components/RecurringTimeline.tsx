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
};

export function RecurringTimeline({ series, currency }: { series: Series[]; currency: string }) {
  const forecastable = series
    .filter((s) => s.cadence !== "irregular")
    .sort((a, b) => a.predictedNextAt - b.predictedNextAt);
  const irregular = series.filter((s) => s.cadence === "irregular");

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
                <TableHead>Cadence</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Next predicted</TableHead>
                <TableHead>Confidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {forecastable.map((s) => (
                <TableRow key={s._id}>
                  <TableCell className="font-medium whitespace-normal">
                    <span className="flex items-center gap-2">
                      {s.label}
                      {s.isPayday && (
                        <Badge className="bg-primary/15 text-primary" variant="secondary">
                          Payday
                        </Badge>
                      )}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{cadenceLabel(s.cadence)}</TableCell>
                  <TableCell
                    className={s.direction === "credit" ? "font-medium text-primary" : "font-medium"}
                  >
                    {s.direction === "credit" ? "+" : "-"}
                    {formatMoney(s.typicalAmountCents, currency)}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {formatDate(s.predictedNextAt)}
                  </TableCell>
                  <TableCell>
                    <ConfidenceBar value={s.confidence} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
