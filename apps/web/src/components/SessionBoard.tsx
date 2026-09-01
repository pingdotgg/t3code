import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import { FolderIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { effectiveSnoozed, threadWokeAt } from "@t3tools/client-runtime/state/thread-settled";
import { isElectron } from "../env";
import { useEnvironments } from "../state/environments";
import {
  useAllEnvironmentShellsBootstrapped,
  useProjects,
  useServerConfigs,
  useThreadShells,
} from "../state/entities";
import { useUiStateStore } from "../uiStateStore";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
} from "./Sidebar.logic";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarInset } from "./ui/sidebar";
import { WorkspacePageHeader } from "./WorkspacePageHeader";
import { buildBoardCards, groupBoardCardsByProject } from "../board/board.logic";
import { BoardSessionCard, type BoardThreadStatus } from "./board/BoardSessionCard";

const attentionStatuses = new Set<BoardThreadStatus>([
  "approval",
  "input",
  "failed",
  "plan",
  "woke",
  "completed",
]);

function resolveBoardThreadStatus(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
  now: string,
): BoardThreadStatus {
  const status = resolveSidebarThreadStatus(thread);
  if (status !== "ready") return status;
  if (resolveThreadStatusPill({ thread: { ...thread, lastVisitedAt } })?.label === "Plan Ready") {
    return "plan";
  }
  const wokeAt = threadWokeAt(thread, { now });
  if (wokeAt !== null) {
    const wokeAtMs = Date.parse(wokeAt);
    const lastVisitedAtMs = Date.parse(lastVisitedAt ?? "");
    if (
      Number.isFinite(wokeAtMs) &&
      (!Number.isFinite(lastVisitedAtMs) || lastVisitedAtMs < wokeAtMs)
    ) {
      return "woke";
    }
  }
  return hasUnseenCompletion({ ...thread, lastVisitedAt }) ? "completed" : "ready";
}

export function SessionBoard() {
  const threads = useThreadShells();
  const bootstrapped = useAllEnvironmentShellsBootstrapped();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const { environments, presentationById } = useEnvironments();
  const connectingEnvironmentCount = useMemo(
    () =>
      environments.filter((environment) => {
        const phase = presentationById.get(environment.environmentId)?.connection.phase;
        return phase === "connecting" || phase === "reconnecting";
      }).length,
    [environments, presentationById],
  );
  const lastVisitedAtByThreadKey = useUiStateStore((state) => state.threadLastVisitedAtById);
  const [snoozeWakeTick, bumpSnoozeWakeTick] = useState(0);
  const environmentLabels = useMemo(
    () =>
      new Map(environments.map((environment) => [environment.environmentId, environment.label])),
    [environments],
  );
  const activeThreads = useMemo(() => {
    const preciseNow = new Date().toISOString();
    // Lifecycle remains server-backed and follows the same client projection
    // as the sidebar. The board only reads this state; it never mutates it.
    return threads.filter((thread) => {
      if (thread.archivedAt !== null) return false;
      if (presentationById.get(thread.environmentId)?.connection.phase !== "connected")
        return false;

      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      if (capabilities?.threadSnooze === true && effectiveSnoozed(thread, { now: preciseNow })) {
        return false;
      }

      return capabilities?.threadSettlement !== true || thread.settledOverride !== "settled";
    });
  }, [presentationById, serverConfigs, snoozeWakeTick, threads]);
  const nextWakeAtMs = useMemo(() => {
    let next = Number.POSITIVE_INFINITY;
    const now = Date.now();
    for (const thread of threads) {
      if (serverConfigs.get(thread.environmentId)?.environment.capabilities.threadSnooze !== true) {
        continue;
      }
      const wakeAt = Date.parse(thread.snoozedUntil ?? "");
      if (wakeAt > now && wakeAt < next) next = wakeAt;
    }
    return next;
  }, [serverConfigs, threads, snoozeWakeTick]);
  useEffect(() => {
    if (!Number.isFinite(nextWakeAtMs)) return;
    const delayMs = Math.min(Math.max(0, nextWakeAtMs - Date.now()) + 50, 2_147_483_647);
    const id = window.setTimeout(() => bumpSnoozeWakeTick((tick) => tick + 1), delayMs);
    return () => window.clearTimeout(id);
  }, [nextWakeAtMs, snoozeWakeTick]);
  const cards = useMemo(
    () =>
      buildBoardCards({
        threads: activeThreads,
        projects,
        environmentLabels,
      }),
    [activeThreads, environmentLabels, projects],
  );
  const sections = useMemo(() => groupBoardCardsByProject(cards), [cards]);
  const summary = useMemo(() => {
    let attention = 0;
    let working = 0;
    const environmentIds = new Set<string>();
    const statusByThreadKey = new Map<string, BoardThreadStatus>();
    const now = new Date().toISOString();
    for (const card of cards) {
      const threadKey = scopedThreadKey(scopeThreadRef(card.thread.environmentId, card.thread.id));
      const status = resolveBoardThreadStatus(
        card.thread,
        lastVisitedAtByThreadKey[threadKey],
        now,
      );
      statusByThreadKey.set(threadKey, status);
      if (attentionStatuses.has(status)) attention += 1;
      if (status === "working") working += 1;
      environmentIds.add(card.thread.environmentId);
    }
    return { attention, working, environments: environmentIds.size, statusByThreadKey };
  }, [cards, lastVisitedAtByThreadKey]);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron}>
        <div
          aria-live="polite"
          className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground"
        >
          <h1 className="truncate text-sm font-semibold">Board view</h1>
          <span>
            {bootstrapped
              ? `${cards.length} active ${cards.length === 1 ? "session" : "sessions"}`
              : "Loading sessions…"}
          </span>
          {bootstrapped && summary.attention > 0 ? (
            <span className="text-amber-700 dark:text-amber-300">
              {summary.attention} need attention
            </span>
          ) : null}
          {bootstrapped && summary.working > 0 ? <span>{summary.working} working</span> : null}
          {bootstrapped && summary.environments > 1 ? (
            <span>{summary.environments} environments</span>
          ) : null}
          {connectingEnvironmentCount > 0 ? (
            <span>
              {connectingEnvironmentCount}{" "}
              {connectingEnvironmentCount === 1 ? "environment" : "environments"} connecting…
            </span>
          ) : null}
        </div>
      </WorkspacePageHeader>
      {!bootstrapped ? null : sections.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle className="text-lg">
              {connectingEnvironmentCount > 0 ? "Connecting to sessions…" : "No active sessions"}
            </EmptyTitle>
            <EmptyDescription>
              {connectingEnvironmentCount > 0
                ? "Live chats will appear as their environments reconnect."
                : "Active sessions will appear here across your connected environments."}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="topbar-scroll-fade scrollbar-gutter-both min-h-0 flex-1 overflow-auto px-4 pt-[var(--workspace-titlebar-scroll-fade-height)] pb-5 sm:px-6 sm:pb-7">
          <div className="mx-auto flex max-w-7xl flex-col gap-8">
            {sections.map((section) => (
              <section
                key={section.projectKey}
                aria-labelledby={`board-project-${encodeURIComponent(section.projectKey)}`}
              >
                <div className="mb-3 flex items-center gap-2">
                  <FolderIcon aria-hidden className="size-4 text-muted-foreground" />
                  <h2
                    id={`board-project-${encodeURIComponent(section.projectKey)}`}
                    className="text-sm font-semibold tracking-tight"
                  >
                    {section.projectTitle}
                  </h2>
                  <span className="text-xs text-muted-foreground">{section.cards.length}</span>
                </div>
                <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,22rem),1fr))] gap-3">
                  {section.cards.map((card) => {
                    const threadRef = scopeThreadRef(card.thread.environmentId, card.thread.id);
                    const environmentConnection = presentationById.get(
                      card.thread.environmentId,
                    )?.connection;
                    if (!environmentConnection) return null;
                    return (
                      <BoardSessionCard
                        key={JSON.stringify([card.thread.environmentId, card.thread.id])}
                        card={card}
                        environmentConnection={environmentConnection}
                        status={
                          summary.statusByThreadKey.get(scopedThreadKey(threadRef)) ?? "ready"
                        }
                      />
                    );
                  })}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </SidebarInset>
  );
}
