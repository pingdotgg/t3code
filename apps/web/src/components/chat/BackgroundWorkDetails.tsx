import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { shellStdoutFile } from "@t3tools/shared/shellStdoutFile";
import { useState, type ReactElement, type ReactNode } from "react";

import { InlineButton } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import {
  BackgroundTaskOutputPanel,
  CommandOutputPanel,
  useCommandOutputStreaming,
} from "./CommandOutputPanel";
import { ShellCommandBlock } from "./ShellCommandBlock";
import { useBackgroundTaskControl, useBackgroundTaskStop } from "./useBackgroundTaskStop";

/** The turn item that launched a background task, when the timeline still holds it. */
export function backgroundTaskLaunch(
  task: OrchestrationV2PendingBackgroundTask,
  turnItems: ThreadStructure["turnItems"],
) {
  const item = turnItems.findLast((candidate) =>
    task.itemId === undefined
      ? (candidate.nativeItemRef?.nativeId || candidate.id) === task.taskId
      : candidate.id === task.itemId,
  );
  const command = task.command ?? (item?.type === "command_execution" ? item.input : undefined);
  return { item, command };
}

export function BackgroundWorkDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly trigger?: ReactElement;
  readonly children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  const followsTasks = useBackgroundTaskControl(props.environmentId);
  const taskStop = useBackgroundTaskStop(props.environmentId, props.threadId);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={props.trigger ?? <InlineButton />}>
        {props.children ?? "Details"}
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Background work</DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            {props.tasks.map((task) => {
              const { item, command } = backgroundTaskLaunch(task, props.turnItems);
              const description = task.description?.trim();
              const title =
                description && description !== command?.trim()
                  ? description
                  : command
                    ? "Command"
                    : task.kind.replaceAll("_", " ");
              const itemId =
                task.itemId ?? (item?.type === "command_execution" ? item.id : undefined);
              const childThreadId = task.kind === "subagent" ? task.childThreadId : undefined;
              const isCommand = task.kind !== "subagent";
              const followedFile = command === undefined ? undefined : shellStdoutFile(command);
              const stopping = taskStop.stopping.has(task.taskId);
              return (
                <section key={task.taskId} className="space-y-2 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-medium">{title}</h3>
                    <span className="flex shrink-0 items-baseline gap-3 text-xs text-muted-foreground">
                      {task.awaited ? "Waiting" : "Running"}
                      {isCommand && taskStop.available ? (
                        <InlineButton
                          disabled={stopping}
                          onClick={() => void taskStop.stop(task.taskId)}
                        >
                          {stopping ? "Stopping..." : "Stop"}
                        </InlineButton>
                      ) : null}
                    </span>
                  </div>
                  {command ? (
                    <div className="rounded-md border border-border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap break-words">
                      <ShellCommandBlock command={command} />
                    </div>
                  ) : null}
                  {isCommand && followsTasks ? (
                    <div className="space-y-1 font-mono text-xs whitespace-pre-wrap break-words">
                      {followedFile ? (
                        <div className="font-sans text-muted-foreground">
                          Following {followedFile}
                        </div>
                      ) : null}
                      <BackgroundTaskOutputPanel
                        environmentId={props.environmentId}
                        threadId={props.threadId}
                        taskId={task.taskId}
                      />
                    </div>
                  ) : itemId && streamsOutput && item?.status === "running" ? (
                    <div className="font-mono text-xs whitespace-pre-wrap break-words">
                      <CommandOutputPanel
                        environmentId={props.environmentId}
                        threadId={task.sourceThreadId ?? item?.threadId ?? props.threadId}
                        itemId={itemId}
                      />
                    </div>
                  ) : null}
                  {childThreadId ? (
                    <InlineButton
                      onClick={() => {
                        setOpen(false);
                        props.onOpenThread(childThreadId);
                      }}
                    >
                      Open thread
                    </InlineButton>
                  ) : null}
                </section>
              );
            })}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
