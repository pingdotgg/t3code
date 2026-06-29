import type { OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  BotIcon,
  ExternalLinkIcon,
  GitForkIcon,
  MessageSquareIcon,
  MinusIcon,
  type LucideIcon,
  XIcon,
  ZapIcon,
} from "lucide-react";

import { formatShortTimestamp } from "../../timestampFormat";
import { TimelineSystemDivider } from "./TimelineSystemDivider";

const LIFECYCLE_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "run_interrupt_request",
  "run_interrupt_result",
  "compaction",
  "handoff",
  "fork",
  "subagent",
  "thread_created",
]);

export function isV2LifecycleItem(item: OrchestrationV2TurnItem): boolean {
  return LIFECYCLE_TYPES.has(item.type);
}

export function V2LifecycleRow(props: {
  readonly item: OrchestrationV2TurnItem;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { item } = props;
  if (item.type === "run_interrupt_request") {
    return (
      <div className="flex justify-end px-1 py-1" data-v2-item-type={item.type}>
        <div className="flex max-w-[80%] items-center gap-2 text-xs text-destructive">
          <span aria-hidden="true" className="font-mono">
            ■
          </span>
          <span className="font-medium">Interrupt requested</span>
          <span aria-hidden="true" className="opacity-50">
            ·
          </span>
          <span className="font-medium">{item.message}</span>
          <span className="text-[10px] text-muted-foreground">
            {formatShortTimestamp(props.createdAt, props.timestampFormat)}
          </span>
        </div>
      </div>
    );
  }
  if (item.type === "run_interrupt_result") {
    return (
      <TimelineSystemDivider
        label="Run interrupted"
        detail={item.message}
        tone="danger"
        icon={XIcon}
      />
    );
  }
  if (item.type === "compaction") {
    const tokenDetail =
      item.beforeTokenCount === undefined && item.afterTokenCount === undefined
        ? null
        : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
    return (
      <TimelineSystemDivider
        label="Context compacted"
        detail={item.summary ?? tokenDetail}
        icon={MinusIcon}
      />
    );
  }
  if (item.type === "handoff") {
    return (
      <TimelineSystemDivider
        label="Context handoff"
        icon={ZapIcon}
        tone={item.status === "failed" ? "danger" : "neutral"}
        detail={
          item.summary ??
          `${item.fromProviderInstanceIds.join(", ")} → ${item.toProviderInstanceId}`
        }
      />
    );
  }
  if (item.type === "fork") {
    const relatedThreadId = item.source.type === "run" ? item.source.threadId : item.targetThreadId;
    return (
      <TimelineSystemDivider
        label={item.source.type === "run" ? "Forked from conversation" : "Conversation fork"}
        icon={GitForkIcon}
        actionLabel={item.source.type === "run" ? "Open source conversation" : "Open fork"}
        onAction={() => props.onOpenThread(relatedThreadId)}
      />
    );
  }
  if (item.type === "thread_created") {
    return (
      <RelatedThreadCard
        itemType={item.type}
        icon={MessageSquareIcon}
        title={item.title ?? "Created thread"}
        detail={`${item.targetProviderInstanceId} · ${item.targetModel}`}
        badge="created"
        threadId={item.targetThreadId}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  if (item.type === "subagent") {
    return (
      <RelatedThreadCard
        itemType={item.type}
        icon={BotIcon}
        title={subagentDisplayTitle(item.title ?? "Subagent")}
        detail={item.result ?? item.progress ?? item.prompt}
        badge={item.status}
        threadId={item.childThreadId}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  return null;
}

function RelatedThreadCard(props: {
  readonly itemType: "subagent" | "thread_created";
  readonly icon: LucideIcon;
  readonly title: string;
  readonly detail: string;
  readonly badge: string;
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const Icon = props.icon;
  const threadId = props.threadId;
  const content = (
    <>
      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate text-xs font-medium">{props.title}</span>
      <span className="max-w-[50%] truncate text-xs text-muted-foreground">{props.detail}</span>
      <span className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
        {props.badge}
      </span>
      {threadId === null ? null : (
        <ExternalLinkIcon className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
    </>
  );

  return threadId === null ? (
    <div
      data-v2-item-type={props.itemType}
      className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card/30 px-3 py-2"
    >
      {content}
    </div>
  ) : (
    <button
      type="button"
      data-v2-item-type={props.itemType}
      aria-label={`Open ${props.title}`}
      onClick={() => props.onOpenThread(threadId)}
      className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card/30 px-3 py-2 text-left transition-colors hover:bg-muted/50"
    >
      {content}
    </button>
  );
}

function subagentDisplayTitle(title: string): string {
  return title.replace(/^Subagent:\s*/i, "");
}
