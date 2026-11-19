import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { T, useGT } from "gt-react";
import { ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { InlineButton } from "../ui/button";
import {
  Dialog,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { CommandOutputPanel, useCommandOutputStreaming } from "./CommandOutputPanel";
import { ShellCommandBlock } from "./ShellCommandBlock";

export function BackgroundWorkDetails(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const gt = useGT();
  const kindLabel = (kind: string) => {
    switch (kind) {
      case "subagent":
        return gt("subagent", { $context: "kind of background work" });
      case "command":
        return gt("command", { $context: "kind of background work" });
      case "monitor":
        return gt("monitor", { $context: "kind of background work" });
      case "background_task":
        return gt("background task", { $context: "kind of background work" });
      default:
        return kind.replaceAll("_", " ");
    }
  };
  const [open, setOpen] = useState(false);
  const streamsOutput = useCommandOutputStreaming(props.environmentId);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<InlineButton />}>
        <T>Details</T>
      </DialogTrigger>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            <T>Background work</T>
          </DialogTitle>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-5">
            {props.tasks.map((task) => {
              const item = props.turnItems.findLast((candidate) =>
                task.itemId === undefined
                  ? (candidate.nativeItemRef?.nativeId || candidate.id) === task.taskId
                  : candidate.id === task.itemId,
              );
              const command =
                task.command ?? (item?.type === "command_execution" ? item.input : undefined);
              const description = task.description?.trim();
              const title =
                description && description !== command?.trim()
                  ? description
                  : command
                    ? gt("Command", { $context: "title of a background shell command" })
                    : kindLabel(task.kind);
              const itemId =
                task.itemId ?? (item?.type === "command_execution" ? item.id : undefined);
              const childThreadId = task.kind === "subagent" ? task.childThreadId : undefined;
              const status = backgroundWorkHoldsCompletion([task])
                ? gt("Waiting", { $context: "status of background work" })
                : gt("Running", { $context: "status of background work" });
              return (
                <section key={task.taskId} className="space-y-2 text-sm">
                  {childThreadId ? (
                    <h3>
                      <button
                        type="button"
                        className="-mx-2 flex w-[calc(100%+1rem)] cursor-pointer items-baseline justify-between gap-3 rounded-lg px-2 py-1.5 text-start outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                        onClick={() => {
                          setOpen(false);
                          props.onOpenThread(childThreadId);
                        }}
                      >
                        <span className="min-w-0 font-medium">{title}</span>
                        <span className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
                          {status}
                          <ChevronRightIcon aria-hidden className="size-3.5" />
                        </span>
                      </button>
                    </h3>
                  ) : (
                    <div className="flex items-baseline justify-between gap-3">
                      <h3 className="min-w-0 font-medium">{title}</h3>
                      <span className="shrink-0 text-xs text-muted-foreground">{status}</span>
                    </div>
                  )}
                  {command ? (
                    <div className="rounded-md border border-border bg-muted/20 p-3 font-mono text-xs whitespace-pre-wrap break-words">
                      <ShellCommandBlock command={command} />
                    </div>
                  ) : null}
                  {itemId && streamsOutput && item?.status === "running" ? (
                    <div className="font-mono text-xs whitespace-pre-wrap break-words">
                      <CommandOutputPanel
                        environmentId={props.environmentId}
                        threadId={task.sourceThreadId ?? item?.threadId ?? props.threadId}
                        itemId={itemId}
                      />
                    </div>
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
