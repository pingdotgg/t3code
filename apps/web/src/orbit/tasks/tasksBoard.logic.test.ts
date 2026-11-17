import {
  createOrbitTasksClient,
  orbitTaskEnvironment,
  orbitTaskLabel,
} from "@t3tools/client-runtime/orbit-gateway";
import { describe, expect, it } from "vite-plus/test";

import { fixtureOrbitTasksTransport } from "./orbitTasksFixtures";
import { tasksBoardLanes } from "./tasksBoard.logic";

async function fixtureTasks() {
  const result = await createOrbitTasksClient(fixtureOrbitTasksTransport()).listTasks();
  if (result.status !== "ok") throw new Error(result.message);
  return result.value.tasks;
}

describe("tasks board", () => {
  it("lays fixture tasks out in lanes with their finer labels", async () => {
    const lanes = tasksBoardLanes(await fixtureTasks());
    expect(
      lanes.map((lane) => [
        lane.label,
        lane.tasks.map((task) => [task.id, orbitTaskLabel(task)?.label ?? null]),
      ]),
    ).toEqual([
      ["Backlog", [[520, null]]],
      ["To do", [[510, null]]],
      [
        "In progress",
        [
          [482, "Working"],
          [470, "In review"],
          [465, "Needs answer"],
          [458, "Blocked"],
          [452, "Working"],
        ],
      ],
      [
        "Done",
        [
          [449, "Failed"],
          [440, "Cancelled"],
          [431, null],
        ],
      ],
    ]);
  });

  it("tells the workspace states apart", async () => {
    const tasks = await fixtureTasks();
    expect(
      Object.fromEntries(tasks.map((task) => [task.id, orbitTaskEnvironment(task).kind])),
    ).toEqual({
      520: "not-started",
      510: "not-started",
      482: "ready",
      470: "ready",
      465: "ready",
      458: "stopped",
      452: "unreachable",
      449: "disposed",
      440: "disposed",
      431: "ready",
    });
  });
});
