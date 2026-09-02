import type { EnvironmentId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  scopeProjectRef,
  scopeThreadRef,
  scopedProjectKey,
  scopedThreadKey,
} from "@t3tools/client-runtime/environment";
import {
  canSnooze,
  snoozeWakeLabel,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import type {
  ShellSidebarDraft,
  ShellSidebarState,
  ShellSidebarThread,
} from "@t3tools/contracts/shell";

import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadStatusPill,
  type SidebarThreadCapabilities,
  type SidebarThreadPartition,
} from "../components/Sidebar.logic";
import type { SidebarProjectSnapshot } from "../sidebarProjectGrouping";

/** Settled rows beyond this are summarised by `settledTotal`. */
export const SHELL_SIDEBAR_SETTLED_LIMIT = 50;

export interface ShellSidebarStateInput {
  readonly projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly scopeProjectKey: string | null;
  readonly partition: SidebarThreadPartition;
  readonly capabilitiesFor: (environmentId: EnvironmentId) => SidebarThreadCapabilities | undefined;
  readonly threadCountByLogicalKey: ReadonlyMap<string, number>;
  readonly lastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly drafts: ReadonlyArray<ShellSidebarDraft>;
  readonly activeThreadKey: string | null;
  readonly activeDraftId: string | null;
}

/** `<environmentId>:<projectId>` → logical project key, from the grouped snapshots. */
export function buildLogicalProjectKeyMap(
  projectGroups: ReadonlyArray<SidebarProjectSnapshot>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of projectGroups) {
    for (const ref of group.memberProjectRefs) {
      map.set(scopedProjectKey(ref), group.projectKey);
    }
  }
  return map;
}

interface ToShellThreadOptions {
  readonly logicalKeyByPhysicalKey: ReadonlyMap<string, string>;
  readonly lastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly capabilitiesFor: (environmentId: EnvironmentId) => SidebarThreadCapabilities | undefined;
  /** The partition's clock, so wake times agree with which shelf the row landed on. */
  readonly now: string;
  /** Rows on the snoozed shelf carry their wake label; woken rows elsewhere do not. */
  readonly snoozed: boolean;
}

/**
 * The woke indicator survives until the user re-engages after the wake, the
 * same rule the HTML row applies: an unparseable visit counts as never
 * visited, and a thread settled by hand has nothing left to wake for.
 */
function visibleWokeAt(
  thread: EnvironmentThreadShell,
  lastVisitedAt: string | undefined,
  now: string,
): string | null {
  if (thread.settledOverride === "settled") return null;
  const wokeAt = threadWokeAt(thread, { now });
  if (wokeAt === null) return null;
  if (lastVisitedAt === undefined) return wokeAt;
  const visitedMs = Date.parse(lastVisitedAt);
  if (Number.isNaN(visitedMs) || visitedMs < Date.parse(wokeAt)) return wokeAt;
  return null;
}

function toShellThread(
  thread: EnvironmentThreadShell,
  options: ToShellThreadOptions,
): ShellSidebarThread {
  const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
  const lastVisitedAt = options.lastVisitedAtByKey[key];
  const statusInput = { ...thread, lastVisitedAt };
  const capabilities = options.capabilitiesFor(thread.environmentId);
  const physicalProjectKey = scopedProjectKey(
    scopeProjectRef(thread.environmentId, thread.projectId),
  );
  return {
    key,
    threadId: thread.id,
    environmentId: thread.environmentId,
    projectKey: options.logicalKeyByPhysicalKey.get(physicalProjectKey) ?? physicalProjectKey,
    title: thread.title,
    status: resolveSidebarThreadStatus(thread),
    statusLabel: resolveThreadStatusPill({ thread: statusInput })?.label ?? null,
    unread: hasUnseenCompletion(statusInput),
    branch: thread.branch,
    updatedAt: thread.updatedAt,
    pinned: thread.pinnedAt != null,
    snoozedUntil: thread.snoozedUntil ?? null,
    wakeLabel:
      options.snoozed && thread.snoozedUntil != null
        ? snoozeWakeLabel(thread.snoozedUntil, { now: options.now })
        : null,
    wokeAt: visibleWokeAt(thread, lastVisitedAt, options.now),
    canSettle: capabilities?.threadSettlement === true,
    canSnooze: capabilities?.threadSnooze === true && canSnooze(thread, { now: options.now }),
  };
}

export function buildShellSidebarState(input: ShellSidebarStateInput): ShellSidebarState {
  const logicalKeyByPhysicalKey = buildLogicalProjectKeyMap(input.projectGroups);
  const convert = (threads: ReadonlyArray<EnvironmentThreadShell>, snoozed = false) =>
    threads.map((thread) =>
      toShellThread(thread, {
        logicalKeyByPhysicalKey,
        lastVisitedAtByKey: input.lastVisitedAtByKey,
        capabilitiesFor: input.capabilitiesFor,
        now: input.partition.snoozeNow,
        snoozed,
      }),
    );
  return {
    projects: input.projectGroups.map((group) => ({
      key: group.projectKey,
      displayName: group.displayName,
      environmentId: group.environmentId,
      projectId: group.id,
      workspaceRoot: group.workspaceRoot,
      threadCount: input.threadCountByLogicalKey.get(group.projectKey) ?? 0,
    })),
    scopeProjectKey: input.scopeProjectKey,
    pinned: convert(input.partition.pinnedThreads),
    active: convert(input.partition.activeThreads),
    snoozed: convert(input.partition.snoozedThreads, true),
    settled: convert(input.partition.settledThreads.slice(0, SHELL_SIDEBAR_SETTLED_LIMIT)),
    settledTotal: input.partition.settledThreads.length,
    drafts: input.drafts,
    activeThreadKey: input.activeThreadKey,
    activeDraftId: input.activeDraftId,
  };
}
