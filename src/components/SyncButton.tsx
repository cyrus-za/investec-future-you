import { useAction } from "convex/react";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { Button } from "./ui/button";

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
      <Button variant="outline" onClick={handleClick} disabled={state === "running"}>
        <RefreshCw className={state === "running" ? "animate-spin" : ""} />
        {state === "running" ? "Syncing…" : "Sync now"}
      </Button>
      {message && (
        <span className={`text-xs ${state === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {message}
        </span>
      )}
    </div>
  );
}
