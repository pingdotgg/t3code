import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveAvailableNewThreadProjectRef,
  resolveThreadActionProjectRef,
  resolveNewDraftStartFromOrigin,
  resolveWorkspaceOptionsAfterEnvironmentRetarget,
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

  it("keeps the requested project when its environment is reachable", () => {
    const otherEnvironmentId = EnvironmentId.make("environment-2");
    const requested = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);

    expect(
      resolveAvailableNewThreadProjectRef({
        requested,
        members: [
          { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID, isPrimary: false },
          { environmentId: otherEnvironmentId, projectId: FALLBACK_PROJECT_ID, isPrimary: true },
        ],
        isEnvironmentReachable: () => true,
      }),
    ).toEqual(requested);
  });

  it("retargets an unreachable requested environment to a reachable sibling, preferring primary", () => {
    const reachableEnvironmentId = EnvironmentId.make("environment-2");
    const otherEnvironmentId = EnvironmentId.make("environment-3");

    expect(
      resolveAvailableNewThreadProjectRef({
        requested: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
        members: [
          { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID, isPrimary: false },
          {
            environmentId: otherEnvironmentId,
            projectId: ProjectId.make("project-3"),
            isPrimary: false,
          },
          {
            environmentId: reachableEnvironmentId,
            projectId: FALLBACK_PROJECT_ID,
            isPrimary: true,
          },
        ],
        isEnvironmentReachable: (environmentId) => environmentId !== ENVIRONMENT_ID,
      }),
    ).toEqual(scopeProjectRef(reachableEnvironmentId, FALLBACK_PROJECT_ID));
  });

  it("keeps the requested project when no sibling environment is reachable", () => {
    const requested = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);

    expect(
      resolveAvailableNewThreadProjectRef({
        requested,
        members: [
          { environmentId: ENVIRONMENT_ID, projectId: PROJECT_ID },
          { environmentId: EnvironmentId.make("environment-2"), projectId: FALLBACK_PROJECT_ID },
        ],
        isEnvironmentReachable: () => false,
      }),
    ).toEqual(requested);
  });

  it("keeps explicit workspace options when the draft stays on the requested environment", () => {
    expect(
      resolveWorkspaceOptionsAfterEnvironmentRetarget({
        requestedEnvironmentId: ENVIRONMENT_ID,
        targetEnvironmentId: ENVIRONMENT_ID,
        options: {
          branch: "feat/checkout",
          worktreePath: "/dead/machine/worktree",
          envMode: "worktree",
          startFromOrigin: false,
        },
      }),
    ).toEqual({
      branch: "feat/checkout",
      worktreePath: "/dead/machine/worktree",
      envMode: "worktree",
      startFromOrigin: false,
    });
  });

  it("clears machine-specific workspace options when retargeting to another environment", () => {
    const targetEnvironmentId = EnvironmentId.make("environment-2");

    expect(
      resolveWorkspaceOptionsAfterEnvironmentRetarget({
        requestedEnvironmentId: ENVIRONMENT_ID,
        targetEnvironmentId,
        options: {
          branch: "feat/checkout",
          worktreePath: "/dead/machine/worktree",
          envMode: "worktree",
          startFromOrigin: false,
        },
      }),
    ).toEqual({
      branch: null,
      worktreePath: null,
      envMode: "worktree",
      startFromOrigin: false,
    });
  });
});
