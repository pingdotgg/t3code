import { Fragment } from "react";
import type {
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
  ThreadId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  ArrowRightLeftIcon,
  ArrowRightIcon,
  BotIcon,
  GitForkIcon,
  MessageSquareIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";

import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { cn } from "../../lib/utils";
import { getProviderInstanceEntry } from "../../providerInstances";
import { formatShortTimestamp } from "../../timestampFormat";
import { PROVIDER_ICON_BY_PROVIDER, getTriggerDisplayModelName } from "./providerIconUtils";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { T3Wordmark } from "../T3Wordmark";

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

// Once a subagent stops, its last streamed result says more than the stale
// progress line; while it runs, live progress comes first.
const TERMINAL_SUBAGENT_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/**
 * The subset of a projection run that handoff rows read. Kept minimal so the
 * timeline can hold a content-stable snapshot: run status/timestamps churn on
 * every stream event, but these fields only change when a run is added.
 */
export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export function V2LifecycleRow(props: {
  readonly item: OrchestrationV2TurnItem;
  readonly resourceSummary?: boolean | undefined;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly providerStatuses: ReadonlyArray<ServerProvider>;
  readonly runs: ReadonlyArray<HandoffTimelineRun>;
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
    const label =
      item.status === "failed"
        ? "Context compaction failed"
        : item.status === "cancelled" || item.status === "interrupted"
          ? "Context compaction stopped"
          : item.status === "pending" || item.status === "running" || item.status === "waiting"
            ? "Compacting context"
            : "Context compacted";
    return (
      <TimelineSystemDivider label={label} detail={item.summary ?? tokenDetail} icon={MinusIcon} />
    );
  }
  if (item.type === "handoff") {
    // Items persisted before models were stamped only carry instance ids;
    // recover the models from the thread's runs (the handoff's own run is
    // the target, the newest earlier run per source instance is the origin).
    // HandoffEndpoint falls back to the provider display name when neither
    // source has a model.
    const handoffRun =
      item.runId === null ? undefined : props.runs.find((run) => run.id === item.runId);
    const toModel =
      item.toModel ??
      (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
        ? handoffRun.modelSelection.model
        : undefined);
    const fromEndpoints: ReadonlyArray<{
      readonly instanceId: ProviderInstanceId;
      readonly model?: string | undefined;
    }> =
      item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
        ? item.fromModelSelections
        : item.fromProviderInstanceIds.map((instanceId) => ({
            instanceId,
            model: latestRunModelBefore(props.runs, instanceId, handoffRun?.ordinal),
          }));
    return (
      <TimelineSystemDivider
        label="Context handoff"
        icon={ArrowRightLeftIcon}
        showDetailSeparator={false}
        tone={item.status === "failed" ? "danger" : "neutral"}
        detail={
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {fromEndpoints.map((endpoint, index) => (
              <Fragment key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}>
                {index > 0 ? (
                  <span aria-hidden="true" className="-ml-1">
                    ,
                  </span>
                ) : null}
                <HandoffEndpoint
                  providers={props.providerStatuses}
                  instanceId={endpoint.instanceId}
                  model={endpoint.model}
                />
              </Fragment>
            ))}
            {fromEndpoints.length > 0 ? (
              <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
            ) : null}
            <HandoffEndpoint
              providers={props.providerStatuses}
              instanceId={item.toProviderInstanceId}
              model={toModel}
            />
          </span>
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
    if (props.resourceSummary) {
      return (
        <div
          data-v2-item-type={item.type}
          className="flex min-w-0 items-center gap-3 rounded-lg border border-border/60 p-3"
        >
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60">
            <MessageSquareIcon className="size-4 text-secondary-label" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium">
            {item.title ?? "Created thread"}
          </span>
          <button
            type="button"
            aria-label={`Open ${item.title ?? "created thread"}`}
            onClick={() => props.onOpenThread(item.targetThreadId)}
            className="shrink-0 rounded-md border border-border px-2.5 py-1 text-sm hover:bg-accent/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Open chat
          </button>
        </div>
      );
    }
    return (
      <div
        className="flex min-w-0 items-center gap-1.5 px-0.5 py-0.5 text-sm leading-relaxed text-secondary-label"
        data-v2-item-type={item.type}
      >
        <span className="flex size-6 shrink-0 items-center justify-center">
          <T3Wordmark className="size-4 text-icon-muted" aria-hidden />
        </span>
        <span className="min-w-0 flex-1 truncate">
          Created thread{item.title ? ` · ${item.title}` : ""}
        </span>
        <button
          type="button"
          aria-label={`Open ${item.title ?? "created thread"}`}
          onClick={() => props.onOpenThread(item.targetThreadId)}
          className="shrink-0 rounded-sm text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open chat
        </button>
      </div>
    );
  }
  if (item.type === "subagent") {
    const streamedResult = item.result?.trim() ? item.result : null;
    const detail = TERMINAL_SUBAGENT_STATUSES.has(item.status)
      ? (streamedResult ?? item.progress ?? item.prompt)
      : (item.progress ?? streamedResult ?? item.prompt);
    return (
      <SubagentTimelineLink
        status={item.status}
        title={subagentDisplayTitle(item.title ?? "Subagent")}
        detail={detail}
        threadId={item.childThreadId}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  return null;
}

function SubagentTimelineLink(props: {
  readonly title: string;
  readonly detail: string;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const threadId = props.threadId;
  const statusLabel = props.status.replaceAll("_", " ");
  const content = (
    <>
      <span className="relative flex size-6 shrink-0 items-center justify-center">
        <BotIcon className="size-4 text-icon-muted" aria-hidden />
        <span
          role="img"
          aria-label={statusLabel}
          className={cn(
            "absolute right-0.5 bottom-0.5 size-1.5 rounded-full ring-2 ring-background",
            props.status === "failed"
              ? "bg-destructive"
              : props.status === "completed"
                ? "bg-success"
                : props.status === "cancelled" || props.status === "interrupted"
                  ? "bg-muted-foreground/60"
                  : "bg-info",
          )}
        />
      </span>
      <span className="min-w-0 truncate">{props.title}</span>
    </>
  );
  return (
    <div
      data-v2-item-type="subagent"
      className="flex min-w-0 max-w-full items-center gap-0.5 text-sm text-secondary-label"
    >
      <Tooltip>
        <TooltipTrigger
          render={
            threadId === null ? (
              <span
                aria-description={`${statusLabel}: ${props.detail}`}
                className="flex min-w-0 items-center gap-1.5 px-0.5 py-0.5 leading-relaxed"
              >
                {content}
              </span>
            ) : (
              <button
                type="button"
                aria-label={`Open ${props.title}`}
                aria-description={`${statusLabel}: ${props.detail}`}
                onClick={() => props.onOpenThread(threadId)}
                className="flex min-w-0 items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left leading-relaxed hover:bg-accent/20 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {content}
              </button>
            )
          }
        />
        <TooltipPopup className="max-w-80 whitespace-pre-wrap break-words">
          {props.title} · {statusLabel}
          {props.detail ? `\n${props.detail}` : ""}
        </TooltipPopup>
      </Tooltip>
    </div>
  );
}

function subagentDisplayTitle(title: string): string {
  return title.replace(/^Subagent:\s*/i, "");
}

/**
 * Model of the newest run for `instanceId` that started before the handoff's
 * own run. Legacy handoff items don't record their source models, but the
 * covered runs are still in the projection.
 */
function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}

/** Provider icon with the resolved handoff model available on hover or focus. */
function HandoffEndpoint(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
}) {
  const entry = getProviderInstanceEntry(props.providers, props.instanceId);
  const Icon =
    Object.entries(PROVIDER_ICON_BY_PROVIDER).find(
      ([driver]) => driver === (entry?.driverKind ?? props.instanceId),
    )?.[1] ?? BotIcon;
  const model = props.model?.trim();
  const providerModel =
    model === undefined || model.length === 0
      ? undefined
      : entry?.models.find((candidate) => candidate.slug === model);
  const label =
    providerModel !== undefined
      ? getTriggerDisplayModelName(providerModel)
      : model !== undefined && model.length > 0
        ? model
        : (entry?.displayName ?? props.instanceId);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            role="img"
            aria-label={label}
            className="inline-flex shrink-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Icon aria-hidden="true" className="size-3 shrink-0" />
          </span>
        }
      />
      <TooltipPopup>{label}</TooltipPopup>
    </Tooltip>
  );
}
