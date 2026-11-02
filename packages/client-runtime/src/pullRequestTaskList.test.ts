import { describe, expect, it } from "vite-plus/test";

import {
  shownTaskListBody,
  taskListEditEnded,
  tickTaskListEdit,
  type TaskListEdit,
} from "./pullRequestTaskList.ts";

const saved = (edit: TaskListEdit): TaskListEdit => ({ ...edit, saving: false });

describe("TaskListEdit", () => {
  it("shows the ticks until the host returns a body from after them", () => {
    const first = tickTaskListEdit(null, "A", "B");
    const second = tickTaskListEdit(first, "A", "C");
    expect(shownTaskListBody(second, "A")).toBe("C");

    // A refresh can still carry a body from before the latest tick, even after the saves.
    const done = saved(second);
    for (const stale of ["A", "B"]) {
      expect(shownTaskListBody(done, stale)).toBe("C");
      expect(taskListEditEnded(done, stale)).toBe(false);
    }
    expect(taskListEditEnded(second, "C")).toBe(false);
    expect(taskListEditEnded(done, "C")).toBe(true);
    expect(taskListEditEnded(done, "Edited on the host")).toBe(true);
  });

  it("ends a tick undone before its save, so later host changes show", () => {
    const undone = saved(tickTaskListEdit(tickTaskListEdit(null, "A", "B"), "A", "A"));
    expect(taskListEditEnded(undone, "A")).toBe(true);
  });
});
