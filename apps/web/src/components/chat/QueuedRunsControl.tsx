import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { deriveThreadQueueWorkflowState } from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckIcon,
  Clock3Icon,
  CornerUpRightIcon,
  ListOrderedIcon,
  PencilIcon,
  XIcon,
} from "lucide-react";
import { useMemo, useState } from "react";

import { threadEnvironment } from "../../state/threads";
import { useThreadProjection } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import type { ChatMessage } from "../../types";
import { Button } from "../ui/button";

export function QueuedRunsControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly optimisticMessages: ReadonlyArray<Pick<ChatMessage, "id" | "inputIntent" | "text">>;
}) {
  const projection = useThreadProjection(
    scopeThreadRef(props.environmentId, props.threadId),
  )?.projection;
  const reorder = useAtomCommand(threadEnvironment.reorderQueuedRun);
  const promote = useAtomCommand(threadEnvironment.promoteQueuedRun);
  const cancel = useAtomCommand(threadEnvironment.cancelQueuedRun);
  const edit = useAtomCommand(threadEnvironment.editQueuedRun);
  const [busyRunId, setBusyRunId] = useState<RunId | null>(null);
  const [editing, setEditing] = useState<{ runId: RunId; draft: string } | null>(null);
  const workflow = useMemo(
    () => (projection ? deriveThreadQueueWorkflowState(projection) : null),
    [projection],
  );
  const queued = workflow?.queuedRuns ?? [];
  const activeRun = workflow?.activeRun ?? null;
  const committedQueuedMessageIds = new Set(queued.map(({ run }) => run.userMessageId));
  const optimisticQueued = props.optimisticMessages.filter(
    (message) =>
      message.inputIntent === "queued_turn" && !committedQueuedMessageIds.has(message.id),
  );
  const items = [
    ...queued.map(({ run, text }, serverIndex) => ({
      key: run.id,
      runId: run.id,
      serverIndex,
      text,
      pending: false,
    })),
    ...optimisticQueued.map((message) => ({
      key: message.id,
      runId: null,
      serverIndex: null,
      text: message.text,
      pending: true,
    })),
  ];

  if (items.length === 0) return null;

  const move = async (runId: RunId, beforeRunId: RunId | null) => {
    setBusyRunId(runId);
    try {
      await reorder({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId, beforeRunId },
      });
    } finally {
      setBusyRunId(null);
    }
  };

  const steer = async (queuedRunId: RunId) => {
    if (activeRun === null) return;
    setBusyRunId(queuedRunId);
    try {
      await promote({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, queuedRunId, targetRunId: activeRun.id },
      });
    } finally {
      setBusyRunId(null);
    }
  };

  const remove = async (runId: RunId) => {
    setBusyRunId(runId);
    try {
      await cancel({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId },
      });
    } finally {
      setBusyRunId(null);
    }
  };

  const saveEdit = async (runId: RunId, originalText: string) => {
    if (editing === null || editing.runId !== runId) return;
    const text = editing.draft.trim();
    if (text.length === 0) return;
    if (text === originalText) {
      setEditing(null);
      return;
    }
    setBusyRunId(runId);
    try {
      await edit({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, runId, text },
      });
      setEditing(null);
    } finally {
      setBusyRunId(null);
    }
  };

  return (
    <section
      aria-label={`${items.length} queued message${items.length === 1 ? "" : "s"}`}
      aria-live="polite"
      className="chat-composer-queue-strip relative z-0 -mb-4 mx-auto w-[calc(100%-2.75rem)] max-w-[calc(48rem-2.75rem)] px-2 pt-1.5 pb-5"
    >
      <header className="flex h-6 items-center gap-1.5 px-1.5 text-[11px] font-medium text-muted-foreground">
        <ListOrderedIcon className="size-3.5" />
        <span>Queued</span>
        <span className="rounded-full bg-muted/70 px-1.5 text-[10px] tabular-nums">
          {items.length}
        </span>
      </header>
      <ol className="max-h-32 overflow-y-auto px-1">
        {items.map((item, index) => {
          const rowEditing =
            item.runId !== null && editing !== null && editing.runId === item.runId
              ? editing
              : null;
          return (
            <li
              key={item.key}
              className="flex min-w-0 items-center gap-1 border-border/45 border-t py-1 first:border-t-0"
            >
              <span className="w-4 shrink-0 text-center text-[10px] tabular-nums text-muted-foreground/65">
                {index + 1}
              </span>
              {item.pending ? (
                <Clock3Icon
                  aria-label="Saving queued message"
                  className="size-3 shrink-0 text-muted-foreground/60"
                />
              ) : null}
              {rowEditing !== null ? (
                <>
                  <input
                    aria-label="Edit queued message"
                    autoFocus
                    className="min-w-0 flex-1 rounded-sm border border-border/60 bg-transparent px-1.5 py-0.5 text-xs outline-none focus:border-border"
                    value={rowEditing.draft}
                    onChange={(event) =>
                      setEditing((current) =>
                        current === null ? current : { ...current, draft: event.target.value },
                      )
                    }
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        if (item.runId !== null) void saveEdit(item.runId, item.text);
                      }
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setEditing(null);
                      }
                    }}
                  />
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Save queued message"
                    className="size-6 text-muted-foreground"
                    disabled={busyRunId !== null || rowEditing.draft.trim().length === 0}
                    onClick={() => {
                      if (item.runId !== null) void saveEdit(item.runId, item.text);
                    }}
                  >
                    <CheckIcon className="size-3" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Cancel editing queued message"
                    className="size-6 text-muted-foreground"
                    disabled={busyRunId !== null}
                    onClick={() => setEditing(null)}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </>
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-xs" title={item.text}>
                    {item.text}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Edit queued message"
                    className="size-6 text-muted-foreground"
                    disabled={item.runId === null || busyRunId !== null}
                    onClick={() => {
                      if (item.runId !== null) {
                        setEditing({ runId: item.runId, draft: item.text });
                      }
                    }}
                  >
                    <PencilIcon className="size-3" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Move queued message up"
                    className="size-6 text-muted-foreground"
                    disabled={
                      item.runId === null ||
                      item.serverIndex === null ||
                      busyRunId !== null ||
                      !workflow?.canReorder ||
                      item.serverIndex === 0
                    }
                    onClick={() => {
                      if (item.runId === null || item.serverIndex === null) {
                        return;
                      }
                      void move(item.runId, queued[item.serverIndex - 1]?.run.id ?? null);
                    }}
                  >
                    <ArrowUpIcon className="size-3" />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Move queued message down"
                    className="size-6 text-muted-foreground"
                    disabled={
                      item.runId === null ||
                      item.serverIndex === null ||
                      busyRunId !== null ||
                      !workflow?.canReorder ||
                      item.serverIndex === queued.length - 1
                    }
                    onClick={() => {
                      if (item.runId === null || item.serverIndex === null) {
                        return;
                      }
                      void move(item.runId, queued[item.serverIndex + 2]?.run.id ?? null);
                    }}
                  >
                    <ArrowDownIcon className="size-3" />
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="h-6 gap-1 px-1.5 text-[11px] text-muted-foreground"
                    disabled={
                      item.runId === null || busyRunId !== null || !workflow?.canPromoteToSteer
                    }
                    title={
                      activeRun === null
                        ? "There is no active run to steer"
                        : "Send as a steer instead"
                    }
                    onClick={() => {
                      if (item.runId !== null) {
                        void steer(item.runId);
                      }
                    }}
                  >
                    <CornerUpRightIcon className="size-3" />
                    Steer
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="Remove queued message"
                    className="size-6 text-muted-foreground"
                    disabled={item.runId === null || busyRunId !== null}
                    title="Remove from queue"
                    onClick={() => {
                      if (item.runId !== null) void remove(item.runId);
                    }}
                  >
                    <XIcon className="size-3" />
                  </Button>
                </>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
