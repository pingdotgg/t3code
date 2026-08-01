import { ArchiveIcon, BellOffIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useId, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { scopedProjectKey, scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime";
import { useParams, useRouter } from "@tanstack/react-router";
import {
  QUEUED_TURN_START_GRACE_MS,
  canSettle,
  canSnooze,
  effectiveSnoozed,
} from "@t3tools/client-runtime/state/thread-settled";
import { type OrchestrationThreadActivity } from "@t3tools/contracts";

import { useThreadActions } from "../hooks/useThreadActions";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { usePrimaryEnvironmentDescriptor, usePrimaryEnvironmentId } from "../environments/primary";
import { useSavedEnvironmentRuntimeStore } from "../environments/runtime";
import { isElectron } from "../env";
import { shortcutLabelForCommand } from "../keybindings";
import {
  selectProjectsAcrossEnvironments,
  selectSidebarThreadsAcrossEnvironments,
  selectThreadByRef,
  useStore,
} from "../store";
import {
  buildThreadRouteParams,
  clearAgentRunRouteSearch,
  parseAgentRunRouteSearch,
  resolveThreadRouteRef,
} from "../threadRoutes";
import type { Project, SidebarThreadSummary } from "../types";
import { buildProviderEntriesByEnvironment, scopedProviderInstanceKey } from "../providerInstances";
import { useServerKeybindings, useServerProviders } from "../rpc/serverState";
import { agentRunDismissKey, deriveSidebarThreadsWithAgentRuns } from "../sidebarThreadTree";
import { useUiStateStore } from "../uiStateStore";
import {
  classifySidebarV2Shelves,
  resolveThreadLifecycleSupport,
  resolveSidebarV2ThreadRouteTarget,
  selectSnoozeShelfBulkTargets,
  shouldReserveMacSidebarChrome,
} from "./SidebarV2.logic";
import { SidebarV2Row } from "./SidebarV2Row";
import { SidebarHoverThreadPrewarmer } from "./SidebarThreadPrewarmer";
import { Button } from "./ui/button";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { SidebarContent, SidebarGroup, SidebarHeader, SidebarMenu } from "./ui/sidebar";
import { SidebarTopActions } from "./SidebarTopActions";

const SETTLED_PAGE_SIZE = 25;
const EMPTY_THREAD_ACTIVITIES: readonly OrchestrationThreadActivity[] = [];

function projectByScopedKey(projects: readonly Project[]): Map<string, Project> {
  return new Map(
    projects.map((project) => [
      scopedProjectKey(scopeProjectRef(project.environmentId, project.id)),
      project,
    ]),
  );
}

function nowIso(): string {
  return new Date().toISOString();
}

function startOfTomorrow(): string {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  return tomorrow.toISOString();
}

function Shelf({
  title,
  icon,
  count,
  children,
  action,
  defaultOpen = true,
}: {
  readonly title: string;
  readonly icon: ReactNode;
  readonly count: number;
  readonly children: ReactNode;
  readonly action?: ReactNode;
  readonly defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const contentId = useId();
  return (
    <SidebarGroup className="px-1 py-0">
      {/* The action sits beside the toggle rather than inside it: nesting an
          interactive element in a button is invalid and would swallow clicks. */}
      <div className="group/shelf flex items-center gap-0.5">
        <button
          type="button"
          aria-controls={contentId}
          aria-expanded={open}
          className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-[length:var(--app-sidebar-meta-font-size)] font-medium text-muted-foreground/80 hover:bg-sidebar-accent hover:text-foreground"
          onClick={() => setOpen((value) => !value)}
        >
          {open ? (
            <ChevronDownIcon className="size-3.5 shrink-0" />
          ) : (
            <ChevronRightIcon className="size-3.5 shrink-0" />
          )}
          {icon}
          <span className="truncate">{title}</span>
          <span className="ml-auto tabular-nums text-muted-foreground/60">{count}</span>
        </button>
        {action}
      </div>
      <div id={contentId}>{open ? children : null}</div>
    </SidebarGroup>
  );
}

export default function SidebarV2() {
  const [now, setNow] = useState(nowIso);
  const [settledVisibleCount, setSettledVisibleCount] = useState(SETTLED_PAGE_SIZE);
  const { defaultProjectRef, handleNewThread } = useHandleNewThread();
  const { settleThread, snoozeThread, unsettleThread, unsnoozeThread } = useThreadActions();
  const router = useRouter();
  const params = useParams({ strict: false });
  const activeThreadRef = resolveThreadRouteRef(params);
  const activeThreadKey = activeThreadRef
    ? `${activeThreadRef.environmentId}:${activeThreadRef.threadId}`
    : null;
  const activeAgentTaskId = parseAgentRunRouteSearch(params).agent ?? null;
  const { projects, threads } = useStore(
    useShallow((state) => ({
      projects: selectProjectsAcrossEnvironments(state),
      threads: selectSidebarThreadsAcrossEnvironments(state),
    })),
  );
  const threadActivities = useStore(
    useShallow(
      useMemo(
        () => (state: import("../store").AppState) =>
          threads.map(
            (thread) =>
              selectThreadByRef(state, scopeThreadRef(thread.environmentId, thread.id))
                ?.activities ?? EMPTY_THREAD_ACTIVITIES,
          ),
        [threads],
      ),
    ),
  );
  const dismissedAgentRunKeys = useUiStateStore((state) => state.dismissedAgentRunKeys);
  const setAgentRunDismissed = useUiStateStore((state) => state.setAgentRunDismissed);
  const threadsWithAgentRuns = useMemo(
    () =>
      deriveSidebarThreadsWithAgentRuns({
        threads,
        threadActivities,
        dismissedAgentRunKeys,
      }),
    [dismissedAgentRunKeys, threadActivities, threads],
  );
  const primaryDescriptor = usePrimaryEnvironmentDescriptor();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const keybindings = useServerKeybindings();
  const remoteEnvironmentDescriptors = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const commandPaletteShortcutLabel = shortcutLabelForCommand(
    keybindings,
    "commandPalette.toggle",
    {
      platform: navigator.platform,
      context: {
        terminalFocus: false,
        terminalOpen: false,
      },
    },
  );
  const hasMacSidebarChrome = shouldReserveMacSidebarChrome({
    isElectron,
    platform: navigator.platform,
  });
  const lifecycleSupport = useMemo(
    () =>
      resolveThreadLifecycleSupport([
        primaryDescriptor,
        ...Object.values(remoteEnvironmentDescriptors).map((saved) => saved.descriptor),
      ]),
    [primaryDescriptor, remoteEnvironmentDescriptors],
  );

  // Classification only changes on its own at two known instants: a snooze
  // elapsing, or a queued turn start ageing out of its grace window. Waking
  // exactly then beats polling every minute and keeps snoozes punctual.
  useEffect(() => {
    const nowMs = Date.parse(now);
    let nextAt = Number.POSITIVE_INFINITY;
    for (const thread of threads) {
      const snoozedUntil = thread.snoozedUntil ?? null;
      const wakeAt = snoozedUntil === null ? Number.NaN : Date.parse(snoozedUntil);
      if (wakeAt > nowMs) {
        nextAt = Math.min(nextAt, wakeAt);
      }
      const messageAt =
        thread.latestUserMessageAt === null ? Number.NaN : Date.parse(thread.latestUserMessageAt);
      const graceEndsAt = messageAt + QUEUED_TURN_START_GRACE_MS;
      if (graceEndsAt > nowMs) {
        nextAt = Math.min(nextAt, graceEndsAt);
      }
    }
    if (!Number.isFinite(nextAt)) {
      return undefined;
    }
    // setTimeout delays are signed 32-bit: anything larger overflows and fires
    // immediately. The padding keeps the wake strictly past the boundary.
    const delayMs = Math.min(Math.max(0, nextAt - Date.now()) + 50, 2_147_483_647);
    const timer = window.setTimeout(() => setNow(nowIso()), delayMs);
    return () => window.clearTimeout(timer);
  }, [now, threads]);

  const projectsByKey = useMemo(() => projectByScopedKey(projects), [projects]);
  // Provider instances are per environment: a saved environment publishes its
  // own catalog, so scoping by instance ID alone would render a remote thread
  // with the primary environment's provider whenever the IDs collide.
  const primaryProviders = useServerProviders();
  const providerEntryByKey = useMemo(
    () =>
      buildProviderEntriesByEnvironment([
        ...(primaryEnvironmentId === null
          ? []
          : [{ environmentId: primaryEnvironmentId, providers: primaryProviders }]),
        ...Object.entries(remoteEnvironmentDescriptors).map(([environmentId, saved]) => ({
          environmentId,
          providers: saved.serverConfig?.providers ?? [],
        })),
      ]),
    [primaryEnvironmentId, primaryProviders, remoteEnvironmentDescriptors],
  );

  // Classifies the store's own thread objects rather than rebuilt copies, so
  // real rows that did not change keep their identity and stay memoized.
  const shelves = useMemo(() => {
    return classifySidebarV2Shelves({ threads: threadsWithAgentRuns, now });
  }, [now, threadsWithAgentRuns]);

  // Snoozed rows the shelf's bulk buttons may actually target.
  const bulkSnoozeTargets = useMemo(
    () => selectSnoozeShelfBulkTargets({ snoozed: shelves.snoozed, lifecycleSupport, now }),
    [lifecycleSupport, now, shelves.snoozed],
  );

  const openedSettled = useMemo(() => {
    const included = shelves.settled.slice(0, settledVisibleCount);
    if (
      activeThreadKey !== null &&
      !included.some((thread) => `${thread.environmentId}:${thread.id}` === activeThreadKey)
    ) {
      const routed = shelves.settled.find(
        (thread) => `${thread.environmentId}:${thread.id}` === activeThreadKey,
      );
      if (routed) return [...included, routed];
    }
    return included;
  }, [activeThreadKey, settledVisibleCount, shelves.settled]);

  const openThread = useCallback(
    (thread: SidebarThreadSummary) => {
      const target = resolveSidebarV2ThreadRouteTarget(thread);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(scopeThreadRef(thread.environmentId, target.threadId)),
        search: target.agentTaskId
          ? (previous) => ({ ...previous, agent: target.agentTaskId ?? undefined })
          : clearAgentRunRouteSearch,
      });
    },
    [router],
  );
  const handleDismissAgentRun = useCallback(
    (thread: SidebarThreadSummary) => {
      const agentRun = thread.virtualAgentRun;
      if (!agentRun || agentRun.status === "running") {
        return;
      }
      setAgentRunDismissed(agentRunDismissKey(agentRun.parentThreadId, agentRun.taskId), true);
    },
    [setAgentRunDismissed],
  );
  const runAction = useCallback((action: () => Promise<void>, actionLabel: string) => {
    void action().catch((error: unknown) => {
      const description =
        error instanceof Error ? error.message : "An unexpected error prevented this action.";
      console.error("Sidebar inbox lifecycle action failed", error);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to ${actionLabel}`,
          description,
        }),
      );
    });
  }, []);
  // Bulk shelf actions fan out to one command per thread — there is no bulk
  // command — so failures are collapsed into a single toast rather than one
  // per thread, which could otherwise bury the screen in duplicates.
  const runBulkAction = useCallback(
    (
      targets: readonly SidebarThreadSummary[],
      action: (thread: SidebarThreadSummary) => Promise<void>,
      actionLabel: string,
    ) => {
      if (targets.length === 0) {
        return;
      }
      void Promise.allSettled(targets.map((thread) => action(thread))).then((results) => {
        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failures.length === 0) {
          return;
        }
        console.error("Sidebar inbox bulk lifecycle action failed", failures);
        const firstReason: unknown = failures[0]?.reason;
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Failed to ${actionLabel} ${failures.length} of ${targets.length} threads`,
            description:
              firstReason instanceof Error
                ? firstReason.message
                : "An unexpected error prevented this action.",
          }),
        );
      });
    },
    [],
  );
  // Stable per-action handlers: inline arrows would give every row fresh props
  // on each render and defeat ThreadRow's memoization.
  const handleSettle = useCallback(
    (thread: SidebarThreadSummary) => {
      runAction(
        () => settleThread(scopeThreadRef(thread.environmentId, thread.id)),
        "settle thread",
      );
    },
    [runAction, settleThread],
  );
  const handleUnsettle = useCallback(
    (thread: SidebarThreadSummary) => {
      runAction(
        () => unsettleThread(scopeThreadRef(thread.environmentId, thread.id)),
        "reopen thread",
      );
    },
    [runAction, unsettleThread],
  );
  const handleSnooze = useCallback(
    (thread: SidebarThreadSummary, until: string) => {
      runAction(
        () => snoozeThread(scopeThreadRef(thread.environmentId, thread.id), until),
        "snooze thread",
      );
    },
    [runAction, snoozeThread],
  );
  const handleUnsnooze = useCallback(
    (thread: SidebarThreadSummary) => {
      runAction(
        () => unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id)),
        "wake thread",
      );
    },
    [runAction, unsnoozeThread],
  );
  // `now` is deliberately kept OUT of row props: it ticks on every wake timer,
  // and a ticking string would invalidate every memoized row. Time-dependent
  // decisions are collapsed here into booleans that only change when the
  // answer actually changes.
  const renderThread = useCallback(
    (thread: SidebarThreadSummary, variant: "card" | "slim") => {
      const threadKey = `${thread.environmentId}:${thread.id}`;
      const routeTarget = resolveSidebarV2ThreadRouteTarget(thread);
      const isVirtualAgentRun = thread.virtualAgentRun !== undefined;
      const project = projectsByKey.get(
        scopedProjectKey(scopeProjectRef(thread.environmentId, thread.projectId)),
      );
      const settled = thread.settledOverride === "settled";
      const instanceId = thread.session?.providerInstanceId ?? null;
      return (
        <SidebarV2Row
          key={threadKey}
          active={
            `${thread.environmentId}:${routeTarget.threadId}` === activeThreadKey &&
            (routeTarget.agentTaskId === null
              ? activeAgentTaskId === null
              : routeTarget.agentTaskId === activeAgentTaskId)
          }
          onDismissAgentRun={handleDismissAgentRun}
          onOpen={openThread}
          onSettle={handleSettle}
          onSnooze={handleSnooze}
          onUnsettle={handleUnsettle}
          onUnsnooze={handleUnsnooze}
          projectCwd={project?.cwd ?? null}
          projectName={project?.name ?? "Unknown project"}
          providerEntry={
            instanceId === null
              ? null
              : (providerEntryByKey.get(
                  scopedProviderInstanceKey(thread.environmentId, instanceId),
                ) ?? null)
          }
          settled={settled}
          // Reopening is always allowed; only the settle direction has
          // preconditions.
          settleBlocked={!settled && !canSettle(thread, { now })}
          settlementSupported={
            !isVirtualAgentRun && lifecycleSupport.get(thread.environmentId)?.settlement === true
          }
          snoozeBlocked={!canSnooze(thread, { now })}
          snoozeSupported={
            !isVirtualAgentRun && lifecycleSupport.get(thread.environmentId)?.snooze === true
          }
          snoozed={effectiveSnoozed(thread, { now })}
          thread={thread}
          variant={variant}
        />
      );
    },
    [
      activeThreadKey,
      activeAgentTaskId,
      handleDismissAgentRun,
      handleSettle,
      handleSnooze,
      handleUnsettle,
      handleUnsnooze,
      lifecycleSupport,
      now,
      openThread,
      projectsByKey,
      providerEntryByKey,
    ],
  );
  const renderCardThread = useCallback(
    (thread: SidebarThreadSummary) => renderThread(thread, "card"),
    [renderThread],
  );
  const renderSlimThread = useCallback(
    (thread: SidebarThreadSummary) => renderThread(thread, "slim"),
    [renderThread],
  );
  const handleNewThreadClick = useCallback(() => {
    if (defaultProjectRef) void handleNewThread(defaultProjectRef);
  }, [defaultProjectRef, handleNewThread]);

  return (
    <>
      {hasMacSidebarChrome ? (
        <SidebarHeader aria-hidden className="drag-region h-8 shrink-0 p-0 wco:h-8" />
      ) : null}
      <SidebarHoverThreadPrewarmer />
      <SidebarContent className="gap-1 pt-1">
        <SidebarTopActions
          commandPaletteShortcutLabel={commandPaletteShortcutLabel}
          newThread={{
            disabled: defaultProjectRef === null,
            onClick: handleNewThreadClick,
          }}
        />
        <SidebarGroup className="px-1 py-0">
          <SidebarMenu>{shelves.active.map(renderCardThread)}</SidebarMenu>
        </SidebarGroup>
        <Shelf
          count={shelves.snoozed.length}
          defaultOpen={false}
          icon={<BellOffIcon className="size-3.5" />}
          title="Snoozed"
        >
          <SidebarMenu>{shelves.snoozed.map(renderSlimThread)}</SidebarMenu>
          {bulkSnoozeTargets.wakeable.length > 0 ? (
            <div className="flex gap-1 px-2 py-1">
              <Button
                onClick={() =>
                  runBulkAction(
                    bulkSnoozeTargets.wakeable,
                    (thread) => unsnoozeThread(scopeThreadRef(thread.environmentId, thread.id)),
                    "wake",
                  )
                }
                size="xs"
                variant="ghost"
              >
                Wake all
              </Button>
              {bulkSnoozeTargets.reschedulable.length > 0 ? (
                <Button
                  onClick={() =>
                    runBulkAction(
                      bulkSnoozeTargets.reschedulable,
                      (thread) =>
                        snoozeThread(
                          scopeThreadRef(thread.environmentId, thread.id),
                          startOfTomorrow(),
                        ),
                      "snooze",
                    )
                  }
                  size="xs"
                  variant="ghost"
                >
                  Until tomorrow
                </Button>
              ) : null}
            </div>
          ) : null}
        </Shelf>
        <Shelf
          count={shelves.settled.length}
          defaultOpen={false}
          icon={<ArchiveIcon className="size-3.5" />}
          title="Settled"
        >
          <SidebarMenu>{openedSettled.map(renderSlimThread)}</SidebarMenu>
          {shelves.settled.length > openedSettled.length ? (
            <Button
              className="mx-2 mt-1"
              onClick={() => setSettledVisibleCount((count) => count + SETTLED_PAGE_SIZE)}
              size="sm"
              variant="ghost"
            >
              Show more
            </Button>
          ) : null}
        </Shelf>
      </SidebarContent>
    </>
  );
}
