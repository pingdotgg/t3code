import { describe, expect, it } from "vite-plus/test";

import {
  createTaskListSaveQueue,
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

describe("createTaskListSaveQueue", () => {
  const saves = (first: Promise<boolean>) => {
    const saved: string[] = [];
    const save = (body: string) => {
      saved.push(body);
      return saved.length === 1 ? first : Promise.resolve(true);
    };
    return { saved, save };
  };

  it("saves one body at a time, the latest one pushed while a save runs", async () => {
    let finishFirst = (_saved: boolean) => {};
    const { saved, save } = saves(new Promise((resolve) => (finishFirst = resolve)));
    const push = createTaskListSaveQueue();

    const run = push("B", save);
    expect(push("C", save)).toBeNull();
    expect(push("D", save)).toBeNull();
    finishFirst(true);
    expect(await run).toBe(true);
    expect(saved).toEqual(["B", "D"]);
    // A run is over once it settles, so a tick made before the next render starts a new one.
    expect(await push("E", save)).toBe(true);
    expect(saved).toEqual(["B", "D", "E"]);
  });

  it("drops the waiting body when a save fails", async () => {
    let finishFirst = (_saved: boolean) => {};
    const { saved, save } = saves(new Promise((resolve) => (finishFirst = resolve)));
    const push = createTaskListSaveQueue();

    const run = push("B", save);
    push("C", save);
    finishFirst(false);
    expect(await run).toBe(false);
    expect(saved).toEqual(["B"]);
  });
});
