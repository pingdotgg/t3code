import type { EnvironmentId } from "@t3tools/contracts";
import { useMemo, useSyncExternalStore } from "react";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildThreadListV2Items,
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  threadListInboxReturns,
} from "./threadListV2";
import { computeThreadMoveAvailability } from "./threadOrder";

/**
 * Screens' select handlers read the content-only key set; a fresh one per list rebuild gave
 * every row a new handler whenever any thread shell changed. Keyed by a string, the set keeps
 * its identity until its keys change.
 */
function useKeySet(newlineSeparatedKeys: string): ReadonlySet<string> {
  return useMemo(
    () => new Set(newlineSeparatedKeys.length === 0 ? [] : newlineSeparatedKeys.split("\n")),
    [newlineSeparatedKeys],
  );
}

type LayoutInput = Parameters<typeof buildThreadListV2Items>[0];

/**
 * Home's and the thread sidebar's thread list. Its result is one value a screen only reads:
 * built inline, the list's inputs stayed open to mutation across the screen's other hooks, so
 * the React Compiler cached none of it and every render of the screen re-rendered every row.
 */
export function useThreadListV2(input: {
  readonly threads: LayoutInput["threads"];
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs: LayoutInput["projectRefs"];
  readonly searchQuery: string;
  /** Threads that match the search by content, keyed like `threadSearchMatchKey`. */
  readonly searchMatches: ReadonlyMap<string, unknown>;
  readonly settlementEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly pinReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly activeReorderEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys: ReadonlySet<string>;
  readonly settledLimit: number;
  readonly now: string;
  readonly pendingOrder: LayoutInput["pendingOrder"];
  readonly shelfPreferencesLoaded: boolean;
  readonly workingShelfEnabled: boolean;
  readonly workingShelfExpanded: boolean;
  readonly snoozedShelfExpanded: boolean;
  readonly settledShelfExpanded: boolean;
  readonly selectedThreadKey: string | null;
}) {
  const { threads, workingShelfEnabled } = input;
  // A thread can stop working when the threads change, or when its exit grace expires.
  const inboxVersion = useSyncExternalStore(
    threadListInboxReturns.subscribe,
    threadListInboxReturns.getSnapshot,
  );
  const inbox = useMemo(
    () => threadListInboxReturns.observe(workingShelfEnabled ? threads : null),
    // oxlint-disable-next-line react/memo-dependencies -- the version signals an expired grace
    [threads, workingShelfEnabled, inboxVersion],
  );
  // Up/down menu availability for every card, computed once per section per
  // rebuild (see computeThreadMoveAvailability): per-thread planner calls made
  // list construction quadratic, and this list rebuilds on every minute tick.
  const sectionAvailability = (section: "pinned" | "active") =>
    computeThreadMoveAvailability({
      allThreads: threads,
      section,
      pendingOrder: input.pendingOrder,
      reorderableEnvironmentIds:
        section === "pinned" ? input.pinReorderEnvironmentIds : input.activeReorderEnvironmentIds,
      ordered: getThreadListV2OrderedSection({
        threads,
        section,
        pendingOrder: input.pendingOrder,
        now: input.now,
        settlementEnvironmentIds: input.settlementEnvironmentIds,
        snoozeEnvironmentIds: input.snoozeEnvironmentIds,
        queuedThreadKeys: input.queuedThreadKeys,
      }),
    });
  const moveAvailability = new Map([
    ...sectionAvailability("pinned"),
    ...(workingShelfEnabled ? [] : sectionAvailability("active")),
  ]);
  const layout = buildThreadListV2Items({
    pendingOrder: input.pendingOrder,
    threads: threads.filter((thread) => thread.archivedAt === null),
    environmentId: input.environmentId,
    projectRefs: input.projectRefs,
    searchQuery: input.searchQuery,
    matchedThreadKeys: new Set(input.searchMatches.keys()),
    settlementEnvironmentIds: input.settlementEnvironmentIds,
    snoozeEnvironmentIds: input.snoozeEnvironmentIds,
    queuedThreadKeys: input.queuedThreadKeys,
    settledLimit: input.settledLimit,
    now: input.now,
    workingShelfEnabled,
    workingShelfExpanded: input.workingShelfExpanded,
    inboxReturnAt: inbox.returnedAt,
    isWorking: inbox.isWorking,
    snoozedShelfExpanded: input.snoozedShelfExpanded,
    settledShelfExpanded: input.settledShelfExpanded,
    selectedThreadKey: input.selectedThreadKey,
  });
  const contentOnlyThreadKeys = useKeySet([...layout.contentOnlyThreadKeys].sort().join("\n"));
  const scopedProjectKeys =
    input.projectRefs == null
      ? null
      : new Set(input.projectRefs.map((ref) => scopedProjectKey(ref.environmentId, ref.projectId)));
  const searchQuery = input.searchQuery.trim().toLocaleLowerCase();
  const pendingTasks = input.pendingTasks.filter(
    (pendingTask) =>
      (input.environmentId === null || pendingTask.environmentId === input.environmentId) &&
      (scopedProjectKeys === null ||
        scopedProjectKeys.has(
          scopedProjectKey(pendingTask.environmentId, pendingTask.projectId),
        )) &&
      (searchQuery.length === 0 || pendingTask.title.toLocaleLowerCase().includes(searchQuery)),
  );
  const items = buildThreadListV2ListItems({
    items: layout.items,
    pendingTasks,
    workingCount: layout.workingCount,
    workingShelfExpanded: input.workingShelfExpanded,
    workingShelfHeaderIndex: layout.workingShelfHeaderIndex,
    snoozedCount: layout.snoozedCount,
    snoozedShelfExpanded: input.snoozedShelfExpanded,
    snoozedShelfHeaderIndex: layout.snoozedShelfHeaderIndex,
    settledCount: layout.settledCount,
    settledShelfExpanded: input.settledShelfExpanded,
    settledShelfHeaderIndex: layout.settledShelfHeaderIndex,
    snoozeLabelNow: `${input.now.slice(0, 16)}:00.000Z`,
    snoozeEnvironmentIds: input.snoozeEnvironmentIds,
    queuedThreadKeys: input.queuedThreadKeys,
    moveAvailability,
    shelfPreferencesLoading: !input.shelfPreferencesLoaded,
  });
  return { layout, items, contentOnlyThreadKeys };
}
