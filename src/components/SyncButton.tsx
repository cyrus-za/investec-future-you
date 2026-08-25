import { useAction } from "convex/react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";

export function SyncButton() {
  const runNow = useAction(api.investec.sync.runNow);
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  async function handleClick() {
    setState("running");
    setMessage(null);
    try {
      const result = await runNow({});
      setState("done");
      setMessage(
        `Synced ${result.accountsSynced} account(s): ${result.transactionsInserted} new, ${result.transactionsUpdated} updated.`,
      );
    } catch (err) {
      setState("error");
      setMessage(err instanceof Error ? err.message : "Sync failed.");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        onClick={handleClick}
        disabled={state === "running"}
        className="rounded-md border border-slate-700 bg-slate-800 px-3 py-1.5 text-sm text-slate-100 hover:bg-slate-700 disabled:opacity-50"
      >
        {state === "running" ? "Syncing…" : "Sync now"}
      </button>
      {message && (
        <span className={`text-xs ${state === "error" ? "text-red-400" : "text-slate-500"}`}>
          {message}
        </span>
      )}
    </div>
  );
}
