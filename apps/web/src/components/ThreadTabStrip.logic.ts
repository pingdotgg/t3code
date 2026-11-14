import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";

import type { SidebarThreadSummary } from "../types";
import {
  filterSidebarV2VisibleThreads,
  resolveThreadLastVisitedAt,
  resolveThreadStatusPill,
  type ThreadStatusPill,
} from "./Sidebar.logic";

export interface ThreadTab {
  readonly key: string;
  readonly thread: SidebarThreadSummary;
  readonly status: ThreadStatusPill | null;
  /** Shown only while the thread has a status; it was never added by hand. */
  readonly auto: boolean;
}

/**
 * Added tabs keep their order and skip threads that are gone or hidden. With auto-add on, every
 * other listed thread with a status (Working, Completed, ...) follows, until that status clears.
 */
export function resolveThreadTabs(input: {
  readonly tabKeys: readonly string[];
  readonly threads: readonly SidebarThreadSummary[];
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly localLastVisitedAtByKey: Readonly<Record<string, string | undefined>>;
  readonly autoAddWorking: boolean;
}): ThreadTab[] {
  const visible = filterSidebarV2VisibleThreads(input.threads, null, input.delegatedUnderParent);
  const byKey = new Map(
    visible.map((thread) => [
      scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
      thread,
    ]),
  );
  const statusOf = (key: string, thread: SidebarThreadSummary) =>
    resolveThreadStatusPill({
      thread: {
        ...thread,
        lastVisitedAt: resolveThreadLastVisitedAt(
          thread.lastVisitedAt,
          input.localLastVisitedAtByKey[key],
        ),
      },
    });
  const tabs: ThreadTab[] = [];
  const added = new Set<string>();
  for (const key of input.tabKeys) {
    const thread = byKey.get(key);
    if (thread === undefined || added.has(key)) continue;
    added.add(key);
    tabs.push({ key, thread, status: statusOf(key, thread), auto: false });
  }
  if (!input.autoAddWorking) return tabs;
  for (const [key, thread] of byKey) {
    if (added.has(key)) continue;
    const status = statusOf(key, thread);
    if (status !== null) tabs.push({ key, thread, status, auto: true });
  }
  return tabs;
}
