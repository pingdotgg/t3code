import {
  type EnvironmentId,
  isListedThreadLineage,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";

import { threadKey } from "./entities.ts";

type FilterableThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "lineage" | "tags" | "delegatedFrom"
>;

export interface TagFilteredEnvironment {
  readonly environmentId: EnvironmentId;
  readonly threads: ReadonlyArray<FilterableThread>;
  /** Tags this environment hides, or null while its filter is off. */
  readonly hiddenTags: ReadonlyArray<string> | null;
}

export const NO_HIDDEN_THREADS: ReadonlySet<string> = new Set();

/** The thread a subagent, side chat or delegated task takes its visibility from, if any. */
export function visibilityParentKey(
  environmentId: EnvironmentId,
  thread: Pick<FilterableThread, "lineage" | "delegatedFrom">,
): string | null {
  const parentId = thread.lineage.parentThreadId;
  if (!isListedThreadLineage(thread.lineage) && parentId !== null) {
    return threadKey({ environmentId, threadId: parentId });
  }
  return thread.delegatedFrom === undefined ? null : threadKey(thread.delegatedFrom);
}

/**
 * Pull request linked-thread rows the tag filter leaves visible. Loaded threads use the
 * parent-aware hidden set. Rows the shell leaves out carry no lineage, so while any
 * environment hides tags they stay out.
 */
export function visibleLinkedThreads<Row extends { readonly id: ThreadId }>(
  rows: ReadonlyArray<Row>,
  environmentId: EnvironmentId,
  loadedThreadRefs: ReadonlyArray<ScopedThreadRef>,
  hiddenKeys: ReadonlySet<string>,
  hidingAnywhere: boolean,
): ReadonlyArray<Row> {
  if (!hidingAnywhere && hiddenKeys.size === 0) return rows;
  const loaded = new Set(loadedThreadRefs.map((ref) => ref.threadId));
  return rows.filter((row) =>
    loaded.has(row.id)
      ? !hiddenKeys.has(threadKey({ environmentId, threadId: row.id }))
      : !hidingAnywhere,
  );
}

function hasHiddenTag(
  tags: ReadonlyArray<string> | undefined,
  hiddenTags: ReadonlyArray<string> | null,
): boolean {
  return hiddenTags?.some((tag) => tags?.includes(tag) === true) === true;
}

/**
 * Keys of threads the tag filter hides. Children (subagents, side chats, delegated tasks) follow
 * their parent; while any environment hides tags, a child whose parent is not loaded stays hidden.
 * For a partial list such as an archive page, `alreadyHidden` and `loadedElsewhere` give the
 * hidden and loaded keys of live threads, and `hidingAnywhere` the global flag.
 */
export function hiddenThreadKeys(
  environments: ReadonlyArray<TagFilteredEnvironment>,
  alreadyHidden: ReadonlySet<string> = NO_HIDDEN_THREADS,
  loadedElsewhere: ReadonlySet<string> = NO_HIDDEN_THREADS,
  hidingAnywhere: boolean = environments.some((environment) => environment.hiddenTags !== null),
): ReadonlySet<string> {
  if (alreadyHidden.size === 0 && !hidingAnywhere) return NO_HIDDEN_THREADS;
  const byKey = new Map<
    string,
    { thread: FilterableThread; environment: TagFilteredEnvironment }
  >();
  for (const environment of environments) {
    for (const thread of environment.threads) {
      byKey.set(threadKey({ environmentId: environment.environmentId, threadId: thread.id }), {
        thread,
        environment,
      });
    }
  }
  const hiddenByKey = new Map<string, boolean>();
  const isHidden = (key: string): boolean => {
    if (alreadyHidden.has(key)) return true;
    const known = hiddenByKey.get(key);
    if (known !== undefined) return known;
    const entry = byKey.get(key);
    if (entry === undefined) return false;
    const { thread, environment } = entry;
    const parentKey = visibilityParentKey(environment.environmentId, thread);
    const followsParent =
      parentKey !== null && (byKey.has(parentKey) || alreadyHidden.has(parentKey));
    if (parentKey !== null && !followsParent && loadedElsewhere.has(parentKey)) {
      hiddenByKey.set(key, false);
      return false;
    }
    if (parentKey !== null && !followsParent && hidingAnywhere) {
      hiddenByKey.set(key, true);
      return true;
    }
    if (!followsParent) {
      const hidden = hasHiddenTag(thread.tags, environment.hiddenTags);
      hiddenByKey.set(key, hidden);
      return hidden;
    }
    // Seed before following the parent so a malformed cycle ends visible.
    hiddenByKey.set(key, false);
    const hidden = isHidden(parentKey);
    hiddenByKey.set(key, hidden);
    return hidden;
  };
  const hidden = new Set<string>();
  for (const key of byKey.keys()) {
    if (isHidden(key)) hidden.add(key);
  }
  return hidden.size === 0 ? NO_HIDDEN_THREADS : hidden;
}
