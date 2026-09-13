import type { TaskOrderRow } from "@t3tools/client-runtime/state/task-grouping";
import type { createMobileTaskMovePlanner } from "./taskOrder";
import type { ThreadDragSection, ThreadMoveDestination } from "./threadOrder";

export type TaskArrangementRow = {
  key: string;
  label: string;
  section: ThreadDragSection;
  row?: TaskOrderRow;
  member?: boolean;
  offset: number;
  height: number;
};
export type TaskArrangementDestination = Exclude<ThreadMoveDestination, string>;

/** A task and its visible children occupy one lifted block. */
export function taskArrangementBlock(rows: readonly TaskArrangementRow[], sourceId: string) {
  const index = rows.findIndex((item) => item.row?.id === sourceId);
  const source = rows[index];
  if (!source?.row) return null;
  let height = source.height;
  if (source.row.kind === "task") {
    for (let i = index + 1; i < rows.length && rows[i]?.member; i++) height += rows[i]!.height;
  }
  return { source, height };
}

/** Hit testing stays in original geometry; members never leave their sibling inventory. */
export function taskArrangementDestination(input: {
  rows: readonly TaskArrangementRow[];
  sourceId: string;
  contentY: number;
  planner: ReturnType<typeof createMobileTaskMovePlanner>;
  canChangeSection: (row: TaskOrderRow, section: "pinned" | "active" | "settled") => boolean;
  cancelled?: boolean;
}): TaskArrangementDestination | null {
  if (input.cancelled) return null;
  const source = input.rows.find((item) => item.row?.id === input.sourceId);
  if (!source?.row || !input.planner.byId.has(input.sourceId)) return null;
  let target =
    input.rows.find((item) => input.contentY < item.offset + item.height) ?? input.rows.at(-1);
  if (!target || target.section === "snoozed") return null;
  if (!source.member && target.member) {
    const member = target.row;
    target = input.rows.find(
      (item) =>
        item.row?.kind === "task" &&
        member?.kind === "thread" &&
        item.row.entity.id === member.entity.taskId &&
        item.row.environmentId === member.environmentId,
    );
    if (!target || target.section === "snoozed") return null;
  }
  if (target.section !== source.section) {
    if (
      source.member ||
      source.row.kind === "task" ||
      !input.canChangeSection(source.row, target.section)
    )
      return null;
    return { section: target.section, targetId: null, placement: "before" };
  }
  if (target.section === "settled" || source.member !== target.member) return null;
  const candidate = {
    section: source.member ? undefined : target.section,
    targetId: target.row?.id ?? null,
    placement: input.contentY < target.offset + target.height / 2 ? "before" : "after",
  } as const;
  const plan = input.planner.plan(source.row, candidate);
  return plan && !plan.crossSection ? candidate : null;
}

export function taskArrangementInsertionOffset(
  rows: readonly TaskArrangementRow[],
  destination: TaskArrangementDestination,
) {
  const target = rows.find((item) => item.key === (destination.targetId ?? destination.section));
  if (!target) return null;
  if (!target.row) return target.offset + target.height;
  const height = taskArrangementBlock(rows, target.key)?.height ?? target.height;
  return target.offset + (destination.placement === "after" ? height : 0);
}
