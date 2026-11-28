import {
  type EnvironmentId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2RemoteTaskChild,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { useSideThreadTrigger } from "../../hooks/useSideThreadTrigger";
import { useLinkedThreadOpener } from "../../state/linkedThreadView";
import { Button, InlineButton } from "../ui/button";
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

function RemoteSubagentOpenButton(props: {
  readonly parentRef: ScopedThreadRef;
  readonly remoteChild: OrchestrationV2RemoteTaskChild;
  readonly title: string;
  readonly onOpened: () => void;
}) {
  const opener = useLinkedThreadOpener(props.parentRef, props.remoteChild, props.title);
  const trigger = useSideThreadTrigger();
  if (!opener) return null;
  return (
    <Button
      size="sm"
      variant="outline"
      {...trigger(
        (intent) => {
          props.onOpened();
          opener.open(intent);
        },
        { panel: opener.mode === "linked" },
      )}
    >
      <T>Open subagent</T>
    </Button>
  );
}

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
  const parentRef = scopeThreadRef(props.environmentId, props.threadId);
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
                  ? (candidate.nativeItemRef?.nativeId || candidate.id) ===
                    (task.nativeItemId ?? task.taskId)
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
              const remoteChild =
                task.kind === "subagent" && item?.type === "subagent"
                  ? item.remoteChild
                  : undefined;
              return (
                <section key={task.taskId} className="space-y-2 text-sm">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="font-medium">{title}</h3>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {backgroundWorkHoldsCompletion([task])
                        ? gt("Waiting", { $context: "status of background work" })
                        : gt("Running", { $context: "status of background work" })}
                    </span>
                  </div>
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
                  {childThreadId ? (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOpen(false);
                        props.onOpenThread(childThreadId);
                      }}
                    >
                      <T>Open subagent</T>
                    </Button>
                  ) : remoteChild ? (
                    <RemoteSubagentOpenButton
                      parentRef={parentRef}
                      remoteChild={remoteChild}
                      title={title}
                      onOpened={() => setOpen(false)}
                    />
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
