import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderGoal,
  OrchestrationV2ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  presentPendingBackgroundWork,
  presentProviderGoal,
  type RunStopPresentation,
} from "@t3tools/client-runtime/state/thread-execution";
import { childThreadInputsTitle } from "@t3tools/client-runtime/state/threads";
import { commandDisplayText } from "@t3tools/client-runtime/work-log/command-label";
import { formatDuration } from "@t3tools/shared/orchestrationTimingCopy";
import * as DateTime from "effect/DateTime";
import { msg, T, Var } from "gt-react";
import {
  CircleDashedIcon,
  CircleStopIcon,
  GitBranchIcon,
  MessageCircleIcon,
  ShieldQuestionIcon,
  TargetIcon,
  TerminalIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { Fragment } from "react";
import { m, type MessageResolver } from "~/i18n/messages";
import { tickTextContent } from "~/lib/tickTextContent";
import { BackgroundWorkDetails } from "./BackgroundWorkDetails";
import { Button, InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { ThreadNowItem } from "./ThreadNow";

export function extensionStatusBannerItem(
  statuses: NonNullable<OrchestrationV2ProviderSession["extensionStatuses"]>,
): ComposerBannerStackItem | null {
  if (statuses.length === 0) return null;
  return {
    id: "pi-extension-status",
    variant: "default",
    icon: <span>▸</span>,
    title: <output>{`Pi · ${statuses.map((status) => status.text).join(" · ")}`}</output>,
  };
}

/** Subagents and side chats waiting on the user, unless the parent is itself waiting on them. */
export function childInputNowItem(
  input: {
    readonly childThreadInputs: ReadonlyArray<EnvironmentThreadShell>;
    readonly parentAwaitingUser: boolean;
    // A task delegated to a linked environment lives there, not where the parent runs.
    readonly onOpenThread: (threadId: ThreadId, environmentId: EnvironmentId) => void;
  },
  resolve: MessageResolver = m,
): (ThreadNowItem & { readonly waitingLabel: string }) | null {
  const { childThreadInputs, onOpenThread } = input;
  const first = childThreadInputs[0];
  if (!first || input.parentAwaitingUser) return null;
  return {
    id: `child-input:${first.id}`,
    // The only line at the end of the timeline that needs you gets the info color.
    icon: first.hasPendingApprovals ? (
      <ShieldQuestionIcon className="text-info-foreground" />
    ) : (
      <MessageCircleIcon className="text-info-foreground" />
    ),
    title: childThreadInputsTitle(childThreadInputs, resolve),
    waitingLabel: childThreadInputs.every((child) => child.lineage.sideChat === true)
      ? resolve(msg("Side chat waiting"))
      : resolve(msg("Subagent waiting")),
    description: childThreadInputs.map((child, index) => (
      <Fragment key={child.id}>
        {index > 0 ? " " : null}
        <span className="whitespace-nowrap">
          <InlineButton tone="muted" onClick={() => onOpenThread(child.id, child.environmentId)}>
            {child.title}
          </InlineButton>
          {index < childThreadInputs.length - 1 ? "," : null}
        </span>
      </Fragment>
    )),
    actions: (
      <InlineButton onClick={() => onOpenThread(first.id, first.environmentId)}>
        {first.hasPendingApprovals ? <T>Open approval</T> : <T>Open question</T>}
      </InlineButton>
    ),
  };
}

/** The thread's goal, for the end of the timeline. */
export function goalNowItem(
  input: {
    readonly threadId: ThreadId;
    readonly goal: OrchestrationV2ProviderGoal;
    readonly isWorking: boolean;
    readonly onSendCommand: (text: string, failureMessage: string) => Promise<void>;
  },
  resolve: MessageResolver = m,
): ThreadNowItem {
  const { isWorking, onSendCommand } = input;
  const presentation = presentProviderGoal(input.goal, isWorking, resolve);
  return {
    id: `goal:${input.threadId}`,
    icon: <TargetIcon />,
    title: (
      <Popover>
        <PopoverTrigger openOnHover render={<InlineButton />}>
          {presentation.title}
          {presentation.usage === null ? null : ` · ${presentation.usage}`}
        </PopoverTrigger>
        <PopoverPopup
          side="top"
          width="md"
          padding="compact"
          aria-label={resolve(msg("Goal objective"))}
        >
          <p className="whitespace-pre-wrap wrap-anywhere text-sm">{presentation.objective}</p>
        </PopoverPopup>
      </Popover>
    ),
    description: presentation.objective,
    // Clear stops goal work; Resume would stop unrelated work, so it waits.
    actions: (
      <>
        {presentation.canResume && !isWorking ? (
          <>
            <InlineButton
              onClick={() =>
                void onSendCommand("/goal resume", resolve(msg("Failed to resume goal.")))
              }
            >
              <T context="verb, resumes the goal">Resume</T>
            </InlineButton>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <InlineButton
          tone="muted"
          onClick={() => void onSendCommand("/goal clear", resolve(msg("Failed to clear goal.")))}
        >
          <T context="verb, clears the goal">Clear</T>
        </InlineButton>
      </>
    ),
  };
}

/** A Stop the provider has not finished; Force stop once it stops answering. */
export function runStopNowItem(input: {
  readonly threadId: ThreadId;
  readonly stop: RunStopPresentation;
  readonly canForceStop: boolean;
  readonly forceStopping: boolean;
  readonly onForceStop: () => void;
}): ThreadNowItem {
  const unresponsive = input.stop.state === "unresponsive";
  const requestedAtMs = Date.parse(input.stop.requestedAt);
  return {
    id: `run-stop:${input.threadId}`,
    icon: unresponsive ? (
      <TriangleAlertIcon className="text-warning-foreground" />
    ) : (
      <CircleStopIcon />
    ),
    title: unresponsive ? (
      <T>Agent not responding to Stop</T>
    ) : (
      <T context="run status">Stopping</T>
    ),
    description: unresponsive ? (
      <T>It may be short on memory. Force stop kills its processes.</T>
    ) : undefined,
    actions: (
      <>
        <span
          ref={tickTextContent(
            (nowMs) => formatDuration(Math.max(1_000, nowMs - requestedAtMs), m),
            true,
          )}
          className="tabular-nums"
        />
        {unresponsive && input.canForceStop ? (
          <InlineButton disabled={input.forceStopping} onClick={input.onForceStop}>
            {input.forceStopping ? <T>Force stopping...</T> : <T>Force stop</T>}
          </InlineButton>
        ) : null}
      </>
    ),
  };
}

/** Background commands and subagents, for the end of the timeline. */
export function backgroundWorkNowItem(
  input: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
    readonly turnItems: ThreadStructure["turnItems"];
    readonly stopDisabled: boolean;
    readonly stopping: boolean;
    readonly onStop: () => Promise<void>;
    readonly onOpenThread: (threadId: ThreadId) => void;
  },
  resolve: MessageResolver = m,
): ThreadNowItem | null {
  const { onOpenThread } = input;
  const presentation = presentPendingBackgroundWork(input.tasks, resolve);
  if (presentation === null) return null;
  const rows = presentation.items.map((task) => {
    const itemKey =
      input.tasks.find((pending) => pending.taskId === task.taskId)?.nativeItemId ?? task.taskId;
    // Same key derivePendingBackgroundWork gives turn-item tasks; subagent items carry progress.
    const item = input.turnItems.findLast(
      (candidate) => (candidate.nativeItemRef?.nativeId || candidate.id) === itemKey,
    );
    const subagent = item?.type === "subagent" ? item : undefined;
    return {
      task,
      label:
        item?.type === "command_execution" && commandDisplayText(item.input) === task.label ? (
          <span className="font-mono in-data-[slot=popover-popup]:whitespace-pre-wrap">
            {task.label}
          </span>
        ) : task.label.includes("\n") ? (
          <span className="in-data-[slot=popover-popup]:whitespace-pre-wrap">{task.label}</span>
        ) : (
          task.label
        ),
      activity: subagent?.progress?.replace(/\s+/gu, " ").trim() || null,
      startedAtMs: item?.startedAt ? DateTime.toEpochMillis(item.startedAt) : null,
      updatedAtMs: subagent ? DateTime.toEpochMillis(subagent.updatedAt) : 0,
    };
  });
  const [only] = rows.length === 1 ? rows : [];
  const newest = rows
    .filter((row) => row.activity)
    .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  const isCommand = (row: (typeof rows)[number]) => row.task.kind !== "subagent";
  const startedAtMs = only?.startedAtMs ?? null;
  return {
    id: `background-work:${input.threadId}`,
    icon: rows.every(isCommand) ? <TerminalIcon /> : <CircleDashedIcon />,
    title:
      only && typeof only.label !== "string" && only.task.label !== only.task.kind ? (
        <>
          {presentation.waiting ? (
            <T>
              Waiting · <Var>{only.label}</Var>
            </T>
          ) : (
            <T>
              Running · <Var>{only.label}</Var>
            </T>
          )}
        </>
      ) : (
        presentation.title
      ),
    description: only ? (
      only.activity
    ) : newest ? (
      <>
        {newest.label}: {newest.activity}
      </>
    ) : (
      rows.map((row, index) => (
        <Fragment key={row.task.taskId}>
          {index > 0 ? ", " : null}
          {row.label}
        </Fragment>
      ))
    ),
    actions: (
      <>
        {startedAtMs === null ? null : (
          <span
            ref={tickTextContent(
              (nowMs) => formatDuration(Math.max(1_000, nowMs - startedAtMs), m),
              true,
            )}
            className="tabular-nums"
          />
        )}
        <BackgroundWorkDetails
          environmentId={input.environmentId}
          threadId={input.threadId}
          tasks={input.tasks}
          turnItems={input.turnItems}
          onOpenThread={onOpenThread}
        />
        <InlineButton disabled={input.stopDisabled} onClick={() => void input.onStop()}>
          {input.stopping ? <T>Stopping...</T> : <T context="verb, stops background work">Stop</T>}
        </InlineButton>
      </>
    ),
  };
}

/** The local checkout moved off the branch this thread last ran on. */
export function branchMismatchBannerItem(
  input: {
    readonly refNoun: string;
    readonly mismatchKey: string;
    readonly mismatch: { readonly threadBranch: string; readonly currentBranch: string };
    readonly restoreDisabled: boolean;
    readonly restoring: boolean;
    readonly onRestore: () => void;
    readonly onDismiss: () => void;
  },
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  const { mismatch } = input;
  const branchTooltip = (
    <Tooltip>
      <TooltipTrigger
        render={
          <code className="min-w-0 truncate font-medium text-foreground">
            {mismatch.threadBranch}
          </code>
        }
      />
      <TooltipPopup side="top">
        <T>
          This thread last ran on <Var>{mismatch.threadBranch}</Var>. Sending will continue on{" "}
          <Var>{mismatch.currentBranch}</Var>.
        </T>
      </TooltipPopup>
    </Tooltip>
  );
  return {
    id: `branch-mismatch:${input.mismatchKey}`,
    variant: "info",
    icon: <GitBranchIcon />,
    title: (
      <span className="flex min-w-0 items-baseline gap-1.5">
        <T>
          <span className="shrink-0 font-normal text-muted-foreground">Branch changed from</span>
          <Var>{branchTooltip}</Var>
        </T>
      </span>
    ),
    actions: (
      <Button size="xs" variant="ghost" disabled={input.restoreDisabled} onClick={input.onRestore}>
        {input.restoring ? (
          <T>Restoring...</T>
        ) : input.refNoun === "branch" ? (
          <T>Restore branch</T>
        ) : (
          `Restore ${input.refNoun}`
        )}
      </Button>
    ),
    dismissLabel:
      input.refNoun !== "branch"
        ? `Dismiss ${input.refNoun} change notice`
        : resolve(msg("Dismiss branch change notice")),
    onDismiss: input.onDismiss,
  };
}
