import { Landmark } from "lucide-react";
import type { Id } from "../../convex/_generated/dataModel";
import { formatMoney } from "../lib/format";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "./ui/select";

type Account = {
  _id: Id<"accounts">;
  name: string;
  currency: string;
  currentBalanceCents: number | null;
};

export function AccountPicker({
  accounts,
  selectedId,
  onChange,
}: {
  accounts: Account[];
  selectedId: Id<"accounts"> | null;
  onChange: (id: Id<"accounts">) => void;
}) {
  if (accounts.length === 0) return null;
  return (
    <Select value={selectedId ?? undefined} onValueChange={(v) => onChange(v as Id<"accounts">)}>
      <SelectTrigger size="default" className="min-w-56 bg-card">
        <Landmark className="text-muted-foreground" />
        <SelectValue placeholder="Choose an account" />
      </SelectTrigger>
      <SelectContent align="end">
        {accounts.map((a) => (
          <SelectItem key={a._id} value={a._id}>
            <span className="flex w-full items-center justify-between gap-4">
              <span>{a.name}</span>
              {a.currentBalanceCents !== null && (
                <span className="text-xs text-muted-foreground">
                  {formatMoney(a.currentBalanceCents, a.currency)}
                </span>
              )}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
