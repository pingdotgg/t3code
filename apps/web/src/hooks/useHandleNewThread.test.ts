import { describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeMode } from "@t3tools/contracts";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let targetSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree" | null,
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null,
    defaultRuntimeMode: "full-access" as RuntimeMode,
  };
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  const repositoryIdentity = {
    canonicalKey: "github.com/example/shared-repo",
    locator: {
      source: "git-remote" as const,
      remoteName: "origin",
      remoteUrl: "https://github.com/example/shared-repo.git",
    },
  };
  const remoteProject = {
    id: "project-remote",
    environmentId: "environment-ssh",
    title: "shared-repo",
    workspaceRoot: "/remote/project",
    repositoryIdentity: null,
    defaultThreadEnvMode: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [] as [],
  };
  const localProject = {
    id: "project-local",
    environmentId: "environment-primary",
    title: "shared-repo",
    workspaceRoot: "/local/project",
    repositoryIdentity,
    defaultThreadEnvMode: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-03T00:00:00.000Z",
    scripts: [] as [],
  };
  type TestEnvironment = {
    environmentId: string;
    label: string;
    connection: { phase: "connected" | "reconnecting" };
  };
  const connectedEnvironments = (): TestEnvironment[] => [
    {
      environmentId: "environment-primary",
      label: "Local",
      connection: { phase: "connected" },
    },
    {
      environmentId: "environment-ssh",
      label: "Build box",
      connection: { phase: "connected" },
    },
  ];
  const projectFileReads: Array<{ environmentId: string; workspaceRoot: string }> = [];
  const toastAdd = vi.fn();
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => null),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
  };

  const state = {
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get targetSettings() {
      return targetSettings;
    },
    environments: connectedEnvironments(),
    localProject,
    projectFileReads,
    projects: [remoteProject] as Array<typeof remoteProject | typeof localProject>,
    remoteProject,
    repositoryIdentity,
    toastAdd,
    reset(
      nextStoredDraft: typeof storedDraft,
      workspaceDefaults = {
        envMode: "local" as "local" | "worktree",
        startFromOrigin: false,
      },
    ) {
      storedDraft = nextStoredDraft;
      targetSettings = {
        defaultThreadEnvMode: workspaceDefaults.envMode,
        newWorktreesStartFromOrigin: workspaceDefaults.startFromOrigin,
        defaultModelSelection: null,
        defaultRuntimeMode: "full-access",
      };
      state.environments = connectedEnvironments();
      state.projects = [remoteProject];
      projectFileReads.length = 0;
      toastAdd.mockClear();
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };

  return state;
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : new Map([
          [
            "environment-primary",
            {
              settings: {
                ...testState.targetSettings,
                newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
              },
            },
          ],
          ["environment-ssh", { settings: testState.targetSettings }],
        ]),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@t3tools/contracts")>();
  return {
    ...actual,
    DEFAULT_RUNTIME_MODE: "default",
    DEFAULT_SERVER_SETTINGS: {},
  };
});
vi.mock("@t3tools/shared/projectSettings", () => ({
  // Environment settings pass through; the tests set project fields on the
  // project record, which the hook still honors until the server folds them.
  // With a file argument the env mode resolves like the real chain.
  resolveProjectSettings: (
    settings: Record<string, unknown>,
    _projectId: unknown,
    _project: unknown,
    projectFile?: { defaultThreadEnvMode?: "local" | "worktree" } | null,
  ) => ({
    settings:
      projectFile === undefined
        ? settings
        : {
            ...settings,
            defaultThreadEnvMode:
              settings.defaultThreadEnvMode ?? projectFile?.defaultThreadEnvMode ?? "local",
          },
    sources: { defaultModelSelection: "environment", defaultThreadEnvMode: "environment" },
    overrides: {},
  }),
}));
vi.mock("@tanstack/react-router", () => ({
  useParams: () => null,
  useRouter: () => testState.router,
}));
vi.mock("react", () => ({
  useCallback: <T>(callback: T) => callback,
  useMemo: <T>(factory: () => T) => factory(),
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (options: unknown) => options,
  toastManager: { add: (...args: unknown[]) => testState.toastAdd(...args) },
}));
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: () => false,
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatThreadActions")>()),
  hasExplicitComposerModelSelection: () => false,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: (environmentId: string, workspaceRoot: string) => {
    testState.projectFileReads.push({ environmentId, workspaceRoot });
    return testState.projectFileRead;
  },
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("../logicalProject", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logicalProject")>();
  return {
    ...actual,
    deriveLogicalProjectKeyFromSettings: () => "remote-project",
    getProjectOrderKey: () => "remote-project",
    selectProjectGroupingSettings: () => ({}),
  };
});
vi.mock("../state/entities", () => ({
  readProjects: () => testState.projects,
  readThreadShell: () => null,
  useProjects: () => [],
  useThread: () => null,
}));
vi.mock("../state/environments", () => ({
  useEnvironments: () => ({ environments: testState.environments }),
  usePrimaryEnvironmentId: () => "environment-primary",
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

import { derivePhysicalProjectKey } from "../logicalProject";
import { buildPhysicalToLogicalProjectKeyMap } from "../sidebarProjectGrouping";
import { useNewThreadHandler } from "./useHandleNewThread";

/** Logical key New Chat should register: the group key from `buildProjectGroups`, not a re-derivation. */
function expectedLogicalProjectKey(project: {
  environmentId: string;
  workspaceRoot: string;
}): string {
  return (
    buildPhysicalToLogicalProjectKeyMap({
      projects: testState.projects,
      settings: {},
      primaryEnvironmentId: "environment-primary",
    }).get(derivePhysicalProjectKey(project)) ?? "remote-project"
  );
}

describe.each([
  ["new", null],
  [
    "reusable",
    {
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    },
  ],
])("useNewThreadHandler with a %s draft", (_, draft) => {
  it.each(["approval-required", "auto-accept-edits", "auto", "full-access"] as const)(
    "uses the target environment's %s permissions for new threads",
    async (runtimeMode) => {
      testState.reset(draft);
      testState.targetSettings.defaultRuntimeMode = runtimeMode;
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;
      const pendingOpen = useNewThreadHandler()(projectRef);
      testState.completeProjectFileRead(null);
      const opened = await pendingOpen;

      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        expectedLogicalProjectKey(testState.remoteProject),
        projectRef,
        opened!.draftId,
        expect.objectContaining({ runtimeMode }),
      );
    },
  );

  it("abandons a delayed draft open when the user navigates elsewhere", async () => {
    testState.reset(draft);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.router.state.location.href = "/usage";
    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.router.state.location.href).toBe("/usage");
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "uses the target environment's start-from-origin default of %s",
    async (startFromOrigin) => {
      testState.reset(draft, { envMode: "worktree", startFromOrigin });
      const openThread = useNewThreadHandler();
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;
      const pendingOpen = openThread(projectRef);

      testState.completeProjectFileRead(null);
      const opened = await pendingOpen;

      expect(opened).toEqual({
        draftId: draft?.draftId ?? "draft-delayed",
        threadId: draft?.threadId ?? "thread-delayed",
      });
      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        expectedLogicalProjectKey(testState.remoteProject),
        projectRef,
        opened!.draftId,
        expect.objectContaining({ envMode: "worktree", startFromOrigin }),
      );
      if (draft) {
        expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(
          draft.draftId,
          expect.objectContaining({ envMode: "worktree", startFromOrigin }),
        );
      }
    },
  );

  it.each([true, false])(
    "preserves an explicit start-from-origin choice of %s",
    async (startFromOrigin) => {
      testState.reset(draft, { envMode: "worktree", startFromOrigin: !startFromOrigin });
      const openThread = useNewThreadHandler();
      const projectRef = {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never;

      const opened = await openThread(projectRef, { envMode: "worktree", startFromOrigin });

      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        expectedLogicalProjectKey(testState.remoteProject),
        projectRef,
        opened!.draftId,
        expect.objectContaining({ envMode: "worktree", startFromOrigin }),
      );
    },
  );
});

describe("useNewThreadHandler with a disconnected remote", () => {
  const remoteRef = {
    environmentId: "environment-ssh",
    projectId: "project-remote",
  } as never;

  /** Marks the SSH environment reconnecting so New Chat cannot target it. */
  function disconnectRemote() {
    testState.environments = testState.environments.map((environment) =>
      environment.environmentId === "environment-ssh"
        ? { ...environment, connection: { phase: "reconnecting" as const } }
        : environment,
    );
  }

  it("toasts instead of reading t3.json when no reachable copy exists", async () => {
    testState.reset(null);
    testState.targetSettings.defaultThreadEnvMode = null;
    disconnectRemote();

    const opened = await useNewThreadHandler()(remoteRef);

    expect(opened).toBeNull();
    expect(testState.projectFileReads).toEqual([]);
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.toastAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        title: "Environment unavailable",
        description: "Build box is not connected.",
      }),
    );
  });

  it("retargets a stale remote row to the reachable local copy", async () => {
    testState.reset(null);
    testState.targetSettings.defaultThreadEnvMode = null;
    const canonicalRemote = {
      ...testState.remoteProject,
      id: "project-canonical-remote",
      repositoryIdentity: testState.repositoryIdentity,
      updatedAt: "2026-01-02T00:00:00.000Z",
    };
    testState.projects = [
      { ...testState.remoteProject, repositoryIdentity: null },
      canonicalRemote,
      testState.localProject,
    ];
    disconnectRemote();

    const pendingOpen = useNewThreadHandler()(remoteRef, {
      branch: "feat",
      worktreePath: "/remote/worktree",
    });
    expect(testState.projectFileReads).toEqual([
      { environmentId: "environment-primary", workspaceRoot: "/local/project" },
    ]);
    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;

    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
    expect(testState.toastAdd).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      expectedLogicalProjectKey(testState.localProject),
      { environmentId: "environment-primary", projectId: "project-local" },
      "draft-delayed",
      expect.objectContaining({
        branch: null,
        worktreePath: null,
        envMode: "local",
      }),
    );
  });

  it("reuses the group key when the reachable winner has no repository identity", async () => {
    testState.reset(null);
    const unidentifiedLocal = {
      ...testState.localProject,
      repositoryIdentity: null,
      updatedAt: "2026-01-04T00:00:00.000Z",
    };
    testState.projects = [
      { ...testState.remoteProject, repositoryIdentity: testState.repositoryIdentity },
      unidentifiedLocal,
      {
        ...testState.localProject,
        id: "project-local-identified",
        updatedAt: "2026-01-03T00:00:00.000Z",
      },
    ];
    disconnectRemote();

    const pendingOpen = useNewThreadHandler()(remoteRef);
    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      testState.repositoryIdentity.canonicalKey,
      { environmentId: "environment-primary", projectId: "project-local" },
      "draft-delayed",
      expect.objectContaining({ envMode: "local" }),
    );
  });

  it("keeps the requested worktree when that environment is connected", async () => {
    testState.reset(null);
    const featureWorktree = {
      ...testState.localProject,
      id: "project-worktree",
      workspaceRoot: "/local/project-feature",
    };
    testState.projects = [testState.localProject, featureWorktree];

    const pendingOpen = useNewThreadHandler()({
      environmentId: "environment-primary",
      projectId: "project-worktree",
    } as never);
    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      expectedLogicalProjectKey(featureWorktree),
      { environmentId: "environment-primary", projectId: "project-worktree" },
      "draft-delayed",
      expect.objectContaining({ envMode: "local" }),
    );
  });
});
