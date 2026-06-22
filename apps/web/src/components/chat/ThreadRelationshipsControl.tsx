import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightIcon, GitBranchIcon, GitForkIcon, NetworkIcon, UnplugIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import {
  deriveThreadRelationshipGraph,
  walkThreadRelationships,
} from "../../lib/threadRelationships";
import { buildThreadRouteParams } from "../../threadRoutes";
import { newThreadId } from "../../lib/utils";
import { threadEnvironment } from "../../state/threads";
import { useThreadProjection, useThreadShells } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function relationshipLabel(
  edge: ReturnType<typeof walkThreadRelationships>[number]["edge"],
  currentThreadId: ThreadId,
) {
  if (edge.kind === "transfer") return "context transfer";
  if (edge.kind === "subagent") {
    return edge.sourceThreadId === currentThreadId ? "subagent" : "parent agent";
  }
  return edge.sourceThreadId === currentThreadId ? "fork" : "source";
}

export function ThreadRelationshipsControl(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useThreadProjection(ref)?.projection ?? null;
  const activeShells = useThreadShells().filter(
    (thread) => thread.environmentId === props.environmentId,
  );
  const archived = useArchivedThreadSnapshots([props.environmentId]);
  const archivedShells =
    archived.snapshots.find((entry) => entry.environmentId === props.environmentId)?.snapshot
      .threads ?? [];
  const shells = useMemo<ReadonlyArray<OrchestrationV2ThreadShell>>(
    () => [...activeShells.map((thread) => thread.source), ...archivedShells],
    [activeShells, archivedShells],
  );
  const graph = useMemo(
    () => deriveThreadRelationshipGraph({ threads: shells, projection }),
    [projection, shells],
  );
  const relationshipRows = useMemo(
    () => walkThreadRelationships(graph, props.threadId),
    [graph, props.threadId],
  );
  const navigate = useNavigate();
  const forkFromRun = useAtomCommand(threadEnvironment.forkFromRun);
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack);
  const stopSession = useAtomCommand(threadEnvironment.stopSession);
  const [busyAction, setBusyAction] = useState<"fork" | "merge" | "detach" | null>(null);
  const latestCompletedRun = projection?.runs.findLast((run) => run.status === "completed") ?? null;
  const sourceProviderThread =
    latestCompletedRun?.providerThreadId == null
      ? null
      : (projection?.providerThreads.find(
          (thread) => thread.id === latestCompletedRun.providerThreadId,
        ) ?? null);
  const capabilities =
    (sourceProviderThread === null
      ? null
      : projection?.providerSessions.find(
          (session) => session.id === sourceProviderThread.providerSessionId,
        )?.capabilities) ?? null;
  const canForkNatively =
    capabilities?.threads.canForkThread === true &&
    capabilities.threads.canForkFromTurn === true &&
    capabilities.identity.nativeThreadIds === "strong";
  const canFork =
    latestCompletedRun !== null &&
    (canForkNatively || capabilities?.context.supportsFullThreadHandoff === true);
  const parentThreadId =
    projection?.thread.forkedFrom?.type === "run"
      ? projection.thread.forkedFrom.threadId
      : (projection?.thread.lineage.parentThreadId ?? null);
  const canMerge =
    parentThreadId !== null &&
    projection?.thread.lineage.relationshipToParent === "fork" &&
    latestCompletedRun !== null;
  const canDetach =
    projection?.providerSessions.some(
      (session) => session.status !== "stopped" && session.status !== "error",
    ) ?? false;

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  };

  const fork = async () => {
    if (!latestCompletedRun || busyAction !== null) return;
    setBusyAction("fork");
    const targetThreadId = newThreadId();
    const result = await forkFromRun({
      environmentId: props.environmentId,
      input: {
        sourceThreadId: props.threadId,
        targetThreadId,
        runId: latestCompletedRun.id,
        title: `${projection?.thread.title ?? "Thread"} fork`,
      },
    });
    setBusyAction(null);
    if (result._tag === "Success") openThread(targetThreadId);
  };

  const merge = async () => {
    if (!latestCompletedRun || parentThreadId === null || busyAction !== null) return;
    setBusyAction("merge");
    const result = await mergeBack({
      environmentId: props.environmentId,
      input: {
        sourceThreadId: props.threadId,
        targetThreadId: parentThreadId,
        runId: latestCompletedRun.id,
      },
    });
    setBusyAction(null);
    if (result._tag === "Success") openThread(parentThreadId);
  };

  const detach = async () => {
    if (!canDetach || busyAction !== null) return;
    setBusyAction("detach");
    await stopSession({
      environmentId: props.environmentId,
      input: { threadId: props.threadId },
    });
    setBusyAction(null);
  };

  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Button
                  size="xs"
                  variant="outline"
                  aria-label="Thread relationships and V2 actions"
                />
              }
            >
              <NetworkIcon className="size-3.5" />
              {relationshipRows.length > 0 ? <span>{relationshipRows.length}</span> : null}
            </PopoverTrigger>
          }
        />
        <TooltipPopup>Thread relationships</TooltipPopup>
      </Tooltip>
      <PopoverPopup align="end" className="w-80" viewportClassName="p-0">
        <div className="border-b border-border px-3 py-2.5">
          <p className="text-sm font-medium">Thread relationships</p>
          <p className="text-xs text-muted-foreground">
            Forks, subagents, and context transfers in this environment.
          </p>
        </div>
        <div className="max-h-72 overflow-auto p-2">
          {relationshipRows.length === 0 ? (
            <p className="px-2 py-4 text-center text-xs text-muted-foreground">
              This thread has no related threads yet.
            </p>
          ) : (
            <ul className="space-y-1">
              {relationshipRows.map(({ threadId, fromThreadId, depth, edge }) => {
                const node = graph.nodes.get(threadId);
                return (
                  <li key={threadId}>
                    <button
                      type="button"
                      disabled={node?.missing === true}
                      onClick={() => openThread(threadId)}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
                      style={{ paddingInlineStart: `${Math.min(depth, 6) * 0.75 + 0.5}rem` }}
                    >
                      <GitBranchIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-xs font-medium">
                          {node?.thread?.title ?? threadId}
                        </span>
                        <span className="block text-[10px] text-muted-foreground">
                          {node?.missing
                            ? "Missing from the current shell"
                            : relationshipLabel(edge, fromThreadId)}
                          {edge?.status ? ` · ${edge.status}` : ""}
                        </span>
                      </span>
                      <ArrowRightIcon className="size-3 text-muted-foreground" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div className="grid grid-cols-1 gap-1 border-t border-border p-2 sm:grid-cols-2">
          <Button
            size="xs"
            variant="outline"
            disabled={!canFork || busyAction !== null}
            onClick={fork}
          >
            <GitForkIcon className="size-3" />
            {busyAction === "fork" ? "Forking..." : "Fork latest"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!canMerge || busyAction !== null}
            onClick={merge}
          >
            <GitBranchIcon className="size-3" />
            {busyAction === "merge" ? "Merging..." : "Merge back"}
          </Button>
          <Button
            size="xs"
            variant="outline"
            disabled={!canDetach || busyAction !== null}
            onClick={detach}
            className="sm:col-span-2"
          >
            <UnplugIcon className="size-3" />
            {busyAction === "detach" ? "Detaching..." : "Detach provider session"}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
