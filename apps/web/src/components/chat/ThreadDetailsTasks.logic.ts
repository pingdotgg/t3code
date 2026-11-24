import type { ThreadTodoList } from "../../state/entities";

export type TodoStep = ThreadTodoList["steps"][number];
export type TodoStatus = TodoStep["status"];

export interface TodoPhase {
  readonly id: string;
  readonly title: string;
  readonly status: TodoStatus;
  readonly done: number;
  readonly steps: ReadonlyArray<TodoStep>;
}

export interface TodoOutline {
  /** Steps before the first phase heading, or every step when the list has no phases. */
  readonly loose: ReadonlyArray<TodoStep>;
  readonly phases: ReadonlyArray<TodoPhase>;
  readonly done: number;
  readonly total: number;
}

// "Phase 2: Backend", "Phase 2 - Backend", "Phase 2. Backend", "phase 2 — Backend".
const PHASE_HEADING = /^\s*phase\s+\d+\s*[:.\-–—]\s*(.+)$/i;

/** A phase is done when all its steps are, running when any step has started, else pending. */
function phaseStatus(heading: TodoStep, steps: ReadonlyArray<TodoStep>): TodoStatus {
  if (steps.length === 0) return heading.status;
  if (steps.every((step) => step.status === "completed")) return "completed";
  if (steps.some((step) => step.status !== "pending")) return "running";
  return "pending";
}

/**
 * Groups a flat todo list into phases. A step whose text starts with "Phase N:" opens a phase
 * and the steps after it belong to that phase. Counts cover the steps, not the phase headings;
 * a phase without steps counts as one step.
 */
export function outlineTodoSteps(steps: ReadonlyArray<TodoStep>): TodoOutline {
  const loose: TodoStep[] = [];
  const groups: Array<{ heading: TodoStep; title: string; steps: TodoStep[] }> = [];
  for (const step of steps) {
    const match = PHASE_HEADING.exec(step.text);
    if (match) {
      groups.push({ heading: step, title: step.text.trim(), steps: [] });
    } else if (groups.length > 0) {
      groups.at(-1)!.steps.push(step);
    } else {
      loose.push(step);
    }
  }
  const phases = groups.map(({ heading, title, steps: phaseSteps }): TodoPhase => {
    const status = phaseStatus(heading, phaseSteps);
    const done =
      phaseSteps.length === 0
        ? Number(status === "completed")
        : phaseSteps.filter((step) => step.status === "completed").length;
    return { id: heading.id, title, status, done, steps: phaseSteps };
  });
  const counted = [
    ...loose,
    ...groups.flatMap((group) => (group.steps.length === 0 ? [group.heading] : group.steps)),
  ];
  return {
    loose,
    phases,
    done: counted.filter((step) => step.status === "completed").length,
    total: counted.length,
  };
}
