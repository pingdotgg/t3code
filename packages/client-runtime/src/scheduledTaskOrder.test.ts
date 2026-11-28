import { ScheduledTaskId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { moveScheduledTask, orderScheduledTasks } from "./scheduledTaskOrder.ts";

const tasks = ["a", "b", "c", "d", "e"].map((id) => ({ id: ScheduledTaskId.make(id) }));
const ids = (list: readonly { readonly id: string }[]) => list.map((task) => task.id);

it("orders by the saved order and puts unsaved tasks first", () => {
  const saved = ["c", "a", "gone", "b"].map((id) => ScheduledTaskId.make(id));
  expect(ids(orderScheduledTasks(tasks, saved))).toEqual(["d", "e", "c", "a", "b"]);
  expect(orderScheduledTasks(tasks, [])).toBe(tasks);
});

it("moves within the visible tasks and keeps hidden tasks in their slots", () => {
  const visible = new Set(["a", "c", "e"].map((id) => ScheduledTaskId.make(id)));
  const move = (from: string, to: string) =>
    moveScheduledTask(tasks, visible, ScheduledTaskId.make(from), ScheduledTaskId.make(to));
  expect(move("a", "e")).toEqual(["c", "b", "e", "d", "a"]);
  expect(move("e", "c")).toEqual(["a", "b", "e", "d", "c"]);
  expect(move("a", "b")).toBeUndefined();
  expect(move("a", "a")).toBeUndefined();
});
