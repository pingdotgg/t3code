import type { OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { GitForkIcon, HammerIcon, MinusIcon, XIcon, ZapIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { formatShortTimestamp } from "../../timestampFormat";

const LIFECYCLE_TYPES = new Set<OrchestrationV2TurnItem["type"]>([
  "run_interrupt_request",
  "run_interrupt_result",
  "compaction",
  "handoff",
  "fork",
  "subagent",
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
      <SystemDivider label="Run interrupted" detail={item.message} tone="danger" icon={XIcon} />
    );
  }
  if (item.type === "compaction") {
    const tokenDetail =
      item.beforeTokenCount === undefined && item.afterTokenCount === undefined
        ? null
        : `${item.beforeTokenCount ?? "?"} → ${item.afterTokenCount ?? "?"} tokens`;
    return (
      <SystemDivider
        label="Context compacted"
        detail={item.summary ?? tokenDetail}
        icon={MinusIcon}
      />
    );
  }
  if (item.type === "handoff") {
    return (
      <SystemDivider
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
      <SystemDivider
        label={item.source.type === "run" ? "Forked from conversation" : "Conversation fork"}
        icon={GitForkIcon}
        actionLabel={item.source.type === "run" ? "Open source conversation" : "Open fork"}
        onAction={() => props.onOpenThread(relatedThreadId)}
      />
    );
  }
  if (item.type === "subagent") {
    const content = (
      <>
        <HammerIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-xs font-medium">
          {item.title ?? "Subagent"}
        </span>
        <span className="max-w-[50%] truncate text-xs text-muted-foreground">
          {item.result ?? item.prompt}
        </span>
        <span className="rounded-full border border-border/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
          {item.status}
        </span>
      </>
    );
    return item.childThreadId === null ? (
      <div className="flex min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card/30 px-3 py-2">
        {content}
      </div>
    ) : (
      <button
        type="button"
        onClick={() => item.childThreadId && props.onOpenThread(item.childThreadId)}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-border/60 bg-card/30 px-3 py-2 text-left transition-colors hover:bg-muted/50"
      >
        {content}
      </button>
    );
  }
  return null;
}

function SystemDivider(props: {
  readonly label: string;
  readonly detail?: string | null;
  readonly tone?: "neutral" | "danger";
  readonly icon?: typeof GitForkIcon;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  const Icon = props.icon;
  const content = (
    <>
      {Icon ? <Icon className="size-3 shrink-0" /> : null}
      <span className="font-medium">{props.label}</span>
      {props.detail ? <span className="max-w-80 truncate opacity-70">· {props.detail}</span> : null}
    </>
  );
  return (
    <div
      className={cn(
        "flex min-w-0 items-center gap-2 py-2 text-[11px] text-muted-foreground",
        props.tone === "danger" && "text-destructive",
      )}
    >
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
      {props.onAction ? (
        <button
          type="button"
          onClick={props.onAction}
          className="flex min-w-0 items-center gap-1.5 rounded-full border border-border/70 bg-background px-2.5 py-1 transition-colors hover:bg-muted"
          title={props.actionLabel}
        >
          {content}
        </button>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 rounded-full px-2 py-1">{content}</span>
      )}
      <span aria-hidden="true" className="h-px flex-1 bg-border/70" />
    </div>
  );
}
