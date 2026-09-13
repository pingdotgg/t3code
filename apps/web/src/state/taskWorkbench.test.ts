import { EnvironmentId, ProjectId, TaskId, ThreadId } from "@t3tools/contracts";
import { beforeEach, expect, it, vi } from "vite-plus/test";
const mocks = vi.hoisted(() => ({
  thread: vi.fn(),
  task: vi.fn(),
  toast: vi.fn(),
  projects: vi.fn(),
  configs: vi.fn(),
  status: vi.fn(),
}));
vi.mock("./entities", () => ({
  readThreadShell: mocks.thread,
  readProjects: mocks.projects,
  useProjects: vi.fn(),
  useServerConfigs: vi.fn(),
}));
vi.mock("./tasks", () => ({ readTask: mocks.task, useTask: vi.fn() }));
vi.mock("../composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ getDraftThreadByRef: () => null }) },
}));
vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: string) => (atom === "config" ? mocks.configs() : { status: mocks.status() }),
  },
}));
vi.mock("./shell", () => ({ environmentShell: { stateValueAtom: () => "shell" } }));
vi.mock("./server", () => ({ environmentServerConfigsAtom: "config" }));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (input: unknown) => input,
  toastManager: { add: mocks.toast },
}));
import { canLaunchWorkbenchOwner, readWorkbenchOwner, readWorkbenchRef } from "./taskWorkbench";
const environmentId = EnvironmentId.make("one");
const ref = { environmentId, threadId: ThreadId.make("thread") };
const thread = { environmentId, projectId: ProjectId.make("project"), worktreePath: null };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.projects.mockReturnValue([]);
  mocks.configs.mockReturnValue(new Map());
  mocks.status.mockReturnValue("cached");
});
it("routes a known standalone click while projects/configs are loading", () => {
  mocks.thread.mockReturnValue(thread);
  expect(readWorkbenchOwner(ref)).toEqual({ status: "ready", ownerRef: ref });
  expect(readWorkbenchRef(ref)).toEqual(ref);
});
it("keeps known membership in its task namespace even while capability is unknown", () => {
  const taskId = TaskId.make("task");
  mocks.thread.mockReturnValue({ ...thread, taskId });
  mocks.task.mockReturnValue({ environmentId, id: taskId, primaryProjectId: thread.projectId });
  expect(readWorkbenchOwner(ref)).toEqual({
    status: "ready",
    ownerRef: { ...ref, threadId: "task:task" },
  });
});
it("reports missing identity instead of silently dropping the click or falling back", () => {
  mocks.thread.mockReturnValue(null);
  expect(readWorkbenchOwner(ref)).toEqual({ status: "unavailable", reason: "loading" });
  expect(readWorkbenchRef(ref)).toBeNull();
  expect(mocks.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "Workbench unavailable" }),
  );
});

it("does not borrow a new task's launch authority for a captured standalone owner", () => {
  const taskId = TaskId.make("task");
  mocks.projects.mockReturnValue([
    { environmentId, id: thread.projectId, workspaceRoot: "/project" },
  ]);
  mocks.configs.mockReturnValue(
    new Map([[environmentId, { environment: { capabilities: { tasks: true } } }]]),
  );
  mocks.status.mockReturnValue("live");
  mocks.thread.mockReturnValue(thread);
  expect(canLaunchWorkbenchOwner(ref)).toBe(true);
  mocks.thread.mockReturnValue({ ...thread, taskId });
  mocks.task.mockReturnValue({ environmentId, id: taskId, primaryProjectId: thread.projectId });
  expect(canLaunchWorkbenchOwner(ref)).toBe(false);
  mocks.thread.mockClear();
  expect(canLaunchWorkbenchOwner({ ...ref, threadId: ThreadId.make("task:task") })).toBe(true);
  expect(mocks.thread).not.toHaveBeenCalled();
});
