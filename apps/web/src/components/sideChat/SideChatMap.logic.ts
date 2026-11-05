import type { SideChatTreeRow } from "@t3tools/client-runtime/state/thread-relationships";
import { ThreadId } from "@t3tools/contracts";

import type { SideChatTreeLayoutOptions } from "../../lib/sideChatTreeLayout";

export const SIDE_CHAT_MAP_LAYOUT: SideChatTreeLayoutOptions = {
  nodeWidth: 168,
  nodeHeight: 26,
  gapX: 32,
  gapY: 8,
};

export function isSectionRow(row: SideChatTreeRow): boolean {
  return row.state === "lesson" && row.section != null;
}

/** Inserts lesson-section nodes while keeping unsectioned direct chats first. */
export function groupSideChatMapRows(
  rows: ReadonlyArray<SideChatTreeRow>,
  collapsedSections: ReadonlySet<ThreadId> = new Set(),
): ReadonlyArray<SideChatTreeRow> {
  const lesson = rows[0];
  if (lesson === undefined) return rows;
  const direct: Array<{ row: SideChatTreeRow; subtree: ReadonlyArray<SideChatTreeRow> }> = [];
  for (let index = 1; index < rows.length;) {
    const row = rows[index]!;
    if (row.parentId !== lesson.threadId || row.depth !== 1) {
      index += 1;
      continue;
    }
    const start = index;
    index += 1;
    while (index < rows.length && rows[index]!.depth > 1) index += 1;
    direct.push({ row, subtree: rows.slice(start, index) });
  }
  const sectionNames = direct
    .map(({ row }) => row.section ?? null)
    .filter((section): section is string => section !== null);
  if (sectionNames.length === 0) return rows;
  let sectionIndex = 0;
  const usedThreadIds = new Set(rows.map((row) => row.threadId));
  const output: SideChatTreeRow[] = [{ ...lesson, section: null }];
  const appendSubtree = (subtree: ReadonlyArray<SideChatTreeRow>, sectionId: ThreadId | null) => {
    for (const [index, row] of subtree.entries()) {
      const isDirect = index === 0;
      output.push({
        ...row,
        parentId: isDirect && sectionId !== null ? sectionId : row.parentId,
        depth: row.depth + (sectionId === null ? 0 : 1),
      });
    }
  };
  for (const entry of direct.filter(({ row }) => row.section == null)) {
    appendSubtree(entry.subtree, null);
  }
  for (const section of new Set(sectionNames)) {
    let sectionId = ThreadId.make(`section:${sectionIndex++}`);
    while (usedThreadIds.has(sectionId)) {
      sectionId = ThreadId.make(`section:${sectionIndex++}`);
    }
    usedThreadIds.add(sectionId);
    const entries = direct.filter(({ row }) => row.section === section);
    const hidden = collapsedSections.has(sectionId);
    const descendants = entries.flatMap((entry) => entry.subtree);
    output.push({
      threadId: sectionId,
      parentId: lesson.threadId,
      depth: 1,
      label: hidden ? `${section} (${descendants.length})` : section,
      state: "lesson",
      noteStatus: null,
      section,
    });
    if (!hidden) {
      for (const entry of entries) appendSubtree(entry.subtree, sectionId);
    }
  }
  return output;
}

export function sideChatMapCurrentSection(
  rows: ReadonlyArray<SideChatTreeRow>,
  currentThreadId: ThreadId,
): ThreadId | null {
  const grouped = groupSideChatMapRows(rows);
  const lesson = grouped[0];
  if (lesson === undefined) return null;
  if (currentThreadId === lesson.threadId) {
    return grouped.toReversed().find(isSectionRow)?.threadId ?? null;
  }
  let row = grouped.find((candidate) => candidate.threadId === currentThreadId);
  while (row !== undefined && row.parentId !== null) {
    const parent = grouped.find((candidate) => candidate.threadId === row!.parentId);
    if (parent === undefined) break;
    if (isSectionRow(parent)) return parent.threadId;
    row = parent;
  }
  return null;
}

/**
 * Where an arrow key moves focus in the map, which grows left to right: Left to
 * the parent, Right to the first child, Up and Down between siblings. `rows` are
 * in preorder, so a parent's children appear in sibling order and the first one
 * is the first child.
 */
export function resolveSideChatMapKeyTarget(
  rows: ReadonlyArray<SideChatTreeRow>,
  fromThreadId: ThreadId,
  key: string,
): ThreadId | null {
  const from = rows.find((row) => row.threadId === fromThreadId);
  if (from === undefined) return null;

  switch (key) {
    case "ArrowLeft":
      return rows.find((row) => row.threadId === from.parentId)?.threadId ?? null;
    case "ArrowRight":
      return rows.find((row) => row.parentId === from.threadId)?.threadId ?? null;
    case "ArrowUp":
    case "ArrowDown": {
      const siblings = rows.filter((row) => row.parentId === from.parentId);
      const step = key === "ArrowUp" ? -1 : 1;
      return siblings[siblings.indexOf(from) + step]?.threadId ?? null;
    }
    default:
      return null;
  }
}

/** The status `ThreadRelationshipIcon` colours the node's dot for. */
export function sideChatMapNodeStatus(
  row: Pick<SideChatTreeRow, "state" | "noteStatus" | "section">,
): "in_progress" | "pending" | "failed" | "completed" | null {
  if (row.state === "lesson") return null;
  if (row.state === "open") return "in_progress";
  switch (row.noteStatus) {
    case "generating":
      return "pending";
    case "failed":
      return "failed";
    case "ready":
    case "none":
      return "completed";
    case null:
      return null;
  }
}

/** The state in words, for assistive tech: the dot's colour is not enough on its own. */
export function sideChatMapNodeDescription(
  row: Pick<SideChatTreeRow, "state" | "noteStatus" | "section"> & {
    readonly collapsed?: boolean;
  },
): string {
  if (row.state === "lesson" && row.section != null) {
    return row.collapsed === true ? "Section, collapsed" : "Section";
  }
  if (row.state === "lesson") return "Lesson";
  if (row.state === "open") return "Open";
  switch (row.noteStatus) {
    case "generating":
      return "Done, writing note";
    case "failed":
      return "Done, couldn't write the note";
    case "ready":
      return "Done, note ready";
    case "none":
      return "Done, no note needed";
    case null:
      return "Done";
  }
}

/** Shrinks content wider than the panel to fit it; never enlarges it. */
export function fitSideChatMapScale(contentWidth: number, availableWidth: number): number {
  return contentWidth <= 0 || availableWidth <= 0 ? 1 : Math.min(1, availableWidth / contentWidth);
}
