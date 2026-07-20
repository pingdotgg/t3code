import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  type ChatThreadActionContext,
  resolveNewDraftStartFromOrigin,
  resolveThreadActionProjectRef,
  startNewLocalThreadFromContext,
  startNewThreadFromContext,
  startNewThreadInSameWorktreeFromContext,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");

function createContext(overrides: Partial<ChatThreadActionContext> = {}): ChatThreadActionContext {
  return {
    activeDraftThread: null,
    activeThread: undefined,
    defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
    handleNewThread: async () => {},
    ...overrides,
  };
}

describe("chatThreadActions", () => {
  it("only applies the start-from-origin default to new worktree drafts", () => {
    expect(
      resolveNewDraftStartFromOrigin({
        envMode: "worktree",
        newWorktreesStartFromOrigin: true,
      }),
    ).toBe(true);
    expect(
      resolveNewDraftStartFromOrigin({
        envMode: "local",
        newWorktreesStartFromOrigin: true,
      }),
    ).toBe(false);
  });

  it("prefers the active draft thread project when resolving thread actions", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "feature/refactor",
          worktreePath: "/tmp/worktree",
          envMode: "worktree",
          startFromOrigin: true,
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the default project ref when there is no active thread context", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("starts a contextual new thread from the active draft thread", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadInSameWorktreeFromContext(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "feature/refactor",
          worktreePath: "/tmp/worktree",
          envMode: "worktree",
          startFromOrigin: true,
        },
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      branch: "feature/refactor",
      worktreePath: "/tmp/worktree",
      envMode: "worktree",
      startFromOrigin: true,
    });
  });

  it("preserves an explicitly disabled origin base in contextual thread options", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    await startNewThreadInSameWorktreeFromContext(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "feature/refactor",
          worktreePath: "/tmp/worktree",
          envMode: "worktree",
          startFromOrigin: false,
        },
        handleNewThread,
      }),
    );

    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      branch: "feature/refactor",
      worktreePath: "/tmp/worktree",
      envMode: "worktree",
      startFromOrigin: false,
    });
  });

  it("starts ordinary new threads in the local checkout", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewLocalThreadFromContext(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      branch: null,
      worktreePath: null,
      envMode: "local",
      startFromOrigin: false,
    });
  });

  it("starts ordinary new threads using configured default thread mode", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
        defaultThreadEnvMode: "worktree",
        defaultNewWorktreesStartFromOrigin: true,
        resolveDefaultMainCheckout: async () => ({ branch: "main", path: "/repo/main" }),
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      branch: "main",
      worktreePath: null,
      envMode: "worktree",
      startFromOrigin: true,
    });
  });

  it("resolves thread defaults for the target project", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    const targetProjectRef = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);
    const resolveNewThreadDefaults = vi.fn(() => ({
      envMode: "worktree" as const,
      newWorktreesStartFromOrigin: true,
    }));

    await startNewThreadFromContext(
      createContext({
        defaultProjectRef: targetProjectRef,
        defaultThreadEnvMode: "local",
        defaultNewWorktreesStartFromOrigin: false,
        resolveNewThreadDefaults,
        resolveDefaultMainCheckout: async () => ({ branch: "main", path: "/repo/main" }),
        handleNewThread,
      }),
    );

    expect(resolveNewThreadDefaults).toHaveBeenCalledWith(targetProjectRef);
    expect(handleNewThread).toHaveBeenCalledWith(targetProjectRef, {
      branch: "main",
      worktreePath: null,
      envMode: "worktree",
      startFromOrigin: true,
    });
  });

  it("still starts an ordinary new thread when main-checkout discovery is unavailable", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "feature/refactor",
          worktreePath: "/tmp/worktree",
        },
        defaultThreadEnvMode: "worktree",
        defaultNewWorktreesStartFromOrigin: true,
        resolveDefaultMainCheckout: async () => undefined,
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      startFromOrigin: true,
    });
  });

  it("still starts an ordinary new thread when main-checkout discovery never settles", async () => {
    vi.useFakeTimers();
    try {
      const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
      const didStart = startNewThreadFromContext(
        createContext({
          defaultProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
          defaultThreadEnvMode: "worktree",
          defaultNewWorktreesStartFromOrigin: true,
          resolveDefaultMainCheckout: () => new Promise(() => {}),
          handleNewThread,
        }),
      );

      await vi.advanceTimersByTimeAsync(500);

      await expect(didStart).resolves.toBe(true);
      expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
        branch: null,
        worktreePath: null,
        envMode: "worktree",
        startFromOrigin: true,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not inherit an active worktree for ordinary new threads", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    await startNewThreadFromContext(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "feature/refactor",
          worktreePath: "/tmp/worktree",
        },
        defaultThreadEnvMode: "local",
        defaultNewWorktreesStartFromOrigin: false,
        defaultMainCheckout: {
          branch: "main",
          path: "/tmp/main-checkout",
        },
        handleNewThread,
      }),
    );

    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      branch: "main",
      worktreePath: "/tmp/main-checkout",
      envMode: "local",
      startFromOrigin: false,
    });
  });

  it("waits for the main checkout resolver before creating a local thread", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});
    const resolveDefaultMainCheckout = vi.fn(async () => ({
      branch: "main",
      path: "/repo/main",
    }));

    await startNewThreadFromContext(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
          branch: "t3code/group-threads-worktrees",
          worktreePath: null,
        },
        defaultThreadEnvMode: "local",
        resolveDefaultMainCheckout,
        handleNewThread,
      }),
    );

    expect(resolveDefaultMainCheckout).toHaveBeenCalledWith(
      scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
    );
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), {
      branch: "main",
      worktreePath: "/repo/main",
      envMode: "local",
      startFromOrigin: false,
    });
  });

  it("does not start a thread when there is no project context", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        defaultProjectRef: null,
        handleNewThread,
      }),
    );

    expect(didStart).toBe(false);
    expect(handleNewThread).not.toHaveBeenCalled();
  });
});
