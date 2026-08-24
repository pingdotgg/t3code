import type {
  EnvironmentId,
  OrchestrationThreadContextMessage,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronRight, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";

import { useI18n } from "~/i18n";
import { cn } from "~/lib/utils";
import {
  deriveLatestContextWindowSnapshot,
  formatContextWindowTokens,
  formatProviderDisplayName,
} from "~/lib/contextWindow";
import { useEnvironmentQuery } from "~/state/query";
import { useThreadDetail } from "~/state/queries";
import { orchestrationEnvironment } from "~/state/orchestration";
import { formatTimestamp } from "~/timestampFormat";
import { useClientSettings } from "~/hooks/useSettings";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "./ui/collapsible";
import { ScrollArea } from "./ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

type BreakdownCategory = "user" | "assistant" | "tool" | "other";

const BREAKDOWN_COLORS: Record<BreakdownCategory, string> = {
  user: "var(--color-green-500)",
  assistant: "var(--color-purple-500)",
  tool: "var(--color-amber-600)",
  other: "var(--color-muted-foreground)",
};

function categorizeMessage(message: OrchestrationThreadContextMessage): BreakdownCategory {
  const role = message.role?.toLowerCase() ?? null;
  if (role === "user") return "user";
  if (role === "assistant") return "assistant";
  if (role !== null && (role.includes("tool") || role.includes("function"))) return "tool";
  const content = message.content;
  if (content !== null && typeof content === "object" && !Array.isArray(content)) {
    const type = (content as { type?: unknown }).type;
    if (typeof type === "string") {
      const normalized = type.toLowerCase();
      if (normalized.includes("tool") || normalized.includes("function")) return "tool";
      if (normalized === "usermessage") return "user";
      if (normalized === "agentmessage" || normalized === "assistantmessage") return "assistant";
    }
  }
  return "other";
}

function messageSize(message: OrchestrationThreadContextMessage): number {
  try {
    return JSON.stringify(message.content)?.length ?? 0;
  } catch {
    return 0;
  }
}

function formatPercent(value: number): string {
  if (value < 0.1) return "<0.1%";
  if (value < 10) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

function InfoCell(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-muted-foreground/70 text-xs">{props.label}</span>
      <Tooltip>
        <TooltipTrigger
          render={
            <span
              className={cn(
                "truncate text-sm font-medium text-foreground",
                props.mono && "tabular-nums",
              )}
            />
          }
        >
          {props.value}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-sm break-all">
          {props.value}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function RawMessageRow(props: {
  message: OrchestrationThreadContextMessage;
  timestampFormat: Parameters<typeof formatTimestamp>[1];
  defaultOpen: boolean;
}) {
  const { message } = props;
  const [open, setOpen] = useState(props.defaultOpen);
  const pretty = useMemo(() => {
    try {
      return JSON.stringify(message.content, null, 2) ?? String(message.content);
    } catch {
      return String(message.content);
    }
  }, [message.content]);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="rounded-md border border-border/60 bg-card/40"
    >
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-accent/50">
        <ChevronRight
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
            open && "rotate-90",
          )}
        />
        <span className="shrink-0 text-xs font-medium text-foreground">
          {message.role ?? "unknown"}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted-foreground/70 text-xs">
          {message.id}
        </span>
        {message.createdAt !== null ? (
          <span className="shrink-0 text-muted-foreground/50 text-xs tabular-nums">
            {formatTimestamp(message.createdAt, props.timestampFormat)}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsiblePanel>
        <pre className="max-h-96 overflow-auto border-t border-border/60 px-3 py-2 text-xs leading-5 whitespace-pre-wrap break-words text-muted-foreground">
          {pretty}
        </pre>
      </CollapsiblePanel>
    </Collapsible>
  );
}

export function ContextPanel(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const { t } = useI18n();
  const settings = useClientSettings();
  const threadDetail = useThreadDetail(props.environmentId, props.threadId);
  const thread = threadDetail.data;
  const contextQuery = useEnvironmentQuery(
    orchestrationEnvironment.threadContext({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    }),
  );

  const usage = useMemo(
    () => deriveLatestContextWindowSnapshot(thread?.activities ?? []),
    [thread?.activities],
  );

  const messages = useMemo(() => contextQuery.data?.messages ?? [], [contextQuery.data]);

  const breakdown = useMemo(() => {
    const sizes: Record<BreakdownCategory, number> = { user: 0, assistant: 0, tool: 0, other: 0 };
    for (const message of messages) {
      sizes[categorizeMessage(message)] += messageSize(message);
    }
    const total = sizes.user + sizes.assistant + sizes.tool + sizes.other;
    return { sizes, total };
  }, [messages]);

  const messageCounts = useMemo(() => {
    let user = 0;
    let assistant = 0;
    for (const message of messages) {
      const category = categorizeMessage(message);
      if (category === "user") user += 1;
      if (category === "assistant") assistant += 1;
    }
    return { user, assistant };
  }, [messages]);

  const providerDisplay = formatProviderDisplayName(
    contextQuery.data?.provider ?? thread?.session?.providerName ?? null,
  );
  const modelDisplay = thread?.modelSelection.model ?? "—";
  const usedPercentage = usage?.usedPercentage ?? null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
        <span className="truncate text-sm font-medium text-foreground">{t("context.title")}</span>
        <button
          type="button"
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50"
          onClick={() => contextQuery.refresh()}
          disabled={contextQuery.isPending}
          aria-label={t("context.refresh")}
        >
          <RefreshCw className={cn("size-3.5", contextQuery.isPending && "animate-spin")} />
        </button>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-5 p-3">
          <section className="grid grid-cols-2 gap-x-4 gap-y-3">
            <InfoCell label={t("context.session")} value={thread?.title ?? "—"} />
            <InfoCell label={t("context.messageCount")} value={String(messages.length)} mono />
            <InfoCell label={t("context.provider")} value={providerDisplay} />
            <InfoCell label={t("context.model")} value={modelDisplay} />
            <InfoCell
              label={t("context.contextLimit")}
              value={usage?.maxTokens != null ? usage.maxTokens.toLocaleString() : "—"}
              mono
            />
            <InfoCell
              label={t("context.totalTokens")}
              value={usage != null ? usage.usedTokens.toLocaleString() : "—"}
              mono
            />
            <InfoCell
              label={t("context.usageRate")}
              value={usedPercentage != null ? formatPercent(usedPercentage) : "—"}
              mono
            />
            <InfoCell
              label={t("context.inputTokens")}
              value={usage?.inputTokens != null ? usage.inputTokens.toLocaleString() : "—"}
              mono
            />
            <InfoCell
              label={t("context.outputTokens")}
              value={usage?.outputTokens != null ? usage.outputTokens.toLocaleString() : "—"}
              mono
            />
            <InfoCell
              label={t("context.reasoningTokens")}
              value={
                usage?.reasoningOutputTokens != null
                  ? usage.reasoningOutputTokens.toLocaleString()
                  : "—"
              }
              mono
            />
            <InfoCell
              label={t("context.cachedTokens")}
              value={
                usage?.cachedInputTokens != null ? usage.cachedInputTokens.toLocaleString() : "—"
              }
              mono
            />
            <InfoCell label={t("context.userMessages")} value={String(messageCounts.user)} mono />
            <InfoCell
              label={t("context.assistantMessages")}
              value={String(messageCounts.assistant)}
              mono
            />
            <InfoCell
              label={t("context.createdAt")}
              value={
                thread != null ? formatTimestamp(thread.createdAt, settings.timestampFormat) : "—"
              }
            />
            <InfoCell
              label={t("context.lastActive")}
              value={
                thread != null ? formatTimestamp(thread.updatedAt, settings.timestampFormat) : "—"
              }
            />
          </section>

          <section className="flex flex-col gap-2">
            <span className="text-muted-foreground/70 text-xs">{t("context.breakdown")}</span>
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted/60">
              {breakdown.total > 0 ? (
                (Object.keys(BREAKDOWN_COLORS) as BreakdownCategory[]).map((category) => {
                  const percent = (breakdown.sizes[category] / breakdown.total) * 100;
                  if (percent <= 0) return null;
                  return (
                    <div
                      key={category}
                      className="h-full"
                      style={{
                        width: `${percent}%`,
                        backgroundColor: BREAKDOWN_COLORS[category],
                      }}
                    />
                  );
                })
              ) : (
                <div className="h-full w-full bg-muted-foreground/20" />
              )}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
              {(Object.keys(BREAKDOWN_COLORS) as BreakdownCategory[]).map((category) => {
                const percent =
                  breakdown.total > 0 ? (breakdown.sizes[category] / breakdown.total) * 100 : 0;
                return (
                  <span key={category} className="inline-flex items-center gap-1.5">
                    <span
                      className="size-2 rounded-full"
                      style={{ backgroundColor: BREAKDOWN_COLORS[category] }}
                    />
                    {t(`context.breakdown.${category}`)} {formatPercent(percent)}
                  </span>
                );
              })}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <span className="text-muted-foreground/70 text-xs">
              {t("context.rawMessages", { count: messages.length })}
            </span>
            {contextQuery.error != null ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                {contextQuery.error}
              </div>
            ) : messages.length === 0 ? (
              <div className="rounded-md border border-border/60 px-3 py-6 text-center text-xs text-muted-foreground">
                {contextQuery.isPending ? t("context.loading") : t("context.empty")}
              </div>
            ) : (
              <div className="flex flex-col gap-1.5">
                {messages.map((message) => (
                  <RawMessageRow
                    key={message.id}
                    message={message}
                    timestampFormat={settings.timestampFormat}
                    defaultOpen={false}
                  />
                ))}
              </div>
            )}
            {usage != null && usage.maxTokens != null ? (
              <div className="text-muted-foreground/50 text-xs tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)} /{" "}
                {formatContextWindowTokens(usage.maxTokens)}
              </div>
            ) : null}
          </section>
        </div>
      </ScrollArea>
    </div>
  );
}

export default ContextPanel;
