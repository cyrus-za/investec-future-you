import { SlidersHorizontal } from "lucide-react";
import { formatMoney } from "../lib/format";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";
import { Switch } from "./ui/switch";

export type ForecastSettings = {
  horizonDays: number;
  safetyThresholdCents: number;
  includeVariableSpend: boolean;
};

export function ForecastControls({
  settings,
  onChange,
  currency,
  variableSpendDailyCents,
}: {
  settings: ForecastSettings;
  onChange: (next: ForecastSettings) => void;
  currency: string;
  /** Estimated typical daily discretionary spend, when known. */
  variableSpendDailyCents?: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <SlidersHorizontal className="size-4 text-primary" />
          Forecast settings
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-wrap items-end gap-x-6 gap-y-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">Horizon</label>
          <Select
            value={String(settings.horizonDays)}
            onValueChange={(v) => onChange({ ...settings, horizonDays: Number(v) })}
          >
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="30">30 days</SelectItem>
              <SelectItem value="60">60 days</SelectItem>
              <SelectItem value="90">90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-muted-foreground">
            Safety buffer ({currency}) — alert me below
          </label>
          <Input
            className="w-32"
            type="number"
            min="0"
            step="50"
            value={String(settings.safetyThresholdCents / 100)}
            onChange={(e) => {
              const rand = Number(e.target.value);
              onChange({
                ...settings,
                safetyThresholdCents: Number.isFinite(rand) && rand >= 0 ? Math.round(rand * 100) : 0,
              });
            }}
          />
        </div>

        <div className="flex items-center gap-3 pb-1">
          <Switch
            id="variable-spend"
            checked={settings.includeVariableSpend}
            onCheckedChange={(checked) =>
              onChange({ ...settings, includeVariableSpend: checked === true })
            }
          />
          <label htmlFor="variable-spend" className="text-sm text-foreground">
            Include typical day-to-day spend
            <span className="block text-xs text-muted-foreground">
              {variableSpendDailyCents !== undefined && settings.includeVariableSpend
                ? `Median of your last 8 weeks: ≈ ${formatMoney(variableSpendDailyCents, currency)}/day, excluding detected recurring payments.`
                : "Median daily spend from your last 8 weeks, excluding detected recurring payments."}
            </span>
          </label>
        </div>
      </CardContent>
    </Card>
  );
}
