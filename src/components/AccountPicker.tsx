import type { Id } from "../../convex/_generated/dataModel";
import { formatMoney } from "../lib/format";

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
    <label className="flex items-center gap-2 text-sm text-slate-300">
      Account
      <select
        className="rounded-md border border-slate-700 bg-slate-900 px-3 py-1.5 text-slate-100 focus:border-emerald-500 focus:outline-none"
        value={selectedId ?? ""}
        onChange={(e) => onChange(e.target.value as Id<"accounts">)}
      >
        {accounts.map((a) => (
          <option key={a._id} value={a._id}>
            {a.name}
            {a.currentBalanceCents !== null
              ? ` — ${formatMoney(a.currentBalanceCents, a.currency)}`
              : ""}
          </option>
        ))}
      </select>
    </label>
  );
}
