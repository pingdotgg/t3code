import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleDesktopAppActivationRequest,
  type DesktopAppActivationDependencies,
  type DesktopAppActivationThread,
} from "./desktopAppActivation";

const environmentId = EnvironmentId.make("primary");
const existingProjectId = ProjectId.make("project-existing");
const createdProjectId = ProjectId.make("project-created");
const threadId = ThreadId.make("thread-1");
const request = {
  version: 1,
  requestId: "request-1",
  type: "open-workspace",
  workspaceRoot: "/workspace/project",
  platform: "linux",
} as const;
const threadRequest = {
  version: 1,
  requestId: "request-thread",
  type: "open-thread",
  platform: "linux",
  environmentId,
  threadId,
} as const;

function openableThread(
  overrides: Partial<DesktopAppActivationThread> = {},
): DesktopAppActivationThread {
  return {
    environmentId,
    threadId,
    projectId: existingProjectId,
    archivedAt: null,
    ...overrides,
  };
}

function dependencies(
  overrides: Partial<DesktopAppActivationDependencies> = {},
): DesktopAppActivationDependencies {
  return {
    getTarget: () => ({ environmentId, platform: "linux" }),
    findProject: () => ({
      id: existingProjectId,
      environmentId,
      workspaceRoot: request.workspaceRoot,
    }),
    createProject: vi.fn(async () => createdProjectId),
    waitForProject: vi.fn(async () => undefined),
    openThread: vi.fn(async () => ({ threadId })),
    readThreadShell: vi.fn(() => openableThread()),
    navigateToThread: vi.fn(async () => undefined),
    isThreadRouteActive: vi.fn(() => true),
    isRequestActive: vi.fn(async () => true),
    ...overrides,
  };
}

describe("desktop app activation", () => {
  it("reuses an existing project and opens a new thread", async () => {
    const deps = dependencies();

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).toHaveBeenCalledWith({ environmentId, projectId: existingProjectId });
    expect(response).toEqual({
      version: 1,
      requestId: request.requestId,
      ok: true,
      projectId: existingProjectId,
      threadId,
    });
  });

  it("waits for a created project before it opens the thread", async () => {
    const order: string[] = [];
    const deps = dependencies({
      findProject: () => null,
      createProject: vi.fn(async () => {
        order.push("create");
        return createdProjectId;
      }),
      waitForProject: vi.fn(async () => {
        order.push("project-event");
      }),
      openThread: vi.fn(async () => {
        order.push("open-thread");
        return { threadId };
      }),
    });

    const response = await handleDesktopAppActivationRequest(request, deps);

    expect(order).toEqual(["create", "project-event", "open-thread"]);
    expect(response).toMatchObject({ ok: true, projectId: createdProjectId });
  });

  it("rejects a Windows path when the primary environment is WSL", async () => {
    const response = await handleDesktopAppActivationRequest(
      { ...request, platform: "win32" },
      dependencies({ getTarget: () => ({ environmentId, platform: "linux" }) }),
    );

    expect(response).toMatchObject({ ok: false, code: "platform-mismatch" });
  });

  it("returns a project error without opening a thread", async () => {
    const openThread = vi.fn(async () => ({ threadId }));
    const response = await handleDesktopAppActivationRequest(
      request,
      dependencies({
        findProject: () => null,
        createProject: vi.fn(async () => {
          throw new Error("Project path is not available.");
        }),
        openThread,
      }),
    );

    expect(response).toMatchObject({
      ok: false,
      code: "project-create-failed",
      message: "Project path is not available.",
    });
    expect(openThread).not.toHaveBeenCalled();
  });

  it("opens an existing thread and echoes the exact environment, thread and project", async () => {
    const deps = dependencies();

    const response = await handleDesktopAppActivationRequest(threadRequest, deps);

    expect(deps.createProject).not.toHaveBeenCalled();
    expect(deps.openThread).not.toHaveBeenCalled();
    expect(deps.navigateToThread).toHaveBeenCalledWith({ environmentId, threadId });
    expect(response).toEqual({
      version: 1,
      requestId: threadRequest.requestId,
      ok: true,
      environmentId,
      projectId: existingProjectId,
      threadId,
    });
  });

  it("rejects a request for a different environment without substituting the primary", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const response = await handleDesktopAppActivationRequest(
      { ...threadRequest, environmentId: EnvironmentId.make("other") },
      dependencies({ navigateToThread }),
    );

    expect(response).toMatchObject({ ok: false, code: "environment-unavailable" });
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("rejects an open-thread request whose platform does not match the primary environment", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const response = await handleDesktopAppActivationRequest(
      { ...threadRequest, platform: "win32" },
      dependencies({ navigateToThread }),
    );

    expect(response).toMatchObject({ ok: false, code: "platform-mismatch" });
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("returns thread-not-found for a missing thread", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const response = await handleDesktopAppActivationRequest(
      threadRequest,
      dependencies({ readThreadShell: () => null, navigateToThread }),
    );

    expect(response).toMatchObject({ ok: false, code: "thread-not-found" });
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("returns thread-not-found for an archived thread", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const response = await handleDesktopAppActivationRequest(
      threadRequest,
      dependencies({
        readThreadShell: () => openableThread({ archivedAt: "2024-01-01T00:00:00.000Z" }),
        navigateToThread,
      }),
    );

    expect(response).toMatchObject({ ok: false, code: "thread-not-found" });
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("returns thread-not-found when the resolved shell is not the requested thread", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const response = await handleDesktopAppActivationRequest(
      threadRequest,
      dependencies({
        readThreadShell: () => openableThread({ threadId: ThreadId.make("thread-other") }),
        navigateToThread,
      }),
    );

    expect(response).toMatchObject({ ok: false, code: "thread-not-found" });
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("fails safely when the desktop shell cannot report request activity", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const response = await handleDesktopAppActivationRequest(
      threadRequest,
      dependencies({ isRequestActive: undefined, navigateToThread }),
    );

    expect(response).toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("fails safely when the desktop shell cannot read or verify threads", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const response = await handleDesktopAppActivationRequest(
      threadRequest,
      dependencies({ readThreadShell: undefined, navigateToThread }),
    );

    expect(response).toMatchObject({ ok: false, code: "renderer-unavailable" });
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("does not navigate when the request is no longer active", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const response = await handleDesktopAppActivationRequest(
      threadRequest,
      dependencies({ isRequestActive: vi.fn(async () => false), navigateToThread }),
    );

    expect(response).toMatchObject({ ok: false, code: "request-superseded" });
    expect(navigateToThread).not.toHaveBeenCalled();
  });

  it("does not acknowledge a request that stops being active during navigation", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    let checks = 0;
    const isRequestActive = vi.fn(async () => {
      checks += 1;
      return checks === 1;
    });
    const response = await handleDesktopAppActivationRequest(
      threadRequest,
      dependencies({ isRequestActive, navigateToThread }),
    );

    expect(navigateToThread).toHaveBeenCalledOnce();
    expect(response).toMatchObject({ ok: false, code: "request-superseded" });
  });

  it("returns thread-open-failed when navigation rejects", async () => {
    const response = await handleDesktopAppActivationRequest(
      threadRequest,
      dependencies({
        navigateToThread: vi.fn(async () => {
          throw new Error("Navigation failed.");
        }),
      }),
    );

    expect(response).toMatchObject({ ok: false, code: "thread-open-failed" });
  });

  it("does not treat a redirected route as success", async () => {
    const response = await handleDesktopAppActivationRequest(
      threadRequest,
      dependencies({ isThreadRouteActive: vi.fn(() => false) }),
    );

    expect(response).toMatchObject({ ok: false, code: "thread-open-failed" });
  });

  it("does not navigate when the activity probe rejects before navigation", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const response = await handleDesktopAppActivationRequest(
      threadRequest,
      dependencies({
        isRequestActive: vi.fn(async () => {
          throw new Error("The desktop bridge was torn down.");
        }),
        navigateToThread,
      }),
    );

    expect(navigateToThread).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      version: 1,
      requestId: threadRequest.requestId,
      ok: false,
      code: "thread-open-failed",
    });
    // The generic failure must never echo the raw dependency error.
    expect(JSON.stringify(response)).not.toContain("torn down");
  });

  it("does not report success when the activity probe rejects after navigation", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const isRequestActive = vi
      .fn(async () => true)
      .mockResolvedValueOnce(true)
      .mockRejectedValueOnce(new Error("The desktop bridge was torn down."));
    const response = await handleDesktopAppActivationRequest(
      threadRequest,
      dependencies({ isRequestActive, navigateToThread }),
    );

    expect(navigateToThread).toHaveBeenCalledOnce();
    expect(isRequestActive).toHaveBeenCalledTimes(2);
    expect(response).toMatchObject({
      version: 1,
      requestId: threadRequest.requestId,
      ok: false,
      code: "thread-open-failed",
    });
    expect(JSON.stringify(response)).not.toContain("torn down");
  });

  it("does not navigate when the thread is archived while awaiting the activity probe", async () => {
    const navigateToThread = vi.fn(async () => undefined);
    const readThreadShell = vi.fn(() => openableThread({ archivedAt: "2024-01-01T00:00:00.000Z" }));
    readThreadShell.mockReturnValueOnce(openableThread());

    const response = await handleDesktopAppActivationRequest(
      threadRequest,
      dependencies({ readThreadShell, navigateToThread }),
    );

    expect(readThreadShell).toHaveBeenCalledTimes(2);
    expect(navigateToThread).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      version: 1,
      requestId: threadRequest.requestId,
      ok: false,
      code: "thread-not-found",
    });
  });
});
