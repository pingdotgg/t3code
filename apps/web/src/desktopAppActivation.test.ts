import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { Atom, AtomRegistry } from "effect/reactivity";
import { waitForAtomValue } from "./state/waitForAtomValue";

import {
  handleDesktopAppActivationRequest,
  findWslActivationTarget,
  resolveDesktopActivationTarget,
  openedProjectDraft,
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
    waitForSnapshot: async () => true,
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
  it("waits for the requested environment when the other connects first", async () => {
    const wsl = EnvironmentId.make("wsl");
    const primary = {
      environmentId,
      backendId: "primary",
      connected: false,
      platform: "windows" as const,
    };
    const linux = {
      environmentId: wsl,
      backendId: "wsl",
      connected: false,
      platform: "linux" as const,
    };
    const bootstraps = [{ id: "wsl", runningDistro: "Ubuntu" }];
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    for (const wslRequest of [false, true]) {
      const candidates = Atom.make(
        wslRequest
          ? [{ ...primary, connected: true }, linux]
          : [primary, { ...linux, connected: true }],
      );
      const activationRequest = wslRequest
        ? { ...request, wslDistro: "Ubuntu" }
        : { ...request, platform: "win32" as const };
      const target = Atom.make((get) =>
        resolveDesktopActivationTarget(
          activationRequest,
          environmentId,
          get(candidates),
          bootstraps,
        ),
      );
      expect(registry.get(target)).toBeNull();
      const waiting = waitForAtomValue({
        registry,
        atom: target,
        predicate: (value) => value !== null,
        timeoutMs: 5_000,
      });
      registry.set(candidates, [
        { ...primary, connected: true },
        { ...linux, connected: true },
      ]);
      expect(await waiting).toBe(true);
      expect(registry.get(target)?.environmentId).toBe(wslRequest ? wsl : environmentId);
    }
  });
  it("waits for the requested target before looking up its project", async () => {
    let releaseTarget!: (target: {
      environmentId: typeof environmentId;
      platform: "linux";
    }) => void;
    const target = new Promise<{ environmentId: typeof environmentId; platform: "linux" }>(
      (resolve) => {
        releaseTarget = resolve;
      },
    );
    const findProject = vi.fn(() => ({
      id: existingProjectId,
      environmentId,
      workspaceRoot: request.workspaceRoot,
    }));
    const activation = handleDesktopAppActivationRequest(
      request,
      dependencies({ getTarget: () => target, findProject }),
    );
    expect(findProject).not.toHaveBeenCalled();
    releaseTarget({ environmentId, platform: "linux" });
    expect(await activation).toMatchObject({ ok: true, projectId: existingProjectId });
    const response = await handleDesktopAppActivationRequest(
      request,
      dependencies({ getTarget: () => null }),
    );
    expect(response).toMatchObject({ ok: false, code: "environment-unavailable" });
  });
  it("waits for the target environment snapshot before looking up a project", async () => {
    let releaseSnapshot!: (ready: boolean) => void;
    const snapshot = new Promise<boolean>((resolve) => {
      releaseSnapshot = resolve;
    });
    const findProject = vi.fn(() => ({
      id: existingProjectId,
      environmentId,
      workspaceRoot: request.workspaceRoot,
    }));
    const deps = dependencies({ waitForSnapshot: () => snapshot, findProject });
    const activation = handleDesktopAppActivationRequest(request, deps);
    expect(findProject).not.toHaveBeenCalled();
    releaseSnapshot(true);
    expect(await activation).toMatchObject({ ok: true, projectId: existingProjectId });
    expect(findProject).toHaveBeenCalledOnce();
    const unavailable = dependencies({ waitForSnapshot: async () => false, findProject });
    findProject.mockClear();
    expect(await handleDesktopAppActivationRequest(request, unavailable)).toMatchObject({
      ok: false,
      code: "environment-unavailable",
    });
    expect(findProject).not.toHaveBeenCalled();
  });
  it("accepts a concurrently opened draft only for the requested project and environment", () => {
    const project = { environmentId, projectId: createdProjectId };
    const draft = { ...project, threadId };
    expect(openedProjectDraft(project, draft)).toEqual({ threadId });
    expect(openedProjectDraft(project, { ...draft, projectId: existingProjectId })).toBeNull();
    expect(
      openedProjectDraft(project, { ...draft, promotedTo: { environmentId, threadId } }),
    ).toBeNull();
    expect(
      openedProjectDraft(project, { ...draft, environmentId: EnvironmentId.make("other") }),
    ).toBeNull();
    expect(openedProjectDraft(project, null)).toBeNull();
  });
  it("selects only the connected backend running the requested WSL distro", () => {
    const ubuntu = EnvironmentId.make("ubuntu");
    const debian = EnvironmentId.make("debian");
    const candidates = [
      {
        environmentId: debian,
        backendId: "wsl:default",
        connected: true,
        platform: "linux" as const,
      },
      {
        environmentId: ubuntu,
        backendId: "wsl:Ubuntu",
        connected: true,
        platform: "linux" as const,
      },
    ];
    const bootstraps = [
      { id: "wsl:default", runningDistro: "Debian" },
      { id: "wsl:Ubuntu", runningDistro: "Ubuntu" },
    ];
    expect(findWslActivationTarget("ubuntu", candidates, bootstraps)).toEqual({
      environmentId: ubuntu,
      platform: "linux",
    });
    expect(findWslActivationTarget("Ubuntu", [candidates[0]!], bootstraps)).toBeNull();
    expect(
      findWslActivationTarget("Ubuntu", [{ ...candidates[1]!, connected: false }], bootstraps),
    ).toBeNull();
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

  it("explains when the requested WSL distro is unavailable", async () => {
    const response = await handleDesktopAppActivationRequest(
      { ...request, wslDistro: "Ubuntu" },
      dependencies({ getTarget: () => null }),
    );
    expect(response).toMatchObject({
      ok: false,
      code: "environment-unavailable",
      message: expect.stringContaining("WSL environment for Ubuntu"),
    });
  });

  it("uses the requested WSL distro instead of the primary environment", async () => {
    const wslEnvironmentId = EnvironmentId.make("wsl-ubuntu");
    const deps = dependencies({
      getTarget: (activationRequest) =>
        activationRequest.wslDistro === "Ubuntu"
          ? { environmentId: wslEnvironmentId, platform: "linux" }
          : { environmentId, platform: "windows" },
      findProject: () => null,
    });

    await handleDesktopAppActivationRequest({ ...request, wslDistro: "Ubuntu" }, deps);

    expect(deps.createProject).toHaveBeenCalledWith(wslEnvironmentId, request.workspaceRoot);
    expect(deps.openThread).toHaveBeenCalledWith({
      environmentId: wslEnvironmentId,
      projectId: createdProjectId,
    });
  });
});
