import { scopeProjectRef } from "@t3tools/client-runtime";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  __resetOpenProjectByPathInFlight,
  openProjectByPath,
  type OpenProjectByPathInput,
} from "./openProjectByPath";

const ENV = EnvironmentId.make("environment-local");
const PROJECT_ID = ProjectId.make("00000000-0000-4000-8000-000000000001");
const THREAD_ID = ThreadId.make("00000000-0000-4000-8000-000000000002");

function makeInput(overrides: Partial<OpenProjectByPathInput> = {}): {
  input: OpenProjectByPathInput;
  dispatchCommand: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  handleNewThread: ReturnType<typeof vi.fn>;
  onError: ReturnType<typeof vi.fn>;
} {
  const dispatchCommand = vi.fn(async () => ({ sequence: 1 }));
  const navigate = vi.fn(async () => undefined);
  const handleNewThread = vi.fn(async () => undefined);
  const onError = vi.fn();

  const input: OpenProjectByPathInput = {
    environmentId: ENV,
    path: "/tmp/project-sample",
    api: { orchestration: { dispatchCommand } } as unknown as OpenProjectByPathInput["api"],
    projects: [],
    threads: [],
    sidebarThreadSortOrder: "updated_at",
    defaultThreadEnvMode: "local",
    navigate: navigate as unknown as OpenProjectByPathInput["navigate"],
    handleNewThread,
    onError,
    ...overrides,
  };

  return { input, dispatchCommand, navigate, handleNewThread, onError };
}

describe("openProjectByPath", () => {
  afterEach(() => {
    __resetOpenProjectByPathInFlight();
    vi.clearAllMocks();
  });

  it("navigates to the latest thread for a known project", async () => {
    const { input, dispatchCommand, navigate, handleNewThread } = makeInput({
      projects: [{ id: PROJECT_ID, environmentId: ENV, cwd: "/tmp/project-sample" }],
      threads: [
        {
          id: THREAD_ID,
          environmentId: ENV,
          projectId: PROJECT_ID,
          archivedAt: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-02T00:00:00.000Z",
        },
      ],
    });

    await openProjectByPath(input);

    expect(dispatchCommand).not.toHaveBeenCalled();
    expect(handleNewThread).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: ENV, threadId: THREAD_ID },
    });
  });

  it("creates a new thread when a known project has none", async () => {
    const { input, dispatchCommand, navigate, handleNewThread } = makeInput({
      projects: [{ id: PROJECT_ID, environmentId: ENV, cwd: "/tmp/project-sample" }],
      threads: [],
    });

    await openProjectByPath(input);

    expect(dispatchCommand).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(handleNewThread).toHaveBeenCalledTimes(1);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENV, PROJECT_ID), {
      envMode: "local",
    });
  });

  it("dispatches project.create then creates a thread when the path is unknown", async () => {
    const { input, dispatchCommand, handleNewThread, navigate } = makeInput();

    await openProjectByPath(input);

    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    const dispatched = dispatchCommand.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(dispatched).toMatchObject({
      type: "project.create",
      workspaceRoot: "/tmp/project-sample",
      title: "project-sample",
      createWorkspaceRootIfMissing: true,
      defaultModelSelection: { provider: "codex" },
    });
    expect(typeof dispatched.projectId).toBe("string");
    expect(typeof dispatched.commandId).toBe("string");
    expect(handleNewThread).toHaveBeenCalledTimes(1);
    const [ref] = handleNewThread.mock.calls[0] ?? [];
    expect(ref).toEqual(scopeProjectRef(ENV, dispatched.projectId as ProjectId));
    expect(navigate).not.toHaveBeenCalled();
  });

  it("fans out onError to every concurrent caller when the shared dispatch fails", async () => {
    let rejectDispatch: ((error: Error) => void) | undefined;
    const dispatchCommand = vi.fn(
      () =>
        new Promise<{ sequence: number }>((_resolve, reject) => {
          rejectDispatch = reject;
        }),
    );
    const handleNewThread = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);

    const onErrorFirst = vi.fn();
    const onErrorSecond = vi.fn();

    const makeCallInput = (onError: (error: unknown) => void): OpenProjectByPathInput => ({
      environmentId: ENV,
      path: "/tmp/project-sample",
      api: { orchestration: { dispatchCommand } } as unknown as OpenProjectByPathInput["api"],
      projects: [],
      threads: [],
      sidebarThreadSortOrder: "updated_at",
      defaultThreadEnvMode: "local",
      navigate: navigate as unknown as OpenProjectByPathInput["navigate"],
      handleNewThread,
      onError,
    });

    const firstCall = openProjectByPath(makeCallInput(onErrorFirst));
    const secondCall = openProjectByPath(makeCallInput(onErrorSecond));

    expect(dispatchCommand).toHaveBeenCalledTimes(1);

    rejectDispatch?.(new Error("ws down"));
    await Promise.all([firstCall, secondCall]);

    expect(onErrorFirst).toHaveBeenCalledTimes(1);
    expect(onErrorSecond).toHaveBeenCalledTimes(1);
    expect(handleNewThread).not.toHaveBeenCalled();
  });

  it("coalesces concurrent calls for the same path into one dispatch", async () => {
    let resolveDispatch: ((result: { sequence: number }) => void) | undefined;
    const dispatchCommand = vi.fn(
      () =>
        new Promise<{ sequence: number }>((resolve) => {
          resolveDispatch = resolve;
        }),
    );
    const handleNewThread = vi.fn(async () => undefined);
    const navigate = vi.fn(async () => undefined);

    const input: OpenProjectByPathInput = {
      environmentId: ENV,
      path: "/tmp/project-sample",
      api: { orchestration: { dispatchCommand } } as unknown as OpenProjectByPathInput["api"],
      projects: [],
      threads: [],
      sidebarThreadSortOrder: "updated_at",
      defaultThreadEnvMode: "local",
      navigate: navigate as unknown as OpenProjectByPathInput["navigate"],
      handleNewThread,
    };

    const firstCall = openProjectByPath(input);
    const secondCall = openProjectByPath(input);

    expect(dispatchCommand).toHaveBeenCalledTimes(1);

    resolveDispatch?.({ sequence: 1 });
    await Promise.all([firstCall, secondCall]);

    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(handleNewThread).toHaveBeenCalledTimes(1);
  });

  it("calls onError if the dispatch rejects", async () => {
    const dispatchCommand = vi.fn(async () => {
      throw new Error("ws down");
    });
    const { input, onError, handleNewThread } = makeInput({
      api: { orchestration: { dispatchCommand } } as unknown as OpenProjectByPathInput["api"],
    });

    await openProjectByPath(input);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(handleNewThread).not.toHaveBeenCalled();
  });

  it("calls onError if navigate rejects on the found-project branch", async () => {
    const navigate = vi.fn(async () => {
      throw new Error("route gone");
    });
    const { input, onError } = makeInput({
      navigate: navigate as unknown as OpenProjectByPathInput["navigate"],
      projects: [{ id: PROJECT_ID, environmentId: ENV, cwd: "/tmp/project-sample" }],
      threads: [
        {
          id: THREAD_ID,
          environmentId: ENV,
          projectId: PROJECT_ID,
          archivedAt: null,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-02T00:00:00.000Z",
        },
      ],
    });

    await openProjectByPath(input);

    expect(navigate).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("calls onError if handleNewThread rejects on the found-project branch", async () => {
    const handleNewThread = vi.fn(async () => {
      throw new Error("thread create failed");
    });
    const { input, onError } = makeInput({
      handleNewThread,
      projects: [{ id: PROJECT_ID, environmentId: ENV, cwd: "/tmp/project-sample" }],
      threads: [],
    });

    await openProjectByPath(input);

    expect(handleNewThread).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
