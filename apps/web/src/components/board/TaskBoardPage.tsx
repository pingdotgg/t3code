import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useNavigate } from "@tanstack/react-router";
import { memo, useState } from "react";

import { isElectron } from "../../env";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useProjects, useVisibleThreadShells } from "../../state/entities";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { buildThreadRouteParams } from "../../threadRoutes";
import type { SidebarThreadSummary } from "../../types";
import { resolveThreadStatusPill } from "../Sidebar.logic";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { ScrollArea } from "../ui/scroll-area";
import { SidebarInset } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { BOARD_COLUMNS, groupThreadsByColumn } from "./taskBoard.logic";

const PAGE_SIZE = 50;

const BoardCard = memo(function BoardCard(props: {
  thread: SidebarThreadSummary;
  projectTitle: string | null;
  nowMs: number;
  onOpen: (thread: SidebarThreadSummary) => void;
}) {
  const { thread } = props;
  const pill = resolveThreadStatusPill({ thread });
  return (
    <button
      type="button"
      onClick={() => props.onOpen(thread)}
      className="flex w-full flex-col gap-1 rounded-lg border border-border bg-card px-3 py-2 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <span className="line-clamp-2 text-sm font-medium text-foreground">{thread.title}</span>
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        {pill ? (
          <span className={`inline-flex shrink-0 items-center gap-1 ${pill.colorClass}`}>
            <span className={`size-1.5 rounded-full ${pill.dotClass}`} />
            {pill.label}
          </span>
        ) : null}
        <span className="min-w-0 flex-1 truncate">{props.projectTitle}</span>
        <span className="shrink-0">{formatRelativeTimeLabel(thread.updatedAt, props.nowMs)}</span>
      </span>
    </button>
  );
});

export function TaskBoardPage() {
  const navigate = useNavigate();
  const threads = useVisibleThreadShells();
  const projects = useProjects();
  const nowMinute = useNowMinute();
  const now = `${nowMinute}:00.000Z`;
  const [shown, setShown] = useState<Record<string, number>>({});

  const projectTitles = new Map(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
  const groups = groupThreadsByColumn(threads, now);
  const nowMs = Date.parse(now);
  const openThread = (thread: SidebarThreadSummary) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, thread.id)),
    });
  };

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <span className="text-sm font-medium text-foreground">Task board</span>
        </WorkspacePageHeader>
        {threads.length === 0 ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>No threads yet</EmptyTitle>
              <EmptyDescription>
                Threads from every project show up here by status.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto p-3">
            {BOARD_COLUMNS.map((column) => {
              const items = groups[column.id];
              const limit = shown[column.id] ?? PAGE_SIZE;
              return (
                <section
                  key={column.id}
                  aria-label={column.label}
                  className="flex min-h-0 w-72 shrink-0 flex-col rounded-xl bg-muted/40"
                >
                  <h2 className="flex items-center justify-between px-3 py-2 text-xs font-semibold text-muted-foreground uppercase">
                    {column.label}
                    <span className="font-normal">{items.length}</span>
                  </h2>
                  <ScrollArea className="min-h-0 flex-1">
                    <div className="flex flex-col gap-2 px-2 pb-2">
                      {items.slice(0, limit).map((thread) => (
                        <BoardCard
                          key={`${thread.environmentId}:${thread.id}`}
                          thread={thread}
                          projectTitle={
                            projectTitles.get(`${thread.environmentId}:${thread.projectId}`) ?? null
                          }
                          nowMs={nowMs}
                          onOpen={openThread}
                        />
                      ))}
                      {items.length > limit ? (
                        <button
                          type="button"
                          onClick={() =>
                            setShown((previous) => ({
                              ...previous,
                              [column.id]: limit + PAGE_SIZE,
                            }))
                          }
                          className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          Show {Math.min(PAGE_SIZE, items.length - limit)} more
                        </button>
                      ) : null}
                    </div>
                  </ScrollArea>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
