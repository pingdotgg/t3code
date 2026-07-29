import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveThreadActionProjectRef,
  resolveNewDraftStartFromOrigin,
  resolveNewThreadWorkspaceDefaults,
  startNewThreadFromContext,
  type ChatThreadActionContext,
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

  it("falls back to the global new-thread defaults when the project sets neither", () => {
    const global = { defaultThreadEnvMode: "worktree", newWorktreesStartFromOrigin: true } as const;

    expect(resolveNewThreadWorkspaceDefaults({ global, project: null })).toEqual({
      envMode: "worktree",
      newWorktreesStartFromOrigin: true,
      startFromOrigin: true,
    });
    expect(
      resolveNewThreadWorkspaceDefaults({
        global,
        project: { defaultThreadEnvMode: null, newWorktreesStartFromOrigin: null },
      }),
    ).toEqual({
      envMode: "worktree",
      newWorktreesStartFromOrigin: true,
      startFromOrigin: true,
    });
  });

  it("lets a project pin one new-thread key while inheriting the other", () => {
    expect(
      resolveNewThreadWorkspaceDefaults({
        global: { defaultThreadEnvMode: "local", newWorktreesStartFromOrigin: false },
        project: { defaultThreadEnvMode: "worktree", newWorktreesStartFromOrigin: null },
      }),
    ).toEqual({
      envMode: "worktree",
      newWorktreesStartFromOrigin: false,
      startFromOrigin: false,
    });

    expect(
      resolveNewThreadWorkspaceDefaults({
        global: { defaultThreadEnvMode: "worktree", newWorktreesStartFromOrigin: true },
        project: { defaultThreadEnvMode: "local", newWorktreesStartFromOrigin: true },
      }),
    ).toEqual({
      envMode: "local",
      newWorktreesStartFromOrigin: true,
      // Start-from-origin stays gated on the resolved mode being "worktree".
      startFromOrigin: false,
    });
  });

  it("prefers the active thread project when resolving thread actions", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
      }),
    );

    expect(projectRef).toEqual(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
  });

  it("falls back to the active draft thread project when there is no active thread", () => {
    const projectRef = resolveThreadActionProjectRef(
      createContext({
        activeDraftThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
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

  it("inherits only the project from context, never branch or worktree state", async () => {
    const handleNewThread = vi.fn<ChatThreadActionContext["handleNewThread"]>(async () => {});

    const didStart = await startNewThreadFromContext(
      createContext({
        activeThread: {
          environmentId: ENVIRONMENT_ID,
          projectId: PROJECT_ID,
        },
        handleNewThread,
      }),
    );

    expect(didStart).toBe(true);
    expect(handleNewThread).toHaveBeenCalledWith(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID));
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
