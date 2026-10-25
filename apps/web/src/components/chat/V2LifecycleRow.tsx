import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { AgentElapsed } from "./AgentElapsed";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ReactNode } from "react";
import { useThreadShell, useProject } from "../../state/entities";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { environmentThreadDetails } from "../../state/threads";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { MiddleTruncate } from "../ui/middle-truncate";
import * as DateTime from "effect/DateTime";
import { WorkLogRow } from "./WorkLog";
import {
  resolveHandoffEndpoints,
  type HandoffEndpoints,
  type HandoffTimelineRun,
} from "@t3tools/client-runtime/handoff";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  ProviderDriverKind,
  type OrchestrationV2Notification,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Subagent,
  type ProviderInstanceId,
  type ServerProvider,
  type ThreadId,
  type EnvironmentId,
  type NodeId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import {
  BotIcon,
  ChevronRightIcon,
  ArrowRightLeftIcon,
  ArrowRightIcon,
  GitForkIcon,
  MessageSquareIcon,
  MinusIcon,
  XIcon,
} from "lucide-react";

import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { formatShortTimestamp } from "../../timestampFormat";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import { ProviderInstanceIcon, providerTextColor } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
import { subagentResumedSince } from "./V2LifecycleRow.logic";
import { Button, InlineButton } from "../ui/button";
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

export type { HandoffTimelineRun } from "@t3tools/client-runtime/handoff";

export function V2LifecycleRow(props: {
  readonly item: OrchestrationV2TurnItem;
  readonly environmentId: EnvironmentId;
  readonly resourceSummary?: boolean | undefined;
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
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
          <span className="text-3xs text-muted-foreground">
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
    return (
      <EnvironmentHandoffRow
        environmentId={props.environmentId}
        endpoints={resolveHandoffEndpoints(item, props.runs)}
        failed={item.status === "failed"}
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
          <Button
            size="xs"
            variant="outline"
            aria-label={`Open ${item.title ?? "created thread"}`}
            onClick={() => props.onOpenThread(item.targetThreadId)}
          >
            Open chat
          </Button>
        </div>
      );
    }
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<T3Wordmark className="size-4 text-icon-muted" aria-hidden />}
        label={<>Created thread{item.title ? ` · ${item.title}` : ""}</>}
        trailing={
          <InlineButton
            aria-label={`Open ${item.title ?? "created thread"}`}
            onClick={() => props.onOpenThread(item.targetThreadId)}
          >
            Open chat
          </InlineButton>
        }
      />
    );
  }
  if (item.type === "subagent") {
    return (
      <SubagentTimelineLink
        parentRef={scopeThreadRef(props.environmentId, item.threadId)}
        subagentId={item.subagentId}
        providerInstanceId={item.providerInstanceId}
        origin={item.origin}
        status={item.status}
        driver={item.driver}
        title={formatSubagentDisplayTitle(item.title ?? "Subagent")}
        result={item.result}
        progress={item.progress}
        startedAt={item.startedAt}
        completedAt={item.completedAt}
        threadId={item.childThreadId}
        onOpenThread={props.onOpenThread}
      />
    );
  }
  return null;
}

const STATUS_VISUALS: Record<
  OrchestrationV2TurnItem["status"],
  { dotClass: string; label: string }
> = {
  pending: { dotClass: "bg-info", label: "Queued" },
  running: { dotClass: "bg-info", label: "Running" },
  waiting: { dotClass: "bg-info", label: "Waiting" },
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function subagentStatusVisual(status: OrchestrationV2TurnItem["status"]) {
  return STATUS_VISUALS[status];
}

const SETTLED_SUBAGENT_STATUSES = new Set<OrchestrationV2TurnItem["status"]>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

const GENERIC_CHILD_END = /^Child task ended with status\b/i;

function plainDetail(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`/g, "")
    .replace(/^[ \t]*[-*][ \t]+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isoOrNull(value: DateTime.Utc | null | undefined): string | null {
  return value ? DateTime.formatIso(value) : null;
}

export function SubagentElapsed({ agent }: { agent: Parameters<typeof AgentElapsed>[0]["agent"] }) {
  return <AgentElapsed agent={agent} />;
}

function SubagentAvatar({
  driver,
  displayName,
  iconUrl,
  status,
  className,
}: {
  driver?: ProviderDriverKind | undefined;
  displayName?: string | undefined;
  iconUrl?: string | undefined;
  status?: OrchestrationV2TurnItem["status"] | undefined;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "relative inline-flex size-6 shrink-0 items-center justify-center rounded-full border border-border/70 bg-muted ring-2 ring-background",
        className,
      )}
    >
      {driver ? (
        <ProviderInstanceIcon
          driverKind={driver}
          displayName={displayName ?? driver}
          acpRegistryIconUrl={iconUrl}
          className="z-auto"
          iconClassName="size-3.5"
        />
      ) : (
        <BotIcon className="size-3.5 text-muted-foreground" />
      )}
      {status ? (
        <span
          className={cn(
            "absolute -right-px -bottom-px size-2 rounded-full ring-2 ring-background",
            subagentStatusVisual(status).dotClass,
          )}
        />
      ) : null}
    </span>
  );
}

// Select strings; status pushes replace providers even when avatar fields are unchanged.
export function EnvironmentSubagentAvatar({
  environmentId,
  providerInstanceId,
  ...props
}: {
  environmentId: EnvironmentId;
  providerInstanceId: ProviderInstanceId;
  driver?: ProviderDriverKind | undefined;
  status?: OrchestrationV2TurnItem["status"] | undefined;
}) {
  const providersAtom = serverEnvironment.providersValueAtom(environmentId);
  const displayName = useAtomValue(
    providersAtom,
    (providers) =>
      providers?.find((provider) => provider.instanceId === providerInstanceId)?.displayName,
  );
  const iconUrl = useAtomValue(
    providersAtom,
    (providers) =>
      providers?.find((provider) => provider.instanceId === providerInstanceId)?.iconUrl,
  );
  return <SubagentAvatar {...props} displayName={displayName} iconUrl={iconUrl} />;
}

const NOTIFICATION_OUTCOME_STATUS: Record<
  OrchestrationV2Notification["outcome"],
  OrchestrationV2TurnItem["status"] | null
> = {
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled",
  updated: null,
  unknown: null,
};

const NOTIFICATION_OUTCOME_LABEL: Record<OrchestrationV2Notification["outcome"], string> = {
  completed: "Finished",
  failed: "Failed",
  cancelled: "Stopped",
  updated: "Updated",
  unknown: "Finished",
};

export function SubagentNotificationLink(props: {
  readonly parentRef: ScopedThreadRef;
  readonly childThreadId: ThreadId;
  readonly outcome: OrchestrationV2Notification["outcome"];
  readonly createdAt: string;
  readonly timestampFormat: TimestampFormat;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly fallback: ReactNode;
}) {
  const agent = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) =>
      thread?.projection.subagents.find((agent) => agent.childThreadId === props.childThreadId) ??
      null,
  );
  if (agent === null) return props.fallback;
  const resumed =
    NOTIFICATION_OUTCOME_STATUS[props.outcome] !== null &&
    subagentResumedSince(agent, props.createdAt);
  return (
    <SubagentTimelineLink
      parentRef={props.parentRef}
      subagentId={agent.id}
      providerInstanceId={agent.providerInstanceId}
      origin={agent.origin}
      status={agent.status}
      driver={agent.driver}
      title={formatSubagentDisplayTitle(agent.title ?? "Subagent")}
      result={agent.result}
      progress={agent.progress}
      startedAt={agent.startedAt}
      completedAt={agent.completedAt}
      threadId={props.childThreadId}
      onOpenThread={props.onOpenThread}
      {...(resumed
        ? {}
        : {
            event: {
              status: NOTIFICATION_OUTCOME_STATUS[props.outcome],
              label: NOTIFICATION_OUTCOME_LABEL[props.outcome],
              timestamp: formatShortTimestamp(props.createdAt, props.timestampFormat),
            },
          })}
    />
  );
}

function SubagentTimelineLink(props: {
  readonly parentRef: ScopedThreadRef;
  readonly subagentId: NodeId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly driver: ProviderDriverKind;
  readonly title: string;
  readonly result: string | null;
  readonly progress: string | undefined;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly event?: {
    readonly status: OrchestrationV2TurnItem["status"] | null;
    readonly label: string;
    readonly timestamp: string;
  };
}) {
  const agent = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) => thread?.projection.subagents.find((agent) => agent.id === props.subagentId) ?? null,
  );
  const threadId = props.threadId;
  const liveStatus = agent?.status ?? props.status;
  const status = props.event ? props.event.status : liveStatus;
  const statusLabel = props.event?.label ?? subagentStatusVisual(liveStatus).label;
  const result = (agent?.result ?? props.result)?.trim();
  const progress = (agent?.progress ?? props.progress)?.trim();
  const settled = SETTLED_SUBAGENT_STATUSES.has(status ?? liveStatus);
  const rawDetail = settled ? result || progress : progress || result;
  const detail =
    rawDetail && !GENERIC_CHILD_END.test(rawDetail) ? plainDetail(rawDetail) || null : null;
  const failed = status === "failed";
  const timing = {
    status: liveStatus,
    startedAt: isoOrNull(agent?.startedAt ?? props.startedAt),
    completedAt: isoOrNull(agent?.completedAt ?? props.completedAt),
  };
  const content = (
    <>
      <EnvironmentSubagentAvatar
        environmentId={props.parentRef.environmentId}
        providerInstanceId={props.providerInstanceId}
        driver={props.driver}
        status={status ?? undefined}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {props.title}
          </span>
          {detail !== null && (props.event !== undefined || status !== "completed") ? (
            <span
              className={cn(
                "shrink-0 text-3xs",
                failed ? "text-destructive" : "text-muted-foreground",
              )}
            >
              {statusLabel}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "block text-2xs leading-relaxed",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {detail === null ? (
            statusLabel
          ) : detail.includes("/") && !detail.includes(" ") ? (
            <MiddleTruncate value={detail} showTitle={false} className="flex" />
          ) : (
            <span className="block truncate">{detail}</span>
          )}
        </span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {props.event ? props.event.timestamp : <SubagentElapsed agent={timing} />}
      </span>
      {threadId !== null ? (
        <ChevronRightIcon
          aria-hidden
          className="size-3.5 shrink-0 text-muted-foreground/60 transition-colors group-hover/subagent:text-foreground"
        />
      ) : null}
    </>
  );
  const className =
    "group/subagent flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left";
  return (
    <Tooltip>
      <TooltipTrigger
        delay={200}
        render={
          threadId === null ? (
            <div data-v2-item-type="subagent" aria-description={statusLabel} className={className}>
              {content}
            </div>
          ) : (
            <button
              type="button"
              data-v2-item-type="subagent"
              aria-label={`Open ${props.title}`}
              aria-description={statusLabel}
              onClick={() => props.onOpenThread(threadId)}
              className={cn(
                className,
                "cursor-pointer transition-colors hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
              )}
            >
              {content}
            </button>
          )
        }
      />
      <ThreadHoverCardPopup>
        <SubagentTimelineTooltip
          {...props}
          elapsed={agent ? <AgentElapsed agent={projectedSubagentsToRuntime([agent])[0]!} /> : null}
          model={agent?.model ?? null}
          modelSelection={agent?.modelSelection}
          status={liveStatus}
          result={agent?.result ?? props.result}
          progress={agent?.progress ?? props.progress}
        />
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}

function SubagentTimelineTooltip(
  props: Parameters<typeof SubagentTimelineLink>[0] & {
    model: string | null;
    modelSelection: OrchestrationV2Subagent["modelSelection"];
    elapsed: ReactNode;
  },
) {
  const environmentId = props.parentRef.environmentId;
  // Read providers only in the open popup to avoid per-row subscriptions.
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  const parent = useThreadShell(props.parentRef)?.source;
  const child = useThreadShell(
    props.threadId ? scopeThreadRef(environmentId, props.threadId) : null,
  )?.source;
  const parentProject = useProject(
    parent ? scopeProjectRef(environmentId, parent.projectId) : null,
  );
  const childProject = useProject(child ? scopeProjectRef(environmentId, child.projectId) : null);
  return (
    <SubagentTooltipContent
      title={formatSubagentDisplayTitle(child?.title ?? props.title)}
      model={props.model}
      providerInstanceId={props.providerInstanceId}
      origin={props.origin}
      modelSelection={props.modelSelection}
      provider={providers.find((provider) => provider.instanceId === props.providerInstanceId)}
      providers={providers}
      driver={props.driver}
      elapsed={props.elapsed}
      status={props.status}
      result={props.result}
      progress={props.progress}
      parentThread={parent}
      childThread={child}
      parentProject={parentProject ?? undefined}
      childProject={childProject ?? undefined}
    />
  );
}

function EnvironmentHandoffRow({
  environmentId,
  ...props
}: {
  readonly environmentId: EnvironmentId;
  readonly endpoints: HandoffEndpoints;
  readonly failed: boolean;
}) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? EMPTY_SERVER_PROVIDERS;
  return <HandoffRow {...props} environmentId={environmentId} providers={providers} />;
}

export function HandoffRow(props: {
  readonly environmentId: EnvironmentId;
  readonly endpoints: HandoffEndpoints;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly pending?: boolean;
  readonly failed?: boolean;
}) {
  const { from: fromEndpoints, to } = props.endpoints;
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(props.environmentId));
  const derived = deriveProviderInstanceEntries(props.providers);
  const entries = settings ? applyProviderInstanceSettings(derived, settings, null) : derived;
  return (
    <TimelineSystemDivider
      label={props.pending ? "Context handoff pending" : "Context handoff"}
      icon={ArrowRightLeftIcon}
      showDetailSeparator={false}
      tone={props.failed ? "danger" : "neutral"}
      detail={
        <span className="inline-flex min-w-0 flex-wrap items-center justify-center gap-1.5">
          {fromEndpoints.map((endpoint, index) => (
            <span
              key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}
              className="inline-flex min-w-0 items-center"
            >
              <HandoffEndpoint
                entries={entries}
                instanceId={endpoint.instanceId}
                model={endpoint.model}
              />
              {index < fromEndpoints.length - 1 ? (
                <span aria-hidden="true" className="ml-0.5">
                  ,
                </span>
              ) : null}
            </span>
          ))}
          {fromEndpoints.length > 0 ? (
            <ArrowRightIcon aria-hidden="true" className="size-3 shrink-0" />
          ) : null}
          <HandoffEndpoint entries={entries} instanceId={to.instanceId} model={to.model} />
        </span>
      }
    />
  );
}

function HandoffEndpoint(props: {
  readonly entries: ReadonlyArray<ProviderInstanceEntry>;
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
}) {
  const entry = props.entries.find((candidate) => candidate.instanceId === props.instanceId);
  const showBadge = entry !== undefined && shouldShowInstanceBadge(entry, props.entries);
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
  const labelColor = providerTextColor(
    entry?.driverKind ?? ProviderDriverKind.make(props.instanceId),
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            className="inline-flex min-w-0 items-center gap-1.5 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ProviderInstanceIcon
              driverKind={entry?.driverKind ?? ProviderDriverKind.make(props.instanceId)}
              displayName={entry?.displayName ?? props.instanceId}
              accentColor={entry?.accentColor}
              acpRegistryAgentId={entry?.acpRegistryAgentId}
              acpRegistryIconUrl={entry?.acpRegistryIconUrl}
              showBadge={showBadge}
              size="compact"
              iconClassName={cn(showBadge && "opacity-60")}
              indicatorBackground="var(--background)"
            />
            <span
              className={cn("truncate font-medium", labelColor.className)}
              style={labelColor.style}
            >
              {label}
            </span>
          </span>
        }
      />
      <TooltipPopup>
        {entry?.displayName ?? props.instanceId} · {label}
      </TooltipPopup>
    </Tooltip>
  );
}
