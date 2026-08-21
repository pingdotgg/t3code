import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import {
  sidebarThreadKey,
  SIDEBAR_DND_SECTIONS,
  type SidebarDndSection,
  type SidebarThreadDragTransaction,
} from "./Sidebar.dnd.logic";

export type SidebarThreadBoardSections = Readonly<
  Record<SidebarDndSection, readonly EnvironmentThreadShell[]>
>;

export function buildSidebarDndBoardSections(input: {
  pinnedThreads: readonly EnvironmentThreadShell[];
  regularThreads: readonly EnvironmentThreadShell[];
  snoozedThreads: readonly EnvironmentThreadShell[];
  settledThreads: readonly EnvironmentThreadShell[];
  transaction: SidebarThreadDragTransaction | null;
}): SidebarThreadBoardSections {
  const sections: Record<SidebarDndSection, EnvironmentThreadShell[]> = {
    pinned: [...input.pinnedThreads],
    regular: [...input.regularThreads],
    snoozed: [...input.snoozedThreads],
    settled: [...input.settledThreads],
  };
  const { transaction } = input;
  if (transaction === null) return sections;

  for (const section of SIDEBAR_DND_SECTIONS) {
    sections[section] = sections[section].filter(
      (thread) => sidebarThreadKey(thread) !== transaction.sourceThreadKey,
    );
  }
  const source = sections[transaction.sourceSection];
  source.splice(Math.min(transaction.sourceIndex, source.length), 0, transaction.sourceThread);
  return sections;
}
