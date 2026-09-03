import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { ReactNode } from "react";

export interface SidebarThreadAddonContribution {
  readonly addonId: string;
  readonly threadId: string;
  readonly parentThreadId: string | null;
  readonly kind: "parent" | "child" | "standalone";
  readonly compact: ReactNode;
  readonly card: ReactNode;
  readonly cardClassName?: string;
}

export interface SidebarThreadAddonMember<TThread> {
  readonly thread: TThread;
  readonly contribution: SidebarThreadAddonContribution;
}

export interface SidebarThreadAddonGroup<TThread> {
  readonly thread: TThread;
  readonly contribution: SidebarThreadAddonContribution | null;
  readonly children: readonly SidebarThreadAddonMember<TThread>[];
}

export interface SidebarAddon {
  readonly useThreadContributions: (
    threads: readonly EnvironmentThreadShell[],
  ) => readonly SidebarThreadAddonContribution[];
}

export function groupThreadsWithAddonContributions<TThread extends { readonly id: string }>(
  threads: readonly TThread[],
  contributions: readonly SidebarThreadAddonContribution[],
): readonly SidebarThreadAddonGroup<TThread>[] {
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const contributionByThreadId = new Map<string, SidebarThreadAddonContribution>();
  for (const contribution of contributions) {
    if (!contributionByThreadId.has(contribution.threadId)) {
      contributionByThreadId.set(contribution.threadId, contribution);
    }
  }

  const childrenByParentThreadId = new Map<string, SidebarThreadAddonMember<TThread>[]>();
  const childThreadIds = new Set<string>();
  for (const contribution of contributions) {
    if (contribution.parentThreadId === null) continue;
    const thread = threadById.get(contribution.threadId);
    const parent = threadById.get(contribution.parentThreadId);
    if (thread === undefined || parent === undefined) continue;
    const children = childrenByParentThreadId.get(parent.id) ?? [];
    children.push({ thread, contribution });
    childrenByParentThreadId.set(parent.id, children);
    childThreadIds.add(thread.id);
  }

  return threads.flatMap((thread) => {
    if (childThreadIds.has(thread.id)) return [];
    return [
      {
        thread,
        contribution: contributionByThreadId.get(thread.id) ?? null,
        children: childrenByParentThreadId.get(thread.id) ?? [],
      },
    ];
  });
}
