import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { presentPendingBackgroundWork } from "@t3tools/client-runtime/state/thread-execution";
import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { ChevronRightIcon, LoaderCircleIcon, SquareIcon, TerminalIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { revealThreadTerminal } from "../../lib/revealThreadTerminal";
import { cn } from "../../lib/utils";
import { terminalEnvironment } from "../../state/terminal";
import { useKnownTerminalSessions } from "../../state/terminalSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { BackgroundWorkDetails, backgroundTaskLaunch } from "./BackgroundWorkDetails";
import { ShellCommandBlock } from "./ShellCommandBlock";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { THREAD_DETAILS_PANEL_ICON_CLASS } from "./threadDetailsPanelStyles";
import { BackgroundTaskOutputPanel } from "./CommandOutputPanel";
import { useBackgroundTaskControl, useBackgroundTaskStop } from "./useBackgroundTaskStop";

const RUNNING_PAGE_COUNT = 4;

export interface ThreadRunningBackgroundWork {
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly stopDisabled: boolean;
  readonly stopping: boolean;
  readonly onStop: () => Promise<void>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}

/** Commands the thread's agent left running and its terminals' foreground processes. Hidden while none run. */
export function ThreadRunningPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly backgroundWork: ThreadRunningBackgroundWork | null;
}) {
  const sessions = useKnownTerminalSessions(props);
  const canInterrupt = useAtomValue(terminalEnvironment.write.permissionAtom(props.environmentId));
  const writeTerminal = useAtomCommand(terminalEnvironment.write, "terminal interrupt");
  const taskStop = useBackgroundTaskStop(props.environmentId, props.threadId);
  // Servers that stream task output show it in place; older ones keep the details dialog.
  const followsTasks = useBackgroundTaskControl(props.environmentId);
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);
  const work = props.backgroundWork;
  // Subagents are listed under Lineage.
  const tasks = (work?.tasks ?? []).filter((task) => task.kind !== "subagent");
  const labels = new Map(
    presentPendingBackgroundWork(tasks)?.items.map((item) => [item.taskId, item.label]),
  );
  const terminals = (sessions ?? []).flatMap(({ state: { summary } }) =>
    summary?.hasRunningSubprocess ? [summary] : [],
  );
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);

  const rows = [
    ...(work === null
      ? []
      : tasks.map((task) => {
          const name = labels.get(task.taskId) ?? task.kind;
          // Only tasks the provider marks can be stopped alone or followed; others open the dialog.
          const controlled = followsTasks && task.individualControl === true;
          const stoppable = taskStop.available && task.individualControl === true;
          const expanded = controlled && expandedTaskId === task.taskId;
          const { command } = backgroundTaskLaunch(task, work.turnItems);
          const followedFile = task.outputFile;
          const label = (
            <>
              <TerminalIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <RowText
                title={name}
                detail={`Agent · ${task.awaited ? "Waiting" : "Running"}`}
                padEnd={stoppable}
              />
              {controlled ? (
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 motion-reduce:transition-none",
                    expanded && "rotate-90",
                  )}
                />
              ) : null}
            </>
          );
          return {
            key: `agent:${task.taskId}`,
            node: (
              <RunningRow
                stopBesideChevron={controlled}
                stop={
                  stoppable ? (
                    <StopButton
                      label={`Stop ${name}`}
                      tooltip="Stop this background task"
                      pending={taskStop.stopping.has(task.taskId)}
                      onClick={() => void taskStop.stop(task.taskId)}
                    />
                  ) : null
                }
              >
                {controlled ? (
                  <ThreadDetailsControl
                    size="sm"
                    variant="ghost"
                    part="row"
                    multiline
                    aria-expanded={expanded}
                    onClick={() => setExpandedTaskId(expanded ? null : task.taskId)}
                  >
                    {label}
                  </ThreadDetailsControl>
                ) : (
                  <BackgroundWorkDetails
                    environmentId={props.environmentId}
                    threadId={props.threadId}
                    tasks={[task]}
                    turnItems={work.turnItems}
                    onOpenThread={work.onOpenThread}
                    trigger={
                      <ThreadDetailsControl size="sm" variant="ghost" part="row" multiline />
                    }
                  >
                    {label}
                  </BackgroundWorkDetails>
                )}
              </RunningRow>
            ),
            output: expanded ? (
              <div className="space-y-1.5 px-2.5 pb-2 font-mono text-2xs leading-4 whitespace-pre-wrap break-words">
                {command ? (
                  <div className="max-h-24 overflow-auto rounded-md bg-muted/30 px-2 py-1.5">
                    <ShellCommandBlock command={command} />
                  </div>
                ) : null}
                {followedFile ? (
                  <div className="font-sans break-all text-muted-foreground">
                    Following {followedFile}
                  </div>
                ) : null}
                <BackgroundTaskOutputPanel
                  environmentId={props.environmentId}
                  threadId={props.threadId}
                  taskId={task.taskId}
                  compact
                />
              </div>
            ) : null,
          };
        })),
    ...terminals.map(({ terminalId, label }) => {
      const name = label || terminalId;
      return {
        key: `terminal:${terminalId}`,
        output: null,
        node: (
          <RunningRow
            stop={
              canInterrupt ? (
                <StopButton
                  label={`Interrupt ${name}`}
                  tooltip="Interrupt (Ctrl+C)"
                  pending={false}
                  onClick={() =>
                    void writeTerminal({
                      environmentId: props.environmentId,
                      input: { threadId: props.threadId, terminalId, data: "\u0003" },
                    })
                  }
                />
              ) : null
            }
          >
            <ThreadDetailsControl
              size="sm"
              variant="ghost"
              part="row"
              multiline
              onClick={() => revealThreadTerminal(threadRef, terminalId)}
            >
              <TerminalIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
              <RowText title={name} detail="Terminal" padEnd={canInterrupt} />
            </ThreadDetailsControl>
          </RunningRow>
        ),
      };
    }),
  ];
  if (rows.length === 0) return null;

  return (
    <ThreadDetailsSection
      headingId="thread-details-running-heading"
      title="Running"
      actions={
        // Servers that cannot stop one task still let the user end all of them.
        work && tasks.some((task) => !(taskStop.available && task.individualControl)) ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="xs"
                  variant="ghost"
                  part="row"
                  tone="muted"
                  disabled={work.stopDisabled}
                  onClick={() => void work.onStop()}
                />
              }
            >
              {work.stopping ? "Stopping..." : "Stop agent work"}
            </TooltipTrigger>
            <TooltipPopup side="left">
              Stops everything the agent runs in the background, including subagents
            </TooltipPopup>
          </Tooltip>
        ) : null
      }
    >
      <ul className="m-0 list-none p-0">
        {rows.map((row, index) => (
          <li
            key={row.key}
            // Rows past the first page scroll rather than counting toward the card's density.
            data-thread-details-running-overflow={index >= RUNNING_PAGE_COUNT || undefined}
            className="rounded-lg"
          >
            {row.node}
            {row.output ? (
              // Open output scrolls inside its own bound and does not decide the card's density.
              <div data-thread-details-running-output={index < RUNNING_PAGE_COUNT || undefined}>
                {row.output}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </ThreadDetailsSection>
  );
}

function RunningRow(props: {
  readonly stop: ReactNode;
  readonly stopBesideChevron?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <div className="group relative flex items-center">
      {props.children}
      {props.stop ? (
        <div
          className={cn(
            "pointer-events-none absolute top-1/2 -translate-y-1/2 opacity-0 group-hover:pointer-events-auto group-hover:opacity-100 group-has-focus-visible:pointer-events-auto group-has-focus-visible:opacity-100 pointer-coarse:pointer-events-auto pointer-coarse:opacity-100 [@media(hover:none)]:pointer-events-auto [@media(hover:none)]:opacity-100",
            props.stopBesideChevron ? "right-7" : "right-1",
          )}
        >
          {props.stop}
        </div>
      ) : null}
    </div>
  );
}

function StopButton(props: {
  readonly label: string;
  readonly tooltip: string;
  readonly pending: boolean;
  readonly onClick: () => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ThreadDetailsControl
            size="icon-xs"
            variant="ghost"
            part="icon"
            tone="destructive"
            aria-label={props.label}
            disabled={props.pending}
            onClick={props.onClick}
          />
        }
      >
        {props.pending ? (
          <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
        ) : (
          <SquareIcon aria-hidden className="size-3 fill-current" />
        )}
      </TooltipTrigger>
      <TooltipPopup side="left">{props.tooltip}</TooltipPopup>
    </Tooltip>
  );
}

function RowText(props: {
  readonly title: string;
  readonly detail: string;
  readonly padEnd?: boolean;
}) {
  return (
    <span className={cn("flex min-w-0 flex-1 flex-col gap-0.5 text-left", props.padEnd && "pe-6")}>
      <span className="truncate text-sm font-medium leading-4 text-foreground/85">
        {props.title}
      </span>
      <span className="truncate text-2xs font-normal leading-4 text-muted-foreground">
        {props.detail}
      </span>
    </span>
  );
}
