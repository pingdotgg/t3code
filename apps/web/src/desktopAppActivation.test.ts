import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  handleDesktopAppActivationRequest,
  handleDesktopAppPairRequest,
  type DesktopAppActivationDependencies,
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
    ...overrides,
  };
}

describe("desktop app activation", () => {
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
});

describe("desktop app pairing", () => {
  const pairRequest = {
    version: 1,
    requestId: "request-pair",
    type: "pair-environment",
    pairingUrl: "https://vps.example.com/pair#token=abc",
  } as const;
  const remoteId = EnvironmentId.make("remote");

  it("saves the backend without asking and answers with its environment", async () => {
    const pair = vi.fn(async () => remoteId);

    const response = await handleDesktopAppPairRequest(pairRequest, {
      savedEnvironmentIds: () => new Set([environmentId]),
      pair,
    });

    expect(pair).toHaveBeenCalledWith(pairRequest.pairingUrl);
    expect(response).toEqual({
      version: 1,
      requestId: "request-pair",
      ok: true,
      environmentId: remoteId,
    });
  });

  it("reports a backend that was already saved", async () => {
    const response = await handleDesktopAppPairRequest(pairRequest, {
      savedEnvironmentIds: () => new Set([environmentId, remoteId]),
      pair: async () => remoteId,
    });

    expect(response).toMatchObject({ ok: false, code: "environment-already-saved" });
  });

  it("passes on why pairing failed", async () => {
    const response = await handleDesktopAppPairRequest(pairRequest, {
      savedEnvironmentIds: () => new Set(),
      pair: async () => {
        throw new Error("The pairing code has already been used.");
      },
    });

    expect(response).toMatchObject({
      ok: false,
      code: "pairing-failed",
      message: "The pairing code has already been used.",
    });
  });
});
