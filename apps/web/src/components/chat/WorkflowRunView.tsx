import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveWorkflowGroups,
  isActiveSubagentStatus,
  projectedSubagentsToRuntime,
  type RuntimeSubagent,
  type SubagentWorkflowGroup,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  NodeId,
  ThreadId,
  type EnvironmentId,
  type ScopedThreadRef,
  type ServerProvider,
} from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  FileCodeIcon,
  LoaderCircleIcon,
  SquareIcon,
} from "lucide-react";
import * as Option from "effect/Option";
import { useMemo, useState, type ReactNode } from "react";

import { cn } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentThread } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { AgentElapsed } from "./AgentElapsed";
import { phaseElapsed } from "./ThreadLineageWorkflowRow";
import { SubagentAvatar } from "./V2LifecycleRow";
import {
  workflowAnswerPreview,
  workflowPhaseSummary,
  workflowRunCounts,
  workflowRunPhases,
  type WorkflowRunPhase,
} from "./WorkflowRunView.logic";

/** One member, drawn like a subagent row in the chat timeline. */
function AgentRow(props: {
  readonly member: RuntimeSubagent;
  readonly provider: ServerProvider | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { member } = props;
  const failed = member.status === "failed";
  const live = isActiveSubagentStatus(member.status);
  // Members share one brief, so a live row says Working instead of its prompt.
  const detail = failed
    ? workflowAnswerPreview(member.error)
    : live
      ? null
      : workflowAnswerPreview(member.result);
  const threadId = member.childThreadId;
  return (
    <button
      type="button"
      disabled={threadId === null}
      aria-label={`Open ${member.title}`}
      onClick={() => threadId !== null && props.onOpenThread(ThreadId.make(threadId))}
      className="group/subagent flex w-full min-w-0 items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/50"
    >
      <SubagentAvatar
        driver={props.provider?.driver}
        provider={props.provider}
        status={member.status}
      />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 truncate text-xs font-medium text-foreground">
            {member.title}
          </span>
          {failed ? <span className="shrink-0 text-3xs text-destructive">Failed</span> : null}
          {(member.attempt ?? 1) > 1 ? (
            <span className="shrink-0 text-3xs text-muted-foreground">
              attempt {member.attempt}
            </span>
          ) : null}
        </span>
        <span
          className={cn(
            "block truncate text-2xs leading-relaxed",
            failed ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {detail ?? (live ? "Working" : "Done")}
        </span>
      </span>
      <span className="shrink-0 text-2xs text-muted-foreground tabular-nums">
        {member.usage ? formatTokens(member.usage.totalTokens) : null}
      </span>
      <span className="w-14 shrink-0 text-right text-xs text-muted-foreground tabular-nums">
        <AgentElapsed agent={member} />
      </span>
      <ChevronRightIcon
        aria-hidden
        className="size-3.5 shrink-0 text-muted-foreground/60 group-hover/subagent:text-foreground"
      />
    </button>
  );
}

/** A phase, drawn like the chat timeline's "N subagents" group. */
function PhaseGroup(props: {
  readonly phase: WorkflowRunPhase;
  readonly provider: ServerProvider | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { phase } = props;
  // The running phase opens itself until the user picks a side for it.
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? phase.state === "running";
  const summary = workflowPhaseSummary(phase.members);
  const pending = phase.members.length === 0;
  return (
    <div className="pb-1">
      <button
        type="button"
        disabled={pending}
        aria-expanded={pending ? undefined : expanded}
        onClick={() => setOpen(!expanded)}
        className={cn(
          "flex w-full min-w-0 items-center gap-3 py-2 text-left",
          expanded || summary.active ? "text-foreground" : "text-muted-foreground",
          pending && "opacity-55",
        )}
      >
        <span className="flex shrink-0 items-center -space-x-1.5" aria-hidden>
          {pending ? (
            <span className="inline-flex size-6 rounded-full border border-dashed border-border ring-2 ring-background" />
          ) : (
            phase.members
              .slice(0, 3)
              .map((member) => (
                <SubagentAvatar
                  key={member.id}
                  driver={props.provider?.driver}
                  provider={props.provider}
                />
              ))
          )}
          {phase.members.length > 3 ? (
            <span className="inline-flex size-6 items-center justify-center rounded-full bg-muted text-3xs font-medium text-muted-foreground ring-2 ring-background">
              +{phase.members.length - 3}
            </span>
          ) : null}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-xs font-semibold">
            {phase.title}
            {pending ? null : (
              <span className="ms-1.5 font-normal text-muted-foreground">
                {phase.members.length} {phase.members.length === 1 ? "agent" : "agents"}
              </span>
            )}
          </span>
          <span
            className={cn(
              "block truncate text-3xs text-muted-foreground",
              summary.active ? "text-info" : summary.failed && "text-destructive",
            )}
          >
            {pending ? "Not started" : summary.text}
          </span>
        </span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums empty:hidden">
          <AgentElapsed agent={phaseElapsed(phase)} />
        </span>
        {pending ? null : (
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-180",
            )}
          />
        )}
      </button>
      {expanded ? (
        <div className="mt-1 mb-1 rounded-lg border border-border/60 bg-card/30 p-1">
          {phase.members.map((member) => (
            <AgentRow
              key={member.id}
              member={member}
              provider={props.provider}
              onOpenThread={props.onOpenThread}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * The run a workflow coordinator's thread opens to. It reads like a chat turn:
 * the script it ran, one subagent group per phase, then the coordinator's
 * answer and a status line.
 */
function WorkflowRunView(props: {
  readonly group: SubagentWorkflowGroup;
  readonly provider: ServerProvider | undefined;
  readonly script: string;
  readonly result: string | null;
  /** Resolves file links and images in the coordinator's answer, as in its chat. */
  readonly threadRef: ScopedThreadRef;
  readonly markdownCwd: string | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onStop: (() => void) | undefined;
  readonly stopping: boolean;
  /** Space the docked composer covers at the bottom of the view. */
  readonly bottomInset: number;
}) {
  const { workflow } = props.group;
  const phases = workflowRunPhases(props.group);
  const counts = workflowRunCounts(phases);
  const [scriptOpen, setScriptOpen] = useState(false);
  const live = isActiveSubagentStatus(workflow.status);
  const name = workflow.workflowName ?? workflow.title;
  const description = workflow.workflowName !== null ? workflow.title : null;
  return (
    <div
      className="workflow-run-lane min-h-0 flex-1 overflow-y-auto"
      style={{ paddingBottom: props.bottomInset }}
    >
      <div className="chat-content-lane pt-4 sm:pt-6">
        <div className="pb-3">
          <h2 className="truncate text-lg font-semibold">{name}</h2>
          {description && description !== name ? (
            <p className="text-sm text-muted-foreground">{description}</p>
          ) : null}
        </div>
        <button
          type="button"
          aria-expanded={scriptOpen}
          onClick={() => setScriptOpen(!scriptOpen)}
          className="flex min-h-6 w-full items-center gap-1.5 rounded-md px-0.5 py-0.5 text-left text-sm text-muted-foreground hover:text-foreground"
        >
          <span className="flex w-6 justify-center">
            <FileCodeIcon className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1 truncate">
            Ran workflow script
            <span className="text-muted-foreground/70">
              {" "}
              · {props.script.split("\n").length} lines
            </span>
          </span>
          <ChevronDownIcon
            className={cn("size-3.5 transition-transform", scriptOpen && "rotate-180")}
          />
        </button>
        {scriptOpen ? (
          <pre className="ms-7 mt-1 mb-2 max-h-96 overflow-auto rounded-lg border border-border/60 bg-card/30 p-3 font-mono text-xs leading-relaxed text-foreground">
            {props.script}
          </pre>
        ) : null}
        <div className="pt-2">
          {phases.length === 0 ? (
            <p className="py-2 text-sm text-muted-foreground">No agents yet</p>
          ) : (
            phases.map((phase) => (
              <PhaseGroup
                key={phase.index}
                phase={phase}
                provider={props.provider}
                onOpenThread={props.onOpenThread}
              />
            ))
          )}
        </div>
        {!live && props.result ? (
          <div className="pt-3">
            <ChatMarkdown text={props.result} cwd={props.markdownCwd} threadRef={props.threadRef} />
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 pt-4 text-xs text-muted-foreground tabular-nums">
          <span>
            {live ? "Working for " : "Worked for "}
            <AgentElapsed agent={workflow} />
          </span>
          <span aria-hidden>·</span>
          <span>
            {counts.settled}/{counts.total} agents
          </span>
          {workflow.usage ? (
            <>
              <span aria-hidden>·</span>
              <span>{formatTokens(workflow.usage.totalTokens)} tokens</span>
            </>
          ) : null}
          {props.onStop ? (
            <Button
              size="xs"
              variant="ghost-destructive"
              disabled={props.stopping}
              onClick={props.onStop}
            >
              {props.stopping ? (
                <LoaderCircleIcon className="animate-spin" />
              ) : (
                <SquareIcon className="fill-current" />
              )}
              Stop
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * Wraps a provider subagent thread's timeline. A workflow coordinator's thread
 * shows its run instead; any other thread renders the timeline unchanged.
 *
 * The workflow snapshot lives on the coordinator's subagent record in the
 * parent thread, so this reads the parent's projection. Pass a null parent to
 * skip that read for threads that cannot be a coordinator.
 */
export function WorkflowRunSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly provider: ServerProvider | undefined;
  readonly markdownCwd: string | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly bottomInset: number;
  readonly children: ReactNode;
}) {
  const { environmentId, parentThreadId, threadId } = props;
  const parent = useEnvironmentThread(environmentId, parentThreadId);
  const parentSubagents = Option.getOrUndefined(parent.data)?.subagents;
  const coordinator = parentSubagents?.find(
    (subagent) => subagent.childThreadId === threadId && subagent.workflow !== undefined,
  );
  const group = useMemo(
    () =>
      coordinator === undefined
        ? undefined
        : deriveWorkflowGroups(projectedSubagentsToRuntime([coordinator]))[0],
    [coordinator],
  );
  // ChatView reuses this surface across threads, so the pending stop is keyed
  // to the thread it was sent for.
  const [stoppingThreadId, setStoppingThreadId] = useState<ThreadId | null>(null);
  const stopping = stoppingThreadId === threadId;
  const stopWorkflow = useAtomCommand(orchestrationEnvironment.stopWorkflow);
  const canStop = useAtomValue(orchestrationEnvironment.stopWorkflow.permissionAtom(environmentId));

  // Hold the slot until the parent loads, so a workflow does not flash its
  // script chat first. The parent stream retries on its own, so this waits
  // (offline, too) rather than guessing; a failed or deleted parent shows the
  // chat instead. Static text: we cannot tell yet whether this is a workflow.
  if (
    parentThreadId !== null &&
    parentSubagents === undefined &&
    Option.isNone(parent.error) &&
    parent.status !== "deleted"
  ) {
    return (
      <div className="workflow-run-lane">
        <p className="chat-content-lane pt-4 text-sm text-muted-foreground sm:pt-6">Loading…</p>
      </div>
    );
  }
  if (group === undefined || coordinator === undefined || parentThreadId === null) {
    return props.children;
  }

  const stop = async () => {
    if (stopping) return;
    setStoppingThreadId(threadId);
    const result = await stopWorkflow({
      environmentId,
      input: { threadId: parentThreadId, subagentId: NodeId.make(coordinator.id) },
    });
    setStoppingThreadId((current) => (current === threadId ? null : current));
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Could not stop workflow" });
    }
  };

  return (
    <WorkflowRunView
      key={threadId}
      group={group}
      provider={props.provider}
      script={coordinator.prompt}
      result={coordinator.result}
      threadRef={scopeThreadRef(environmentId, threadId)}
      markdownCwd={props.markdownCwd}
      onOpenThread={props.onOpenThread}
      onStop={
        canStop && isActiveSubagentStatus(group.workflow.status) ? () => void stop() : undefined
      }
      stopping={stopping}
      bottomInset={props.bottomInset}
    />
  );
}
