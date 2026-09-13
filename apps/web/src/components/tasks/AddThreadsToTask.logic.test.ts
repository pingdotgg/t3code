import { EnvironmentId, ProjectId, TaskId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  addSelectedThreadsToTask,
  filterTaskThreadCandidates,
  taskThreadCandidates,
} from "./AddThreadsToTask.logic";

const environmentId = EnvironmentId.make("local");
const remote = EnvironmentId.make("remote");
const projectId = ProjectId.make("project");
const taskRef = { environmentId, taskId: TaskId.make("destination") };
const sourceTaskId = TaskId.make("source");
const projects = [
  { environmentId, id: projectId, title: "Web app" },
  { environmentId: remote, id: projectId, title: "Remote app" },
];
const tasks = [
  { environmentId, id: sourceTaskId, name: "Release planning" },
  { environmentId: remote, id: sourceTaskId, name: "Remote task" },
];
function thread(
  id: string,
  overrides: Partial<Parameters<typeof taskThreadCandidates>[1][number]> = {},
) {
  return {
    environmentId,
    id: ThreadId.make(id),
    projectId,
    taskId: null,
    archivedAt: null,
    title: id,
    branch: "main",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    latestUserMessageAt: null,
    ...overrides,
  };
}

describe("task thread picker", () => {
  it("offers other members and all projects in the same environment, excluding archived threads and existing members", () => {
    const candidates = taskThreadCandidates(
      taskRef,
      [
        thread("Standalone"),
        thread("Member", { taskId: sourceTaskId }),
        thread("Other project", { projectId: ProjectId.make("other") }),
        thread("Already added", { taskId: taskRef.taskId }),
        thread("Archived", { archivedAt: "2026-09-02T00:00:00.000Z" }),
        thread("Remote", { environmentId: remote }),
      ],
      projects,
      tasks,
    );
    expect(candidates.map((item) => item.title).toSorted()).toEqual([
      "Member",
      "Other project",
      "Standalone",
    ]);
    expect(candidates.find((item) => item.title === "Member")).toMatchObject({
      projectName: "Web app",
      taskName: "Release planning",
    });
  });

  it("orders recent conversations first using the shared thread ordering", () => {
    const candidates = taskThreadCandidates(
      taskRef,
      [thread("Older"), thread("Recent", { latestUserMessageAt: "2026-09-13T00:00:00.000Z" })],
      projects,
      tasks,
    );
    expect(candidates.map((item) => item.title)).toEqual(["Recent", "Older"]);
  });

  it("searches title, project, branch and current task with case-insensitive terms", () => {
    const candidates = taskThreadCandidates(
      taskRef,
      [thread("Fix login", { branch: "auth-fix", taskId: sourceTaskId }), thread("Fix layout")],
      projects,
      tasks,
    );
    expect(
      filterTaskThreadCandidates(candidates, "  LOGIN web AUTH release ").map((item) => item.title),
    ).toEqual(["Fix login"]);
    expect(filterTaskThreadCandidates(candidates, "Remote")).toEqual([]);
    expect(filterTaskThreadCandidates(candidates, "   ")).toEqual(candidates);
  });

  it("removes newly added members from the next candidate snapshot", () => {
    const member = thread("Thread");
    expect(taskThreadCandidates(taskRef, [member], projects, tasks)).toHaveLength(1);
    expect(
      taskThreadCandidates(taskRef, [{ ...member, taskId: taskRef.taskId }], projects, tasks),
    ).toEqual([]);
  });
});

describe("adding selected threads", () => {
  const ids = [ThreadId.make("one"), ThreadId.make("two"), ThreadId.make("three")];

  it("waits for each move before submitting another and deduplicates selections", async () => {
    let completeFirst!: (success: boolean) => void;
    const first = new Promise<boolean>((resolve) => {
      completeFirst = resolve;
    });
    const move = vi
      .fn<(id: ThreadId) => Promise<boolean>>()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(true);
    const pending = addSelectedThreadsToTask([...ids, ids[0]!], move);
    expect(move.mock.calls).toEqual([[ids[0]]]);
    completeFirst(true);
    expect(await pending).toEqual([]);
    expect(move.mock.calls).toEqual(ids.map((id) => [id]));
  });

  it("keeps failures and unattempted selections, so retries do not repeat completed moves", async () => {
    const move = vi
      .fn<(id: ThreadId) => Promise<boolean>>()
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    const remaining = await addSelectedThreadsToTask(ids, move);
    expect(remaining).toEqual(ids.slice(1));
    expect(move).toHaveBeenCalledTimes(2);
    const retry = vi.fn().mockResolvedValue(true);
    expect(await addSelectedThreadsToTask(remaining, retry)).toEqual([]);
    expect(retry.mock.calls).toEqual(ids.slice(1).map((id) => [id]));
  });

  it("preserves selections after an unexpected transport failure", async () => {
    const move = vi.fn().mockRejectedValue(new Error("Connection lost"));
    expect(await addSelectedThreadsToTask(ids, move)).toEqual(ids);
    expect(move).toHaveBeenCalledTimes(1);
  });
});
