import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  type ProjectCloneSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  waitForCloneAndAssignProject,
  type WaitForCloneAndAssignDeps,
} from "./waitForCloneAndAssignProject";

const envId = EnvironmentId.make("env-clone-test");
const projectId = ProjectId.make("proj-clone-test");

function makeClone(phase: ProjectCloneSnapshot["phase"]): ProjectCloneSnapshot {
  return {
    projectId,
    remoteUrl: "https://github.com/acme/repo.git",
    destinationPath: "/tmp/repo",
    repository: null,
    phase,
    stage: "checkout",
    percent: phase === "done" ? 100 : 50,
    detail: "",
    error: phase === "failed" ? "clone failed" : null,
    startedAt: IsoDateTime.make("2026-01-01T00:00:00.000Z"),
    endedAt: phase === "running" ? null : IsoDateTime.make("2026-01-01T00:00:05.000Z"),
    sequence: NonNegativeInt.make(1),
  };
}

describe("waitForCloneAndAssignProject", () => {
  it("waits for a slow clone to finish and repositoryIdentity to populate before assigning", async () => {
    let cloneState: ProjectCloneSnapshot | null = makeClone("running");
    let projectState: EnvironmentProject | null = {
      id: projectId,
      environmentId: envId,
      repositoryIdentity: null,
    } as unknown as EnvironmentProject;

    const cloneListeners = new Set<(clone: ProjectCloneSnapshot | null) => void>();
    const projectListeners = new Set<(project: EnvironmentProject | null) => void>();
    const assign = vi.fn(async () => {});

    const deps: WaitForCloneAndAssignDeps = {
      readClone: () => cloneState,
      subscribeClone: (_e, _p, listener) => {
        cloneListeners.add(listener);
        return () => cloneListeners.delete(listener);
      },
      readProject: () => projectState,
      subscribeProject: (_ref, listener) => {
        projectListeners.add(listener);
        return () => projectListeners.delete(listener);
      },
      cloneTimeoutMs: 5_000,
      identityTimeoutMs: 5_000,
    };

    const pending = waitForCloneAndAssignProject({
      environmentId: envId,
      projectId,
      assign,
      deps,
    });

    // Still running -> must NOT assign yet.
    await Promise.resolve();
    expect(assign).not.toHaveBeenCalled();

    // Clone finishes, but repositoryIdentity has not yet arrived -> still waiting.
    cloneState = makeClone("done");
    for (const listener of cloneListeners) listener(cloneState);
    await Promise.resolve();
    expect(assign).not.toHaveBeenCalled();

    // Enrichment populates repositoryIdentity -> assigns immediately with populated project.
    projectState = {
      id: projectId,
      environmentId: envId,
      repositoryIdentity: {
        canonicalKey: "github.com/acme/repo",
        locator: {
          source: "git-remote",
          remoteName: "origin",
          remoteUrl: "https://github.com/acme/repo.git",
        },
        displayName: "acme/repo",
        provider: "github",
        owner: "acme",
        name: "repo",
        defaultBranch: "main",
      },
    } as unknown as EnvironmentProject;
    for (const listener of projectListeners) listener(projectState);

    expect(await pending).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(envId, projectId, projectState);
  });

  it("skips team assignment when the clone fails", async () => {
    let cloneState: ProjectCloneSnapshot | null = makeClone("running");
    const cloneListeners = new Set<(clone: ProjectCloneSnapshot | null) => void>();
    const assign = vi.fn(async () => {});

    const deps: WaitForCloneAndAssignDeps = {
      readClone: () => cloneState,
      subscribeClone: (_e, _p, listener) => {
        cloneListeners.add(listener);
        return () => cloneListeners.delete(listener);
      },
      readProject: () => null,
      subscribeProject: () => () => {},
      cloneTimeoutMs: 5_000,
      identityTimeoutMs: 5_000,
    };

    const pending = waitForCloneAndAssignProject({
      environmentId: envId,
      projectId,
      assign,
      deps,
    });

    cloneState = makeClone("failed");
    for (const listener of cloneListeners) listener(cloneState);

    expect(await pending).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("skips team assignment when a running clone is discarded and its project is removed", async () => {
    let cloneState: ProjectCloneSnapshot | null = makeClone("running");
    let projectState: EnvironmentProject | null = {
      id: projectId,
      environmentId: envId,
      repositoryIdentity: null,
    } as unknown as EnvironmentProject;
    const cloneListeners = new Set<(clone: ProjectCloneSnapshot | null) => void>();
    const assign = vi.fn(async () => {});

    const deps: WaitForCloneAndAssignDeps = {
      readClone: () => cloneState,
      subscribeClone: (_e, _p, listener) => {
        cloneListeners.add(listener);
        return () => cloneListeners.delete(listener);
      },
      readProject: () => projectState,
      subscribeProject: () => () => {},
      cloneTimeoutMs: 5_000,
      identityTimeoutMs: 5_000,
    };

    const pending = waitForCloneAndAssignProject({
      environmentId: envId,
      projectId,
      assign,
      deps,
    });

    // Simulate ProjectCloneTracker.discard coalescing directly to clone === null + deleted project.
    projectState = null;
    cloneState = null;
    for (const listener of cloneListeners) listener(cloneState);

    expect(await pending).toBe(false);
    expect(assign).not.toHaveBeenCalled();
  });

  it("skips team assignment when repositoryIdentity never populates before timeout", async () => {
    vi.useFakeTimers();
    try {
      const projectState = {
        id: projectId,
        environmentId: envId,
        repositoryIdentity: null,
      } as unknown as EnvironmentProject;
      const assign = vi.fn(async () => {});

      const deps: WaitForCloneAndAssignDeps = {
        readClone: () => makeClone("done"),
        subscribeClone: () => () => {},
        readProject: () => projectState,
        subscribeProject: () => () => {},
        cloneTimeoutMs: 5_000,
        identityTimeoutMs: 25,
      };

      const pending = waitForCloneAndAssignProject({
        environmentId: envId,
        projectId,
        assign,
        deps,
      });
      await vi.advanceTimersByTimeAsync(25);

      expect(await pending).toBe(false);
      expect(assign).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
