import {
  type EnvironmentId,
  isListedThreadLineage,
  type OrchestrationV2ThreadShell,
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

/**
 * Keys of the threads the tag filter hides. Subagents, side chats and tasks
 * delegated from a linked environment follow the thread they belong to, so
 * hiding a thread hides its children.
 */
export function hiddenThreadKeys(
  environments: ReadonlyArray<TagFilteredEnvironment>,
): ReadonlySet<string> {
  if (!environments.some((environment) => environment.hiddenTags?.length)) {
    return NO_HIDDEN_THREADS;
  }
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
    const known = hiddenByKey.get(key);
    if (known !== undefined) return known;
    const entry = byKey.get(key);
    if (entry === undefined) return false;
    const { thread, environment } = entry;
    const ownTagHidden =
      environment.hiddenTags?.some((tag) => thread.tags?.includes(tag) === true) === true;
    // Seed before following the parent so a malformed cycle ends on the thread's own tags.
    hiddenByKey.set(key, ownTagHidden);
    if (ownTagHidden) return true;
    const parentId = thread.lineage.parentThreadId;
    const parentKey =
      !isListedThreadLineage(thread.lineage) && parentId !== null
        ? threadKey({ environmentId: environment.environmentId, threadId: parentId })
        : thread.delegatedFrom === undefined
          ? null
          : threadKey(thread.delegatedFrom);
    const hidden = parentKey !== null && isHidden(parentKey);
    hiddenByKey.set(key, hidden);
    return hidden;
  };
  const hidden = new Set<string>();
  for (const key of byKey.keys()) {
    if (isHidden(key)) hidden.add(key);
  }
  return hidden.size === 0 ? NO_HIDDEN_THREADS : hidden;
}
