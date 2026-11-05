import {
  isListedThreadLineage,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import type { SidebarThreadSortOrder } from "@t3tools/contracts/settings";
import { scopedProjectKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  sortPinnedThreadsByOrderKey,
  sortThreads,
} from "@t3tools/client-runtime/state/thread-sort";

export type BreadcrumbSwitcherThread = Pick<
  EnvironmentThreadShell,
  | "environmentId"
  | "id"
  | "projectId"
  | "title"
  | "lineage"
  | "createdAt"
  | "updatedAt"
  | "latestUserMessageAt"
  | "archivedAt"
  | "deletedAt"
  | "pinnedAt"
  | "pinOrderKey"
>;

export interface ThreadSwitcherInput<T extends BreadcrumbSwitcherThread> {
  readonly threads: ReadonlyArray<T>;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
  readonly hiddenThreadKeys: ReadonlySet<string>;
  readonly sortOrder: SidebarThreadSortOrder;
  /** Kept even when it would be filtered, so the list always shows where the user is. */
  readonly currentThreadRef: ScopedThreadRef | null;
}

/** Threads the breadcrumb lists for one project group: pinned first, then by the sidebar's sort. */
export function buildThreadSwitcherThreads<T extends BreadcrumbSwitcherThread>(
  input: ThreadSwitcherInput<T>,
): T[] {
  const projectKeys = new Set(input.projectRefs.map(scopedProjectKey));
  const currentKey = input.currentThreadRef ? threadKey(input.currentThreadRef) : null;
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const thread of input.threads) {
    const key = threadKey(scopeThreadRef(thread.environmentId, thread.id));
    const inProject = projectKeys.has(
      scopedProjectKey({ environmentId: thread.environmentId, projectId: thread.projectId }),
    );
    if (!inProject) continue;
    const listed =
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      isListedThreadLineage(thread.lineage) &&
      !input.hiddenThreadKeys.has(key);
    if (!listed && key !== currentKey) continue;
    (thread.pinnedAt !== null ? pinned : rest).push(thread);
  }
  return [...sortPinnedThreadsByOrderKey(pinned), ...sortThreads(rest, input.sortOrder)];
}

export type ProjectSwitchTarget =
  | { readonly kind: "thread"; readonly threadRef: ScopedThreadRef }
  | { readonly kind: "new-thread"; readonly projectRef: ScopedProjectRef };

/**
 * Where picking a project in the breadcrumb lands: its most recent listed thread,
 * or a new thread in `targetProject` when it has none. Pins don't win here; recency does.
 */
export function resolveProjectSwitchTarget<T extends BreadcrumbSwitcherThread>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly projectRefs: ReadonlyArray<ScopedProjectRef>;
  readonly targetProject: ScopedProjectRef;
  readonly hiddenThreadKeys: ReadonlySet<string>;
  readonly sortOrder: SidebarThreadSortOrder;
}): ProjectSwitchTarget {
  const listed = buildThreadSwitcherThreads({ ...input, currentThreadRef: null });
  const latest = sortThreads(listed, input.sortOrder)[0];
  return latest
    ? { kind: "thread", threadRef: scopeThreadRef(latest.environmentId, latest.id) }
    : { kind: "new-thread", projectRef: input.targetProject };
}
