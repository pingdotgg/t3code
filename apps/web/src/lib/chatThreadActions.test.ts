import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { deriveLogicalProjectKeyFromSettings } from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import type { Project } from "../types";
import {
  resolveAvailableNewThreadProjectRef,
  resolveThreadActionProjectRef,
  hasExplicitComposerModelSelection,
  resolveNewDraftStartFromOrigin,
  resolveNewThreadModelSelectionOverride,
  resolveWorkspaceOptionsAfterEnvironmentRetarget,
  startNewThreadFromContext,
  type ChatThreadActionContext,
} from "./chatThreadActions";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const PROJECT_ID = ProjectId.make("project-1");
const FALLBACK_PROJECT_ID = ProjectId.make("project-2");
const PROJECT_DEFAULT_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "project-default",
};
const CARRIED_SELECTION: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "carried-model",
};

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
  it("only treats an active stored selection marked explicit as an explicit pick", () => {
    const draft = {
      activeProvider: PROJECT_DEFAULT_SELECTION.instanceId,
      modelSelectionByProvider: {
        [PROJECT_DEFAULT_SELECTION.instanceId]: PROJECT_DEFAULT_SELECTION,
      },
      modelSelectionExplicit: true,
    };

    expect(hasExplicitComposerModelSelection(draft)).toBe(true);
    expect(hasExplicitComposerModelSelection({ ...draft, modelSelectionExplicit: false })).toBe(
      false,
    );
    expect(hasExplicitComposerModelSelection({ ...draft, activeProvider: null })).toBe(false);
  });

  it("does not carry a non-explicit model from the destination draft back into itself", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-a",
      }),
    ).toBeNull();
  });

  it("still carries models between different threads when the project has no default", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: null,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(CARRIED_SELECTION);
  });

  it("keeps the project default above any carried selection", () => {
    expect(
      resolveNewThreadModelSelectionOverride({
        projectDefaultSelection: PROJECT_DEFAULT_SELECTION,
        carrySelection: CARRIED_SELECTION,
        carrySourceDraftId: "draft-a",
        destinationDraftId: "draft-b",
      }),
    ).toEqual(PROJECT_DEFAULT_SELECTION);
  });

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
});

const primaryEnvironmentId = EnvironmentId.make("env-primary");
const remoteEnvironmentId = EnvironmentId.make("env-remote");
const repositoryIdentity = {
  canonicalKey: "github.com/example/shared-repo",
  locator: {
    source: "git-remote" as const,
    remoteName: "origin",
    remoteUrl: "https://github.com/example/shared-repo.git",
  },
};
const groupingSettings = {
  sidebarProjectGroupingMode: "repository" as const,
  sidebarProjectGroupingOverrides: {},
};

/** Project fixture for New Chat sibling-resolution cases. */
function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: ProjectId.make("project-1"),
    environmentId: primaryEnvironmentId,
    title: "shared-repo",
    workspaceRoot: "/tmp/shared-repo",
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
    ...overrides,
  };
}

describe("resolveAvailableNewThreadProjectRef", () => {
  it("uses the physical-to-logical map when the requested row has no repository identity", () => {
    const staleRemote = makeProject({
      id: ProjectId.make("project-stale-remote"),
      environmentId: remoteEnvironmentId,
      workspaceRoot: "/tmp/shared-repo",
      repositoryIdentity: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const canonicalRemote = makeProject({
      id: ProjectId.make("project-canonical-remote"),
      environmentId: remoteEnvironmentId,
      workspaceRoot: "/tmp/shared-repo/",
      repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    const staleLocal = makeProject({
      id: ProjectId.make("project-stale-local"),
      environmentId: primaryEnvironmentId,
      repositoryIdentity: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    const local = makeProject({
      id: ProjectId.make("project-local"),
      environmentId: primaryEnvironmentId,
      repositoryIdentity,
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    const projects = [staleRemote, canonicalRemote, staleLocal, local];
    const logicalKeyByPhysicalKey = buildPhysicalToLogicalProjectKeyMap({
      projects,
      settings: groupingSettings,
      primaryEnvironmentId,
    });

    // The stale row's own key is its physical path. The map sends that path
    // to the repository group its newer duplicate shares with the local copy.
    expect(deriveLogicalProjectKeyFromSettings(staleRemote, groupingSettings)).not.toBe(
      deriveLogicalProjectKeyFromSettings(local, groupingSettings),
    );

    expect(
      resolveAvailableNewThreadProjectRef({
        requested: scopeProjectRef(remoteEnvironmentId, staleRemote.id),
        projects,
        settings: groupingSettings,
        logicalKeyByPhysicalKey,
        isEnvironmentReachable: (environmentId) => environmentId === primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toEqual(scopeProjectRef(primaryEnvironmentId, local.id));
  });

  it("keeps the requested worktree and still falls back to one when that host is down", () => {
    const localMain = makeProject({
      id: ProjectId.make("project-local-main"),
      repositoryIdentity,
    });
    const localWorktree = makeProject({
      id: ProjectId.make("project-local-worktree"),
      workspaceRoot: "/tmp/shared-repo-feature",
      repositoryIdentity,
    });
    const remote = makeProject({
      id: ProjectId.make("project-remote"),
      environmentId: remoteEnvironmentId,
      repositoryIdentity,
    });
    const projects = [localMain, localWorktree, remote];
    const logicalKeyByPhysicalKey = buildPhysicalToLogicalProjectKeyMap({
      projects,
      settings: groupingSettings,
      primaryEnvironmentId,
    });
    const resolve = (
      requested: Project,
      reachable: (environmentId: Project["environmentId"]) => boolean,
    ) =>
      resolveAvailableNewThreadProjectRef({
        requested: scopeProjectRef(requested.environmentId, requested.id),
        projects,
        settings: groupingSettings,
        logicalKeyByPhysicalKey,
        isEnvironmentReachable: reachable,
        primaryEnvironmentId,
      });

    expect(resolve(localWorktree, () => true)).toEqual(
      scopeProjectRef(primaryEnvironmentId, localWorktree.id),
    );
    expect(resolve(remote, (environmentId) => environmentId === primaryEnvironmentId)).toEqual(
      scopeProjectRef(primaryEnvironmentId, localMain.id),
    );

    const worktreeOnly = [remote, localWorktree];
    expect(
      resolveAvailableNewThreadProjectRef({
        requested: scopeProjectRef(remoteEnvironmentId, remote.id),
        projects: worktreeOnly,
        settings: groupingSettings,
        logicalKeyByPhysicalKey: buildPhysicalToLogicalProjectKeyMap({
          projects: worktreeOnly,
          settings: groupingSettings,
          primaryEnvironmentId,
        }),
        isEnvironmentReachable: (environmentId) => environmentId === primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toEqual(scopeProjectRef(primaryEnvironmentId, localWorktree.id));

    expect(resolve(remote, () => false)).toBeNull();
  });
});

describe("resolveWorkspaceOptionsAfterEnvironmentRetarget", () => {
  it("clears branch and worktree only after the environment changes", () => {
    const options = {
      branch: "feat",
      worktreePath: "/remote/worktree",
      envMode: "worktree" as const,
    };

    expect(
      resolveWorkspaceOptionsAfterEnvironmentRetarget({
        requestedEnvironmentId: remoteEnvironmentId,
        targetEnvironmentId: remoteEnvironmentId,
        options,
      }),
    ).toEqual(options);

    expect(
      resolveWorkspaceOptionsAfterEnvironmentRetarget({
        requestedEnvironmentId: remoteEnvironmentId,
        targetEnvironmentId: primaryEnvironmentId,
        options,
      }),
    ).toEqual({ branch: null, worktreePath: null, envMode: "worktree" });
  });
});
