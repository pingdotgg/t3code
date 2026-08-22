import {
  createSidebarDndSectionId,
  sidebarThreadKey,
  SIDEBAR_DND_SECTIONS,
  type SidebarDndSection,
  type SidebarThreadDropTarget,
} from "./Sidebar.dnd.logic";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

export type SidebarDndBoardEntry =
  | {
      readonly kind: "boundary";
      readonly id: string;
      readonly section: SidebarDndSection;
    }
  | {
      readonly kind: "thread";
      readonly id: string;
      readonly thread: EnvironmentThreadShell;
    };

export function buildSidebarDndBoardEntries(input: {
  pinnedThreads: readonly EnvironmentThreadShell[];
  regularThreads: readonly EnvironmentThreadShell[];
  snoozedThreads: readonly EnvironmentThreadShell[];
  settledThreads: readonly EnvironmentThreadShell[];
}): readonly SidebarDndBoardEntry[] {
  const threadsBySection = {
    pinned: input.pinnedThreads,
    regular: input.regularThreads,
    snoozed: input.snoozedThreads,
    settled: input.settledThreads,
  } satisfies Readonly<Record<SidebarDndSection, readonly EnvironmentThreadShell[]>>;

  const entries: SidebarDndBoardEntry[] = [];
  for (const section of SIDEBAR_DND_SECTIONS) {
    entries.push({
      kind: "boundary",
      id: createSidebarDndSectionId({ section }),
      section,
    });
    entries.push(
      ...threadsBySection[section].map((thread) => ({
        kind: "thread" as const,
        id: sidebarThreadKey(thread),
        thread,
      })),
    );
  }
  return entries;
}

export function findSidebarDndBoardThreadSection(
  entries: readonly SidebarDndBoardEntry[],
  threadKey: string,
): SidebarDndSection | null {
  let section: SidebarDndSection | null = null;
  for (const entry of entries) {
    if (entry.kind === "boundary") {
      section = entry.section;
      continue;
    }
    if (entry.id === threadKey) return section;
  }
  return null;
}

export function moveSidebarDndBoardThread(input: {
  entries: readonly SidebarDndBoardEntry[];
  threadKey: string;
  target: SidebarThreadDropTarget;
}): readonly SidebarDndBoardEntry[] {
  const activeEntry = input.entries.find(
    (entry) => entry.kind === "thread" && entry.id === input.threadKey,
  );
  if (activeEntry === undefined) return input.entries;

  const entries = input.entries.filter((entry) => entry.id !== input.threadKey);
  const targetId =
    input.target.threadKey ?? createSidebarDndSectionId({ section: input.target.section });
  const targetIndex = entries.findIndex((entry) => entry.id === targetId);
  if (targetIndex === -1) return input.entries;

  const insertionIndex =
    input.target.threadKey === null || input.target.edge === "after"
      ? targetIndex + 1
      : targetIndex;
  entries.splice(insertionIndex, 0, activeEntry);
  return entries.every((entry, index) => entry.id === input.entries[index]?.id)
    ? input.entries
    : entries;
}
