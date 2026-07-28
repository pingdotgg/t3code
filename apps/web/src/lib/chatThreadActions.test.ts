import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  resolveNewThreadAction,
  resolveThreadActionProjectRef,
  resolveNewDraftStartFromOrigin,
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

  it("starts in the selected sidebar scope instead of the contextual project", () => {
    const scopedProjectRef = scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID);

    expect(
      resolveNewThreadAction({
        sidebarV2Enabled: true,
        projectGroupCount: 2,
        scopedProjectRef,
        contextualProjectRef: scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID),
        pickProjectWhenAmbiguous: true,
      }),
    ).toEqual({ kind: "start", projectRef: scopedProjectRef });
  });

  it("opens the project picker for an ambiguous all-projects action", () => {
    expect(
      resolveNewThreadAction({
        sidebarV2Enabled: true,
        projectGroupCount: 2,
        scopedProjectRef: null,
        contextualProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
        pickProjectWhenAmbiguous: true,
      }),
    ).toEqual({ kind: "pick-project" });
  });

  it("keeps an all-projects local action contextual", () => {
    const contextualProjectRef = scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID);

    expect(
      resolveNewThreadAction({
        sidebarV2Enabled: true,
        projectGroupCount: 2,
        scopedProjectRef: null,
        contextualProjectRef,
        pickProjectWhenAmbiguous: false,
      }),
    ).toEqual({
      kind: "start",
      projectRef: contextualProjectRef,
    });
  });

  it("ignores sidebar v2 scope state while sidebar v1 is active", () => {
    const contextualProjectRef = scopeProjectRef(ENVIRONMENT_ID, FALLBACK_PROJECT_ID);

    expect(
      resolveNewThreadAction({
        sidebarV2Enabled: false,
        projectGroupCount: 2,
        scopedProjectRef: scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID),
        contextualProjectRef,
        pickProjectWhenAmbiguous: true,
      }),
    ).toEqual({
      kind: "start",
      projectRef: contextualProjectRef,
    });
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
