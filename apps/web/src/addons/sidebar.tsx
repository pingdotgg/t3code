import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import type { ReactNode } from "react";

export interface SidebarThreadAddonContributionInput {
  /** Stable within one addon; used to preserve contributed UI state. */
  readonly contributionId: string;
  readonly threadRef: ScopedThreadRef;
  readonly parentThreadRef: ScopedThreadRef | null;
  readonly kind: "parent" | "child" | "standalone";
  readonly compact: ReactNode;
  readonly card: ReactNode;
  readonly cardClassName?: string;
}

export interface SidebarThreadAddonContribution extends SidebarThreadAddonContributionInput {
  /** Supplied by the host from the trusted addon manifest. */
  readonly addonId: string;
}

export interface SidebarThreadAddonPresentation {
  readonly kind: "parent" | "child" | "standalone";
  readonly contributions: readonly SidebarThreadAddonContribution[];
}

export interface SidebarThreadAddonMember<TThread> {
  readonly thread: TThread;
  readonly presentation: SidebarThreadAddonPresentation;
}

export interface SidebarThreadAddonGroup<TThread> {
  readonly thread: TThread;
  readonly presentation: SidebarThreadAddonPresentation | null;
  readonly children: readonly SidebarThreadAddonMember<TThread>[];
}

export interface SidebarAddon {
  readonly useThreadContributions: (
    threads: readonly EnvironmentThreadShell[],
  ) => readonly SidebarThreadAddonContributionInput[];
}

export function flattenSidebarAddonGroups<TThread>(
  groups: readonly SidebarThreadAddonGroup<TThread>[],
): readonly TThread[] {
  return groups.flatMap((group) => [group.thread, ...group.children.map((child) => child.thread)]);
}

function threadKey(thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

/**
 * Build the one-level row model consumed by both rendering and navigation.
 *
 * UI from multiple addons composes on a row. A child relationship is accepted
 * only when every addon that claims one agrees on the same present parent.
 * Missing, conflicting, cyclic, and nested parentage falls back to a top-level
 * row so an addon can never make a core thread inaccessible.
 */
export function groupThreadsWithAddonContributions<
  TThread extends { readonly environmentId: EnvironmentId; readonly id: ThreadId },
>(
  threads: readonly TThread[],
  contributions: readonly SidebarThreadAddonContribution[],
): readonly SidebarThreadAddonGroup<TThread>[] {
  const threadByKey = new Map(threads.map((thread) => [threadKey(thread), thread]));
  const contributionsByThreadKey = new Map<string, SidebarThreadAddonContribution[]>();

  for (const contribution of contributions) {
    const key = scopedThreadKey(contribution.threadRef);
    if (!threadByKey.has(key)) continue;
    const existing = contributionsByThreadKey.get(key) ?? [];
    existing.push(contribution);
    contributionsByThreadKey.set(key, existing);
  }

  const proposedParentByChildKey = new Map<string, string>();
  for (const [childKey, threadContributions] of contributionsByThreadKey) {
    const claimedParentKeys = new Set(
      threadContributions.flatMap((contribution) => {
        if (contribution.kind !== "child" || contribution.parentThreadRef === null) return [];
        const parentKey = scopedThreadKey(contribution.parentThreadRef);
        return parentKey !== childKey ? [parentKey] : [];
      }),
    );
    const claimedParentKey = claimedParentKeys.size === 1 ? [...claimedParentKeys][0] : undefined;
    if (claimedParentKey !== undefined && threadByKey.has(claimedParentKey)) {
      proposedParentByChildKey.set(childKey, claimedParentKey);
    }
  }

  const attachedParentByChildKey = new Map<string, string>();
  for (const [childKey, parentKey] of proposedParentByChildKey) {
    // The sidebar deliberately supports one parent/child level. If the parent
    // is itself a child, leave this row top-level rather than dropping a
    // grandchild or creating a cycle that the renderer cannot represent.
    if (proposedParentByChildKey.has(parentKey)) continue;
    attachedParentByChildKey.set(childKey, parentKey);
  }

  const childrenByParentKey = new Map<string, SidebarThreadAddonMember<TThread>[]>();
  for (const thread of threads) {
    const childKey = threadKey(thread);
    const parentKey = attachedParentByChildKey.get(childKey);
    if (parentKey === undefined) continue;
    const threadContributions = contributionsByThreadKey.get(childKey) ?? [];
    const children = childrenByParentKey.get(parentKey) ?? [];
    children.push({
      thread,
      presentation: { kind: "child", contributions: threadContributions },
    });
    childrenByParentKey.set(parentKey, children);
  }

  return threads.flatMap((thread) => {
    const key = threadKey(thread);
    if (attachedParentByChildKey.has(key)) return [];

    const threadContributions = contributionsByThreadKey.get(key) ?? [];
    const rootKind = threadContributions.some((contribution) => contribution.kind === "parent")
      ? "parent"
      : "standalone";
    return [
      {
        thread,
        presentation:
          threadContributions.length === 0
            ? null
            : { kind: rootKind, contributions: threadContributions },
        children: childrenByParentKey.get(key) ?? [],
      },
    ];
  });
}
