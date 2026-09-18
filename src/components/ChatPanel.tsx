import { useAction, useMutation, useQuery } from "convex/react";
import { ConvexError } from "convex/values";
import {
  Bot,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  LoaderCircle,
  MessageCircle,
  Send,
  ShieldCheck,
  Trash2,
  Wrench,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./ui/card";
import { Input } from "./ui/input";

const SUGGESTED_QUESTIONS = [
  "Will I make it to payday?",
  "Can I afford a R4,500 flight on the 15th?",
  "What's my biggest recurring cost?",
  "What if I cancel Netflix?",
];

const TOOL_LABELS: Record<string, string> = {
  get_forecast: "Balance forecast",
  check_affordability: "Affordability check",
  list_recurring: "Recurring payments",
  simulate_cancellation: "Cancellation what-if",
  list_insights: "Alerts & anomalies",
};

type ToolCallMeta = { name: string; summary: string; ok: boolean; args?: unknown };
type MessageMeta = { toolCalls?: ToolCallMeta[]; model?: string; rounds?: number } | null;

function threadStorageKey(accountId: string) {
  return `future-you:chat-thread:${accountId}`;
}

function loadOrCreateThreadId(accountId: string): string {
  const key = threadStorageKey(accountId);
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const fresh = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    window.localStorage.setItem(key, fresh);
    return fresh;
  } catch {
    return `session-${accountId}`;
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof ConvexError) {
    return typeof err.data === "string" ? err.data : "The AI coach hit an error. Your forecast is unaffected.";
  }
  if (err instanceof Error && /not configured/i.test(err.message)) return err.message;
  return "The AI coach couldn't answer that right now. Your forecast is unaffected — please try again.";
}

export function ChatPanel({
  accountId,
  safetyThresholdCents = 0,
}: {
  accountId: Id<"accounts">;
  safetyThresholdCents?: number;
}) {
  const [threadId, setThreadId] = useState(() => loadOrCreateThreadId(accountId));
  useEffect(() => setThreadId(loadOrCreateThreadId(accountId)), [accountId]);

  const checkEnabled = useAction(api.chat.status.isEnabled);
  const [status, setStatus] = useState<{ enabled: boolean; model: string; reason: string | null } | "loading" | "error">(
    "loading",
  );
  useEffect(() => {
    let cancelled = false;
    checkEnabled({})
      .then((s) => !cancelled && setStatus(s))
      .catch(() => !cancelled && setStatus("error"));
    return () => {
      cancelled = true;
    };
  }, [checkEnabled]);

  const messages = useQuery(api.chat.messages.listMessages, { threadId });
  const sendMessage = useAction(api.chat.coach.sendMessage);

  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const enabled = status !== "loading" && status !== "error" && status.enabled;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages?.length, pending]);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message || pending || !enabled) return;
      setError(null);
      setPending(message);
      setDraft("");
      try {
        await sendMessage({ threadId, accountId, message, safetyThresholdCents });
      } catch (err) {
        setError(errorMessage(err));
        setDraft(message);
      } finally {
        setPending(null);
      }
    },
    [accountId, enabled, pending, safetyThresholdCents, sendMessage, threadId],
  );

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void send(draft);
  }

  const lastAssistantId = useMemo(() => {
    if (!messages) return null;
    for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "assistant") return messages[i]._id;
    return null;
  }, [messages]);

  const showPendingBubble = pending !== null && !(messages ?? []).some((m) => m.role === "user" && m.content === pending && m.createdAt > Date.now() - 60_000);

  return (
    <Card>
      <CardHeader className="border-b pb-4">
        <CardTitle className="flex items-center gap-2">
          <MessageCircle className="size-4 text-primary" />
          Chat with Future You
          <Badge variant="secondary" className="ml-1 bg-primary/15 text-primary">
            AI · beta
          </Badge>
        </CardTitle>
        <CardDescription>
          Ask plain-language questions about your cashflow. Answers are grounded in the same deterministic
          forecast you see above — the AI only phrases them, it never invents numbers.
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {status === "loading" && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" /> Checking whether the AI coach is available…
          </p>
        )}

        {(status === "error" || (status !== "loading" && !status.enabled)) && (
          <div className="flex items-start gap-3 rounded-lg border border-dashed border-border bg-muted/30 px-4 py-3 text-sm">
            <CircleAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div>
              <p className="font-medium text-foreground">AI coach not configured</p>
              <p className="mt-1 text-muted-foreground">
                {status === "error"
                  ? "Couldn't reach the backend to check the AI coach status."
                  : "AI coach isn't configured on this deployment (missing OPENAI_API_KEY)."}{" "}
                Everything else still works — the forecast, recurring payments and the affordability
                calculator don't need it.
              </p>
            </div>
          </div>
        )}

        {enabled && (
          <>
            <div
              ref={listRef}
              className="max-h-[26rem] space-y-3 overflow-y-auto rounded-lg border border-border/60 bg-background/40 p-3"
              aria-live="polite"
            >
              {messages === undefined && <p className="text-sm text-muted-foreground">Loading conversation…</p>}

              {messages && messages.length === 0 && !pending && (
                <div className="flex flex-col items-center gap-2 py-6 text-center text-sm text-muted-foreground">
                  <Bot className="size-6 text-primary/70" />
                  <p>
                    Ask about payday, a purchase you're considering, or your recurring payments. Try one of the
                    suggestions below.
                  </p>
                </div>
              )}

              <AnimatePresence initial={false}>
                {messages?.map((m) => (
                  <motion.div
                    key={m._id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.18 }}
                    className={m.role === "user" ? "flex justify-end" : "flex justify-start"}
                  >
                    {m.role === "user" ? (
                      <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground shadow-sm">
                        {m.content}
                      </div>
                    ) : (
                      <AssistantBubble
                        content={m.content}
                        meta={m.meta as MessageMeta}
                        expanded={expandedId === m._id}
                        onToggle={() => setExpandedId(expandedId === m._id ? null : m._id)}
                        isLatest={m._id === lastAssistantId}
                      />
                    )}
                  </motion.div>
                ))}
              </AnimatePresence>

              {showPendingBubble && (
                <div className="flex justify-end">
                  <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-primary/80 px-3.5 py-2 text-sm text-primary-foreground">
                    {pending}
                  </div>
                </div>
              )}

              {pending !== null && (
                <div className="flex justify-start">
                  <div className="flex items-center gap-2 rounded-2xl rounded-bl-sm border border-border bg-card px-3.5 py-2 text-sm text-muted-foreground">
                    <LoaderCircle className="size-3.5 animate-spin text-primary" />
                    Future You is checking the forecast…
                  </div>
                </div>
              )}
            </div>

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <CircleAlert className="mt-0.5 size-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              {SUGGESTED_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={pending !== null}
                  onClick={() => void send(q)}
                  className="rounded-full border border-border bg-background px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
                >
                  {q}
                </button>
              ))}
            </div>

            <form onSubmit={handleSubmit} className="flex items-center gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="e.g. Can I afford new tyres for R6,000 next week?"
                disabled={pending !== null}
                maxLength={2000}
                aria-label="Ask Future You a question"
                autoComplete="off"
              />
              <Button type="submit" disabled={pending !== null || !draft.trim()} aria-label="Send">
                <Send className="size-4" />
                <span className="hidden sm:inline">Send</span>
              </Button>
              <ClearThreadButton threadId={threadId} disabled={pending !== null || !messages?.length} onCleared={() => setExpandedId(null)} />
            </form>
          </>
        )}

        <p className="flex items-start gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Estimates only — not financial advice. Answers are computed from your synced Investec data
            {status !== "loading" && status !== "error" && status.enabled
              ? ` and phrased by OpenAI ${status.model}`
              : ""}
            ; the AI sees account summaries and forecast results, never your raw statement.
          </span>
        </p>
      </CardContent>
    </Card>
  );
}

function ClearThreadButton({
  threadId,
  disabled,
  onCleared,
}: {
  threadId: string;
  disabled: boolean;
  onCleared: () => void;
}) {
  const clear = useMutation(api.chat.messages.clearThread);
  const [busy, setBusy] = useState(false);
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Clear conversation"
      title="Clear conversation"
      disabled={disabled || busy}
      onClick={async () => {
        setBusy(true);
        try {
          await clear({ threadId });
          onCleared();
        } finally {
          setBusy(false);
        }
      }}
    >
      <Trash2 className="size-4" />
    </Button>
  );
}

function AssistantBubble({
  content,
  meta,
  expanded,
  onToggle,
  isLatest,
}: {
  content: string;
  meta: MessageMeta;
  expanded: boolean;
  onToggle: () => void;
  isLatest: boolean;
}) {
  const toolCalls = meta?.toolCalls ?? [];
  return (
    <div className="max-w-[90%] space-y-2">
      <div className="rounded-2xl rounded-bl-sm border border-border bg-card px-3.5 py-2.5 text-sm shadow-sm">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-primary">
          <Bot className="size-3.5" /> Future You
        </div>
        <RichText text={content} />
      </div>
      <div className="flex items-center gap-2 pl-1 text-[11px] text-muted-foreground">
        <button
          type="button"
          onClick={onToggle}
          className="inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors hover:text-foreground"
          aria-expanded={expanded}
        >
          <Wrench className="size-3" />
          {toolCalls.length === 0
            ? "Answered from the account summary (no forecast tools needed)"
            : `How was this answered? ${toolCalls.length} forecast tool${toolCalls.length === 1 ? "" : "s"} used`}
          {toolCalls.length > 0 && (expanded ? <ChevronUp className="size-3" /> : <ChevronDown className="size-3" />)}
        </button>
        {isLatest && meta?.model && <span className="opacity-70">· {meta.model}</span>}
      </div>
      {expanded && toolCalls.length > 0 && (
        <ul className="ml-1 space-y-1 rounded-lg border border-border/60 bg-muted/30 px-3 py-2 text-xs">
          {toolCalls.map((tc, i) => (
            <li key={i} className="flex items-start gap-2">
              <Badge variant="outline" className={tc.ok ? "shrink-0" : "shrink-0 border-destructive/50 text-destructive"}>
                {TOOL_LABELS[tc.name] ?? tc.name}
              </Badge>
              <span className="text-muted-foreground">{tc.summary}</span>
            </li>
          ))}
          <li className="pt-1 text-[11px] text-muted-foreground/80">
            Each tool runs the same deterministic engine as the dashboard; the AI only chose which to call and
            worded the answer.
          </li>
        </ul>
      )}
    </div>
  );
}

/** Minimal renderer: "- " bullets, **bold**, and paragraphs. No markdown dependency. */
function RichText({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let bullets: ReactNode[] = [];
  const flush = () => {
    if (bullets.length) {
      blocks.push(
        <ul key={`ul-${blocks.length}`} className="my-1 list-disc space-y-0.5 pl-4">
          {bullets}
        </ul>,
      );
      bullets = [];
    }
  };
  lines.forEach((raw, i) => {
    const line = raw.trimEnd();
    const bullet = /^\s*[-•*]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(<li key={i}>{inline(bullet[1])}</li>);
      return;
    }
    flush();
    if (!line.trim()) return;
    const isDisclaimer = /not financial advice/i.test(line);
    const isNextStep = /^next step:/i.test(line.trim());
    blocks.push(
      <p
        key={i}
        className={
          isDisclaimer
            ? "mt-2 text-[11px] italic text-muted-foreground"
            : isNextStep
              ? "mt-2 rounded-md bg-primary/10 px-2 py-1 text-primary"
              : "my-0.5"
        }
      >
        {inline(line)}
      </p>,
    );
  });
  flush();
  return <div className="leading-relaxed">{blocks}</div>;
}

function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) =>
    part.startsWith("**") && part.endsWith("**") ? (
      <strong key={i} className="font-semibold text-foreground">
        {part.slice(2, -2)}
      </strong>
    ) : (
      <span key={i}>{part}</span>
    ),
  );
}
