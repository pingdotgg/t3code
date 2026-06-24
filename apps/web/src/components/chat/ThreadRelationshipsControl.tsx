import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BotIcon,
  GitBranchIcon,
  GitForkIcon,
  GitMergeIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  UnplugIcon,
} from "lucide-react";
import { useState } from "react";

import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  resolveMergeBackTargetThreadId,
  type ThreadRelationshipEdge,
} from "../../lib/threadRelationships";
import { newThreadId } from "../../lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useThreadProjection, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

function relationshipLabel(edge: ThreadRelationshipEdge, currentThreadId: ThreadId) {
  if (edge.kind === "transfer") return "Context transfer";
  if (edge.kind === "subagent") {
    return edge.sourceThreadId === currentThreadId ? "Subagent" : "Parent agent";
  }
  return edge.sourceThreadId === currentThreadId ? "Fork" : "Parent thread";
}

function statusDotClass(status: string | null): string {
  if (status === "running" || status === "in_progress") return "bg-info";
  if (status === "failed" || status === "error") return "bg-destructive";
  if (status === "completed") return "bg-success";
  return "bg-muted-foreground/45";
}

const MAX_VISIBLE_RELATIONSHIPS = 5;

export function ThreadRelationshipsPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const projection = useThreadProjection(ref)?.projection ?? null;
  const threadShells = useThreadShells();
  const activeShells = threadShells.filter(
    (thread) => thread.environmentId === props.environmentId,
  );
  const archived = useArchivedThreadSnapshots([props.environmentId]);
  const archivedShells = archived.snapshots.find(
    (entry) => entry.environmentId === props.environmentId,
  )?.snapshot.threads;
  const shells: ReadonlyArray<OrchestrationV2ThreadShell> = [
    ...activeShells.map((thread) => thread.source),
    ...(archivedShells ?? []),
  ];
  const graph = deriveThreadRelationshipGraph({ threads: shells, projection });
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
  const mergeTargetThreadId = resolveMergeBackTargetThreadId(projection);
  const relationshipRows = immediateThreadRelationships(graph, props.threadId).toSorted(
    (left, right) =>
      Number(right.threadId === mergeTargetThreadId) -
      Number(left.threadId === mergeTargetThreadId),
  );
  const canMerge = mergeTargetThreadId !== null && latestCompletedRun !== null;
  const canDetach =
    projection?.providerSessions.some(
      (session) => session.status !== "stopped" && session.status !== "error",
    ) ?? false;

  if (relationshipRows.length === 0 && !canFork && mergeTargetThreadId === null && !canDetach) {
    return null;
  }

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
    if (!latestCompletedRun || mergeTargetThreadId === null || busyAction !== null) return;
    setBusyAction("merge");
    const result = await mergeBack({
      environmentId: props.environmentId,
      input: {
        sourceThreadId: props.threadId,
        targetThreadId: mergeTargetThreadId,
        runId: latestCompletedRun.id,
      },
    });
    setBusyAction(null);
    if (result._tag === "Success") openThread(mergeTargetThreadId);
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

  const visibleRows = relationshipRows.slice(0, MAX_VISIBLE_RELATIONSHIPS);
  const hiddenRelationshipCount = relationshipRows.length - visibleRows.length;
  const parentTitle =
    mergeTargetThreadId === null
      ? null
      : (graph.nodes.get(mergeTargetThreadId)?.thread?.title ?? null);

  return (
    <section
      aria-labelledby="thread-details-lineage-heading"
      className="border-t border-border/65 px-2 pb-2.5 pt-2"
      data-thread-relationships-panel
    >
      <div className="mb-1 flex min-h-8 items-center justify-between gap-2 px-2">
        <h3
          id="thread-details-lineage-heading"
          className="text-[11px] font-medium text-muted-foreground"
        >
          Lineage
        </h3>
        <div className="flex shrink-0 items-center gap-1">
          {canFork ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busyAction !== null}
              onClick={() => void fork()}
            >
              <GitForkIcon className="size-3" />
              {busyAction === "fork" ? "Forking..." : "Fork"}
            </Button>
          ) : null}
          {canDetach ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label="More thread actions"
                    disabled={busyAction !== null}
                  />
                }
              >
                <MoreHorizontalIcon className="size-3.5" />
              </MenuTrigger>
              <MenuPopup align="end">
                <MenuItem onClick={() => void detach()}>
                  <UnplugIcon className="size-3.5" />
                  Disconnect agent session
                </MenuItem>
              </MenuPopup>
            </Menu>
          ) : null}
        </div>
      </div>

      {visibleRows.length > 0 ? (
        <ul>
          {visibleRows.map(({ threadId, edge }) => {
            const node = graph.nodes.get(threadId);
            const isSubagent = edge.kind === "subagent";
            const isMergeTarget = threadId === mergeTargetThreadId;
            const RelationshipIcon = isSubagent ? BotIcon : GitBranchIcon;
            const relationship = relationshipLabel(edge, props.threadId);
            const threadTitle = node?.thread?.title ?? threadId;
            return (
              <li
                key={threadId}
                className="group flex min-h-11 items-center rounded-lg transition-colors hover:bg-muted/65"
              >
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <button
                        type="button"
                        disabled={node?.missing === true}
                        onClick={() => openThread(threadId)}
                        className="flex min-h-11 min-w-0 flex-1 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left disabled:cursor-not-allowed disabled:opacity-55"
                      >
                        <span className="relative grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                          <RelationshipIcon className="size-3.5" />
                          <span
                            className={cn(
                              "absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-card",
                              statusDotClass(edge.status),
                            )}
                            aria-hidden="true"
                          />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium leading-4 text-foreground/85">
                            {threadTitle}
                          </span>
                          <span className="block truncate text-[11px] leading-4 text-muted-foreground">
                            {node?.missing
                              ? "Unavailable"
                              : `${relationship}${edge.status ? ` · ${edge.status.replaceAll("_", " ")}` : ""}`}
                          </span>
                        </span>
                        <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
                      </button>
                    }
                  />
                  <TooltipPopup side="left">
                    {node?.missing
                      ? "This related thread is unavailable"
                      : `Open ${relationship.toLowerCase()} in this chat`}
                  </TooltipPopup>
                </Tooltip>

                {isMergeTarget ? (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span className="mr-1 inline-flex shrink-0">
                          <Button
                            size="xs"
                            variant="outline"
                            className="gap-1 px-1.5 text-[11px]"
                            aria-label={
                              parentTitle
                                ? `Merge back to ${parentTitle}`
                                : "Merge back to source conversation"
                            }
                            disabled={!canMerge || busyAction !== null}
                            onClick={() => void merge()}
                          >
                            {busyAction === "merge" ? (
                              <LoaderCircleIcon className="size-3 animate-spin" />
                            ) : (
                              <GitMergeIcon className="size-3" />
                            )}
                            {busyAction === "merge" ? "Merging" : "Merge back"}
                          </Button>
                        </span>
                      }
                    />
                    <TooltipPopup side="left">
                      {latestCompletedRun === null
                        ? "Complete a run in this fork before merging it back"
                        : parentTitle
                          ? `Merge this conversation back into ${parentTitle}`
                          : "Merge this conversation back into its source"}
                    </TooltipPopup>
                  </Tooltip>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      {hiddenRelationshipCount > 0 ? (
        <p className="px-2 pt-1 text-[10px] text-muted-foreground">
          {hiddenRelationshipCount} more direct relationship
          {hiddenRelationshipCount === 1 ? "" : "s"}
        </p>
      ) : null}
    </section>
  );
}
