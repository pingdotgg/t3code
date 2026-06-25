import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  resolveMergeBackTargetThreadId,
  type ThreadRelationshipEdge,
} from "@t3tools/client-runtime/state/thread-relationships";
import { canDetachThreadProviderSession } from "@t3tools/client-runtime/state/thread-workflows";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowRightIcon,
  BotIcon,
  GitForkIcon,
  GitMergeIcon,
  LoaderCircleIcon,
  MoreHorizontalIcon,
  UnplugIcon,
} from "lucide-react";
import { useState } from "react";

import { useArchivedThreadSnapshots } from "../../lib/archivedThreadsState";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useThreadProjection, useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ICON_ACTION_CLASS,
  THREAD_DETAILS_PANEL_LINK_ROW_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS,
  THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS,
  THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS,
} from "./threadDetailsPanelStyles";

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

function relationshipThreadTitle(input: {
  readonly title: string;
  readonly isSubagent: boolean;
}): string {
  if (!input.isSubagent) return input.title;
  return input.title.replace(/^Subagent:\s*/i, "");
}

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
  const mergeBack = useAtomCommand(threadEnvironment.mergeBack);
  const stopSession = useAtomCommand(threadEnvironment.stopSession);
  const [busyAction, setBusyAction] = useState<"merge" | "detach" | null>(null);
  const latestCompletedRun = projection?.runs.findLast((run) => run.status === "completed") ?? null;
  const mergeTargetThreadId = resolveMergeBackTargetThreadId(projection);
  const relationshipRows = immediateThreadRelationships(graph, props.threadId).toSorted(
    (left, right) =>
      Number(right.threadId === mergeTargetThreadId) -
      Number(left.threadId === mergeTargetThreadId),
  );
  const canMerge = mergeTargetThreadId !== null && latestCompletedRun !== null;
  const canDetach = projection ? canDetachThreadProviderSession(projection) : false;

  if (relationshipRows.length === 0) {
    return null;
  }

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
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
          {canDetach ? (
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    className={THREAD_DETAILS_PANEL_ICON_ACTION_CLASS}
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

      {relationshipRows.length > 0 ? (
        <ul className="m-0 list-none p-0">
          {relationshipRows.map(({ threadId, edge }) => {
            const node = graph.nodes.get(threadId);
            const isSubagent = edge.kind === "subagent";
            const isMergeTarget = threadId === mergeTargetThreadId;
            const RelationshipIcon = isSubagent ? BotIcon : GitForkIcon;
            const relationship = relationshipLabel(edge, props.threadId);
            const threadTitle = relationshipThreadTitle({
              title: node?.thread?.title ?? threadId,
              isSubagent,
            });
            const relationshipContent = (
              <>
                <span className="relative -mx-0.5 grid size-4 shrink-0 place-items-center">
                  <RelationshipIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
                  <span
                    className={cn(
                      "absolute -bottom-1 -right-1 size-2 rounded-full border-2 border-card",
                      statusDotClass(edge.status),
                    )}
                    aria-hidden="true"
                  />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium leading-4 text-foreground/85">
                    {threadTitle}
                  </span>
                </span>
                <ArrowRightIcon className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
              </>
            );
            return (
              <li key={threadId} className="group flex h-9 items-center rounded-lg">
                {isMergeTarget ? (
                  <div className={THREAD_DETAILS_PANEL_LINK_SPLIT_GROUP_CLASS}>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="sm"
                            variant="ghost"
                            className={THREAD_DETAILS_PANEL_LINK_SPLIT_PRIMARY_CLASS}
                            disabled={node?.missing === true}
                            onClick={() => openThread(threadId)}
                          />
                        }
                      >
                        {relationshipContent}
                      </TooltipTrigger>
                      <TooltipPopup side="left">
                        {node?.missing
                          ? "This related thread is unavailable"
                          : `Open ${relationship.toLowerCase()} in this chat`}
                      </TooltipPopup>
                    </Tooltip>
                    <span
                      aria-hidden="true"
                      className={THREAD_DETAILS_PANEL_SPLIT_SEPARATOR_CLASS}
                    />
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            size="sm"
                            variant="ghost"
                            className={THREAD_DETAILS_PANEL_LINK_SPLIT_SECONDARY_CLASS}
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
                          </Button>
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
                  </div>
                ) : (
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={node?.missing === true}
                          onClick={() => openThread(threadId)}
                          className={THREAD_DETAILS_PANEL_LINK_ROW_CLASS}
                        />
                      }
                    >
                      {relationshipContent}
                    </TooltipTrigger>
                    <TooltipPopup side="left">
                      {node?.missing
                        ? "This related thread is unavailable"
                        : `Open ${relationship.toLowerCase()} in this chat`}
                    </TooltipPopup>
                  </Tooltip>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
