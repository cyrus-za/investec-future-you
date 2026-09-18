import { useMutation, useQuery } from "convex/react";
import {
  AlertTriangle,
  BellRing,
  CalendarX2,
  CheckCircle2,
  Layers,
  ShieldAlert,
  TrendingDown,
  TrendingUp,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import type { ComponentType } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Skeleton } from "./ui/skeleton";

type Severity = "info" | "warning" | "critical";

const KIND_ICON: Record<string, ComponentType<{ className?: string }>> = {
  cashflow_risk: ShieldAlert,
  amount_spike: TrendingUp,
  amount_drop: TrendingDown,
  missed_payment: CalendarX2,
  subscription_creep: Layers,
  upcoming_cluster: AlertTriangle,
};

const SEVERITY_STYLES: Record<
  Severity,
  { row: string; icon: string; badge: string; label: string }
> = {
  critical: {
    row: "border-destructive/40 bg-destructive/10",
    icon: "bg-destructive/15 text-destructive",
    badge: "bg-destructive/15 text-destructive",
    label: "Urgent",
  },
  warning: {
    row: "border-amber-500/30 bg-amber-500/10",
    icon: "bg-amber-500/15 text-amber-500 dark:text-amber-400",
    badge: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
    label: "Check",
  },
  info: {
    row: "border-border bg-muted/40",
    icon: "bg-muted text-muted-foreground",
    badge: "bg-muted text-muted-foreground",
    label: "FYI",
  },
};

export function InsightsPanel({ accountId }: { accountId: Id<"accounts"> }) {
  const insights = useQuery(api.insights.queries.list, { accountId });
  const dismiss = useMutation(api.insights.mutations.dismiss);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="size-4 text-primary" />
          Insights &amp; alerts
          {insights && insights.length > 0 && (
            <Badge variant="secondary" className="ml-1">
              {insights.length}
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Heuristic alerts from your detected recurring payments — unusual amounts, debit orders
          that stopped arriving, subscription totals and projected shortfalls. Estimates, not
          guarantees.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {insights === undefined ? (
          <div className="space-y-2">
            <Skeleton className="h-14 rounded-lg" />
            <Skeleton className="h-14 rounded-lg" />
          </div>
        ) : insights.length === 0 ? (
          <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <CheckCircle2 className="size-4 text-primary" />
            Nothing needs your attention right now — recurring payments look normal.
          </p>
        ) : (
          <ul className="space-y-2">
            <AnimatePresence initial={false}>
              {insights.map((insight) => {
                const styles = SEVERITY_STYLES[insight.severity];
                const Icon = KIND_ICON[insight.kind] ?? AlertTriangle;
                return (
                  <motion.li
                    key={insight._id}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, x: 24, height: 0, marginBottom: 0 }}
                    transition={{ duration: 0.2 }}
                    className={`flex items-start gap-3 rounded-lg border px-3 py-2.5 ${styles.row}`}
                  >
                    <span className={`mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md ${styles.icon}`}>
                      <Icon className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="text-sm font-medium text-foreground">{insight.title}</p>
                        <Badge className={styles.badge}>{styles.label}</Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-muted-foreground">{insight.detail}</p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label="Dismiss insight"
                      title="Dismiss"
                      className="shrink-0 text-muted-foreground"
                      onClick={() => void dismiss({ insightId: insight._id })}
                    >
                      <X />
                    </Button>
                  </motion.li>
                );
              })}
            </AnimatePresence>
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
