import {
  DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";

import type { OrchestrationShellSnapshot } from "../connection.ts";
import { resolveProjectStatus, type ThreadStatus } from "../theme.ts";

// Pure logic backing the Sidebar (mirrors apps/web/src/components/Sidebar.logic.ts):
// the row model, selection identity, the preview/"show more" windowing, and the
// flat row builder. No rendering, so it's trivially testable.

export type Selection =
  | { readonly kind: "project"; readonly id: string }
  | { readonly kind: "thread"; readonly id: string }
  | { readonly kind: "more"; readonly id: string };

export type Row =
  | {
      readonly kind: "project";
      readonly id: string;
      readonly title: string;
      readonly count: number;
      readonly status: ThreadStatus | null;
      readonly expanded: boolean;
    }
  | { readonly kind: "thread"; readonly id: string; readonly thread: OrchestrationThreadShell }
  | { readonly kind: "more"; readonly id: string; readonly hiddenCount: number };

export function selectionEquals(selection: Selection | null, row: Row): boolean {
  return selection !== null && selection.kind === row.kind && selection.id === row.id;
}

/**
 * Only the top {@link DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT} threads of a project
 * render until its list is loaded in full — mirroring the web sidebar. The
 * currently selected thread is always kept visible.
 */
export function visibleThreadsForProject(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  loadedInFull: boolean,
  selectedThreadId: string | null,
): { readonly visible: OrchestrationThreadShell[]; readonly hidden: number } {
  const limit = DEFAULT_SIDEBAR_THREAD_PREVIEW_COUNT;
  if (loadedInFull || threads.length <= limit) {
    return { visible: [...threads], hidden: 0 };
  }
  const preview = threads.slice(0, limit);
  const selectedHidden =
    selectedThreadId !== null &&
    !preview.some((thread) => thread.id === selectedThreadId) &&
    threads.some((thread) => thread.id === selectedThreadId);
  if (!selectedHidden) {
    return { visible: preview, hidden: threads.length - limit };
  }
  const selected = threads.find((thread) => thread.id === selectedThreadId);
  return {
    visible: selected ? [...preview, selected] : preview,
    hidden: threads.length - limit - (selected ? 1 : 0),
  };
}

/**
 * Pure: build the visible rows from the snapshot + UI state. When `filter` is
 * non-empty, projects auto-expand and only matching threads (or all threads of a
 * project whose own title matches) are shown, with no "show more" row.
 */
export function buildRows(
  shell: OrchestrationShellSnapshot | null,
  expanded: ReadonlySet<string>,
  loadedInFull: ReadonlySet<string>,
  selectedThreadId: string | null,
  filter = "",
): Row[] {
  if (!shell) return [];
  const needle = filter.trim().toLowerCase();
  const projectTitles = new Map<string, string>(
    shell.projects.map((project) => [project.id, project.title]),
  );
  const byProject = new Map<string, OrchestrationThreadShell[]>();
  for (const thread of shell.threads) {
    const list = byProject.get(thread.projectId);
    if (list) list.push(thread);
    else byProject.set(thread.projectId, [thread]);
  }

  // All catalogue projects (so the list matches the "N project(s)" count and an
  // empty project is still visible/selectable), then any orphaned project ids.
  const orderedIds: string[] = [
    ...shell.projects.map((project) => project.id as string),
    ...[...byProject.keys()].filter((id) => !projectTitles.has(id)),
  ];

  const rows: Row[] = [];
  for (const id of orderedIds) {
    const threads = byProject.get(id) ?? [];
    const title = projectTitles.get(id) ?? id;

    if (needle.length > 0) {
      const projectMatches = title.toLowerCase().includes(needle);
      const shown = projectMatches
        ? threads
        : threads.filter((thread) => thread.title.toLowerCase().includes(needle));
      if (shown.length === 0 && !projectMatches) continue;
      rows.push({
        kind: "project",
        id,
        title,
        count: shown.length,
        status: resolveProjectStatus(shown),
        expanded: true,
      });
      for (const thread of shown) rows.push({ kind: "thread", id: thread.id, thread });
      continue;
    }

    const isExpanded = expanded.has(id);
    rows.push({
      kind: "project",
      id,
      title,
      count: threads.length,
      status: resolveProjectStatus(threads),
      expanded: isExpanded,
    });
    if (isExpanded) {
      const { visible, hidden } = visibleThreadsForProject(
        threads,
        loadedInFull.has(id),
        selectedThreadId,
      );
      for (const thread of visible) {
        rows.push({ kind: "thread", id: thread.id, thread });
      }
      if (hidden > 0) {
        rows.push({ kind: "more", id, hiddenCount: hidden });
      }
    }
  }
  return rows;
}
