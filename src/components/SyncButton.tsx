import { useAction, useQuery } from "convex/react";
import { RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import { formatRelativeTime } from "./DataProvenance";
import { Button } from "./ui/button";

export function SyncButton() {
  const runNow = useAction(api.investec.sync.runNow);
  const status = useQuery(api.investec.status.get, {});
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  const running = state === "running" || (status?.syncInProgress ?? false);
  const lastSyncAt =
    status?.lastSuccessfulRun?.finishedAt ?? status?.lastRun?.finishedAt ?? null;

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
      <Button variant="outline" onClick={handleClick} disabled={running}>
        <RefreshCw className={running ? "animate-spin" : ""} />
        {running ? "Syncing…" : "Sync now"}
      </Button>
      {message ? (
        <span className={`text-xs ${state === "error" ? "text-destructive" : "text-muted-foreground"}`}>
          {message}
        </span>
      ) : (
        lastSyncAt && (
          <span className="text-xs text-muted-foreground">
            Last synced {formatRelativeTime(lastSyncAt)}
          </span>
        )
      )}
    </div>
  );
}
