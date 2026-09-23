import { useQuery } from "convex/react";
import { Database, Info, RefreshCw } from "lucide-react";
import { useState } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { cn } from "@/lib/utils";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { Separator } from "./ui/separator";
import { Skeleton } from "./ui/skeleton";

export function formatRelativeTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hr ago`;
  return `${Math.floor(hours / 24)} d ago`;
}

const ENVIRONMENT_LABEL = {
  sandbox: "Investec Sandbox",
  production: "Investec Production",
  unknown: "Investec (host unknown)",
} as const;

const BALANCE_SOURCE_LABEL = {
  balance_endpoint: "Balance endpoint",
  running_balance: "Running balance",
  synthetic: "Synthetic",
  unknown: "Unknown",
} as const;

/**
 * Compact strip under the header answering "where did these numbers come
 * from?": environment, freshness, coverage, and which Investec endpoints
 * were used. All data comes from api.investec.status.get.
 */
export function DataProvenance({ accountId }: { accountId: Id<"accounts"> | null }) {
  const status = useQuery(api.investec.status.get, accountId ? { accountId } : {});
  const [showEndpoints, setShowEndpoints] = useState(false);

  if (status === undefined) {
    return <Skeleton className="h-9 w-full rounded-lg" />;
  }
  if (status.dataSource === "none") return null;

  const account = status.account;
  const lastSyncAt =
    status.lastSuccessfulRun?.finishedAt ?? status.lastRun?.finishedAt ?? null;

  return (
    <div className="relative">
      <Card size="sm">
        <CardContent className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-muted-foreground">
          {status.dataSource === "synthetic" ? (
            <Badge variant="secondary">
              <Database data-icon="inline-start" />
              Demo data
            </Badge>
          ) : (
            <Badge variant={status.environment === "production" ? "default" : "outline"}>
              <Database data-icon="inline-start" />
              {ENVIRONMENT_LABEL[status.environment]}
            </Badge>
          )}

          <span className="inline-flex items-center gap-1">
            <RefreshCw
              className={cn("size-3", status.syncInProgress && "animate-spin text-primary")}
            />
            {status.syncInProgress
              ? "Syncing…"
              : lastSyncAt
                ? `Last synced ${formatRelativeTime(lastSyncAt)}`
                : "Never synced"}
          </span>

          {account && (
            <>
              <Separator orientation="vertical" className="hidden h-4 sm:block" />
              <span>
                {account.transactionCount.toLocaleString()}
                {account.transactionCountCapped ? "+" : ""} transactions
                {account.pendingCount > 0 && ` · ${account.pendingCount} pending`}
              </span>
              <Separator orientation="vertical" className="hidden h-4 sm:block" />
              <span>
                Balance: {BALANCE_SOURCE_LABEL[account.balanceSource]}
                {account.balanceAsOf && ` (${formatRelativeTime(account.balanceAsOf)})`}
              </span>
            </>
          )}

          <Button
            variant="ghost"
            size="icon-xs"
            className="ml-auto"
            aria-label="Show Investec endpoints used"
            aria-expanded={showEndpoints}
            onClick={() => setShowEndpoints((v) => !v)}
          >
            <Info className="size-3.5" />
          </Button>
        </CardContent>
      </Card>

      {showEndpoints && (
        <Card size="sm" className="absolute right-0 z-20 mt-1 w-full max-w-md shadow-lg sm:w-md">
          <CardContent>
            <p className="mb-2 text-xs font-medium text-foreground">
              Investec endpoints used{status.apiHost ? ` · ${status.apiHost}` : ""}
            </p>
            <ul className="space-y-2">
              {status.endpoints.map((e) => (
                <li key={`${e.method} ${e.path}`} className="text-xs">
                  <span className="font-mono text-foreground">
                    <span className="text-primary">{e.method}</span> {e.path}
                  </span>
                  <p className="mt-0.5 text-muted-foreground">{e.purpose}</p>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
