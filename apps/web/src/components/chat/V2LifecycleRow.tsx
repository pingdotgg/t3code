import { ThreadHoverCardPopup } from "../ThreadHoverCard";
import { AgentElapsed } from "./AgentElapsed";
import { projectedSubagentsToRuntime } from "@t3tools/client-runtime/state/subagentRuntime";
import type { ReactNode } from "react";
import { useThreadShell, useProject } from "../../state/entities";
import { SubagentTooltipContent } from "./SubagentTooltipContent";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef, scopeProjectRef } from "@t3tools/client-runtime/environment";
import { environmentThreadDetails } from "../../state/threads";
import { MiddleTruncate } from "../ui/middle-truncate";
import * as DateTime from "effect/DateTime";
import { WorkLogRow } from "./WorkLog";
import { resolveHandoffEndpoints, type HandoffTimelineRun } from "@t3tools/client-runtime/handoff";
import { Fragment } from "react";
import { formatSubagentDisplayTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  ProviderDriverKind,
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
import { getProviderInstanceEntry } from "../../providerInstances";
import { formatShortTimestamp } from "../../timestampFormat";
import { getTriggerDisplayModelName } from "./providerIconUtils";
import { ProviderInstanceIcon, providerTextColorClassName } from "./ProviderInstanceIcon";
import { cn } from "~/lib/utils";
import { TimelineSystemDivider } from "./TimelineSystemDivider";
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
    const { from: fromEndpoints, to } = resolveHandoffEndpoints(item, props.runs);
    return (
      <TimelineSystemDivider
        label="Context handoff"
        icon={ArrowRightLeftIcon}
        showDetailSeparator={false}
        tone={item.status === "failed" ? "danger" : "neutral"}
        detail={
          <span className="inline-flex min-w-0 flex-wrap items-center justify-center gap-1.5">
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
              model={to.model}
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
        provider={props.providerStatuses.find(
          (provider) => provider.instanceId === item.providerInstanceId,
        )}
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

/**
 * In-flight states all present as Working, the way the agents fleet view did:
 * detail belongs in the activity line, and a waiting or queued subagent is
 * still the fleet doing its job. Only settled states differentiate. Idle reads
 * as settled rather than in progress, since a resting child looks done unless
 * resumed.
 */
const STATUS_VISUALS: Record<
  OrchestrationV2TurnItem["status"],
  { dotClass: string; label: string }
> = {
  pending: { dotClass: "bg-info", label: "Working" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Working" },
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

/** The server's placeholder when a child ends without output; the status dot already says it. */
const GENERIC_CHILD_END = /^Child task ended with status\b/i;

/** One line of a markdown result: drop list bullets, code ticks, and link targets. */
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

/** Round provider tile with the agents panel's status dot; rings let a header stack overlap. */
export function SubagentAvatar({
  driver,
  provider,
  status,
  className,
}: {
  driver?: ProviderDriverKind | undefined;
  provider?: ServerProvider | undefined;
  /** Omitted inside an overlapped stack, where a covered dot would only add noise. */
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
          displayName={provider?.displayName ?? driver}
          acpRegistryIconUrl={provider?.iconUrl}
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

function SubagentTimelineLink(props: {
  readonly parentRef: ScopedThreadRef;
  readonly subagentId: NodeId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly origin: OrchestrationV2Subagent["origin"];
  readonly driver: ProviderDriverKind;
  readonly provider: ServerProvider | undefined;
  readonly title: string;
  readonly result: string | null;
  readonly progress: string | undefined;
  readonly status: OrchestrationV2TurnItem["status"];
  readonly startedAt: DateTime.Utc | null;
  readonly completedAt: DateTime.Utc | null;
  readonly threadId: ThreadId | null;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const agent = useAtomValue(
    environmentThreadDetails.threadAtom(props.parentRef),
    (thread) => thread?.projection.subagents.find((agent) => agent.id === props.subagentId) ?? null,
  );
  const threadId = props.threadId;
  const status = agent?.status ?? props.status;
  const statusLabel = subagentStatusVisual(status).label;
  const result = (agent?.result ?? props.result)?.trim();
  const progress = (agent?.progress ?? props.progress)?.trim();
  const settled = SETTLED_SUBAGENT_STATUSES.has(status);
  const rawDetail = settled ? result || progress : progress || result;
  const detail =
    rawDetail && !GENERIC_CHILD_END.test(rawDetail) ? plainDetail(rawDetail) || null : null;
  const failed = status === "failed";
  const timing = {
    status,
    startedAt: isoOrNull(agent?.startedAt ?? props.startedAt),
    completedAt: isoOrNull(agent?.completedAt ?? props.completedAt),
  };
  const content = (
    <>
      <SubagentAvatar driver={props.driver} provider={props.provider} status={status} />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {props.title}
          </span>
          {detail !== null && status !== "completed" ? (
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
      <span className="shrink-0 font-mono text-3xs text-muted-foreground/80">
        <SubagentElapsed agent={timing} />
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
          status={status}
          result={agent?.result ?? props.result}
          progress={agent?.progress ?? props.progress}
        />
      </ThreadHoverCardPopup>
    </Tooltip>
  );
}

function SubagentTimelineTooltip(
  props: Parameters<typeof SubagentTimelineLink>[0] & { model: string | null; elapsed: ReactNode },
) {
  const environmentId = props.parentRef.environmentId;
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
      provider={props.provider}
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

function HandoffEndpoint(props: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId;
  readonly model?: string | undefined;
}) {
  const entry = getProviderInstanceEntry(props.providers, props.instanceId);
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
            className="inline-flex min-w-0 items-center gap-1 rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ProviderInstanceIcon
              driverKind={entry?.driverKind ?? ProviderDriverKind.make(props.instanceId)}
              displayName={entry?.displayName ?? props.instanceId}
              acpRegistryAgentId={entry?.acpRegistryAgentId}
              acpRegistryIconUrl={entry?.acpRegistryIconUrl}
              iconClassName="size-3"
            />
            <span
              className={cn(
                "truncate font-medium",
                providerTextColorClassName(
                  entry?.driverKind ?? ProviderDriverKind.make(props.instanceId),
                ),
              )}
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
