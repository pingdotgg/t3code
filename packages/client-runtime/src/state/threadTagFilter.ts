import {
  type EnvironmentId,
  isListedThreadLineage,
  type OrchestrationV2ThreadShell,
  type ScopedThreadRef,
  type ThreadId,
  ThreadTag,
  threadTagKey,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

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

const isThreadTag = Schema.is(ThreadTag);

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

const tagKeySet = (tags: ReadonlyArray<string>): ReadonlySet<string> =>
  new Set(tags.map(threadTagKey));

/** Whether any of `tags` matches `keys` (from tagKeySet), ignoring case. */
function hasAnyTagKey(tags: ReadonlyArray<string> | undefined, keys: ReadonlySet<string>): boolean {
  return tags !== undefined && keys.size > 0 && tags.some((tag) => keys.has(threadTagKey(tag)));
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
  const hiddenKeySets = new Map<TagFilteredEnvironment, ReadonlySet<string>>();
  const hiddenKeySet = (environment: TagFilteredEnvironment) => {
    let keys = hiddenKeySets.get(environment);
    if (keys === undefined) {
      keys = tagKeySet(environment.hiddenTags ?? []);
      hiddenKeySets.set(environment, keys);
    }
    return keys;
  };
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
      const hidden =
        environment.hiddenTags !== null && hasAnyTagKey(thread.tags, hiddenKeySet(environment));
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

/** Every tag on these threads, deduplicated ignoring case in the first spelling seen, sorted. */
export function collectThreadTags(
  threads: ReadonlyArray<Pick<FilterableThread, "tags">>,
): ReadonlyArray<string> {
  const tags = new Map<string, string>();
  for (const thread of threads) {
    for (const tag of thread.tags ?? []) {
      const key = threadTagKey(tag);
      if (!tags.has(key)) tags.set(key, tag);
    }
  }
  return [...tags.values()].sort((left, right) => left.localeCompare(right));
}

export type ThreadTagInput =
  | { readonly kind: "empty" }
  | { readonly kind: "ok"; readonly tag: string }
  | { readonly kind: "error"; readonly message: string };

/** Checks typed text against the contracts tag rules and the thread's own tags. */
export function validateThreadTag(input: string, own: ReadonlyArray<string>): ThreadTagInput {
  const tag = input.trim();
  if (tag === "") return { kind: "empty" };
  if (tag.length > 64) return { kind: "error", message: "Tags are 64 characters at most." };
  if (!isThreadTag(tag)) return { kind: "error", message: "Tags are one line of text." };
  if (own.some((existing) => threadTagKey(existing) === threadTagKey(tag))) {
    return { kind: "error", message: "Already tagged." };
  }
  return { kind: "ok", tag };
}

export function suggestThreadTags(
  known: ReadonlyArray<string>,
  own: ReadonlyArray<string>,
  query = "",
): ReadonlyArray<string> {
  const needle = threadTagKey(query.trim());
  const ownKeys = tagKeySet(own);
  return known.filter(
    (tag) =>
      !ownKeys.has(threadTagKey(tag)) && (needle === "" || threadTagKey(tag).includes(needle)),
  );
}

type TagFilterThread = Pick<FilterableThread, "id" | "lineage" | "tags"> & {
  readonly environmentId: EnvironmentId;
  readonly delegatedFrom?: FilterableThread["delegatedFrom"] | null;
};

/**
 * Threads to list under a tag filter: threads with any of the tags, the parents they display
 * under, and the children of matching threads, so no match loses the row it nests in.
 */
export function filterThreadsByTag<T extends TagFilterThread>(
  threads: ReadonlyArray<T>,
  tags: ReadonlyArray<string>,
): ReadonlyArray<T> {
  if (tags.length === 0) return threads;
  const parentOf = new Map<string, string | null>();
  const keyOf = (thread: T) =>
    threadKey({ environmentId: thread.environmentId, threadId: thread.id });
  for (const thread of threads) {
    parentOf.set(
      keyOf(thread),
      visibilityParentKey(thread.environmentId, {
        lineage: thread.lineage,
        delegatedFrom: thread.delegatedFrom ?? undefined,
      }),
    );
  }
  const wantedKeys = tagKeySet(tags);
  const keep = new Set<string>();
  const tagged = new Set<string>();
  for (const thread of threads) {
    if (!hasAnyTagKey(thread.tags, wantedKeys)) continue;
    const key = keyOf(thread);
    tagged.add(key);
    // Walk up so a tagged child keeps the parent it nests under; the set guards cycles.
    for (let at: string | null | undefined = key; at != null && !keep.has(at);) {
      keep.add(at);
      at = parentOf.get(at);
    }
  }
  const underTagged = (key: string): boolean => {
    const seen = new Set<string>();
    for (let at = parentOf.get(key); at != null && !seen.has(at); at = parentOf.get(at)) {
      if (tagged.has(at)) return true;
      seen.add(at);
    }
    return false;
  };
  return threads.filter((thread) => {
    const key = keyOf(thread);
    return keep.has(key) || underTagged(key);
  });
}
