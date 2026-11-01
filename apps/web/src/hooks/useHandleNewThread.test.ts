import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { RuntimeMode } from "@t3tools/contracts";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let projectRemoved = false;
  let connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
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
    readonly projectId?: string;
    readonly logicalProjectKey?: string;
    readonly loadBalancedEnvironmentId?: string;
    readonly environmentSelection?: "auto" | "manual" | "project-default";
  } | null = null;
  let openDraftRoute: { readonly kind: "draft"; readonly draftId: string } | null = null;
  let draftsWithUserText = new Set<string>();
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
    getComposerDraft: vi.fn((draftId: string) => ({ draftId })),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() =>
      testState.routeDraftId
        ? storedDraft
        : openDraftRoute === null
          ? null
          : {
              logicalProjectKey: "remote-project",
              promotedTo: null,
              threadId: "thread-open",
              createdAt: "2026-01-01T00:00:00.000Z",
              runtimeMode: "full-access",
              interactionMode: "default",
            },
    ),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
    setPrompt: vi.fn(),
  };

  return {
    projectDefaultEnabled: false,
    routeDraftId: null as string | null,
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get projectRemoved() {
      return projectRemoved;
    },
    get connectedEnvironmentIds() {
      return connectedEnvironmentIds;
    },
    set connectedEnvironmentIds(ids: string[]) {
      connectedEnvironmentIds = ids;
    },
    disconnect(environmentId: string) {
      connectedEnvironmentIds = connectedEnvironmentIds.filter((id) => id !== environmentId);
    },
    removeProject() {
      projectRemoved = true;
    },
    hasUserText: (draft: { readonly draftId?: string } | null | undefined) =>
      draft?.draftId !== undefined && draftsWithUserText.has(draft.draftId),
    giveUserText(draftId: string) {
      draftsWithUserText = new Set([...draftsWithUserText, draftId]);
    },
    get openDraftRoute() {
      return openDraftRoute;
    },
    openEmptyDraft(draftId: string) {
      openDraftRoute = { kind: "draft", draftId };
    },
    get targetSettings() {
      return targetSettings;
    },
    reset(
      nextStoredDraft: typeof storedDraft,
      workspaceDefaults = {
        envMode: "local" as "local" | "worktree" | null,
        startFromOrigin: false,
      },
    ) {
      storedDraft = nextStoredDraft;
      openDraftRoute = null;
      draftsWithUserText = new Set();
      projectRemoved = false;
      connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
      targetSettings = {
        defaultThreadEnvMode: workspaceDefaults.envMode,
        newWorktreesStartFromOrigin: workspaceDefaults.startFromOrigin,
        defaultModelSelection: null,
        defaultRuntimeMode: "full-access",
      };
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setPrompt.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

const testServerConfigs = () =>
  new Map([
    [
      "environment-primary",
      {
        settings: {
          ...testState.targetSettings,
          projectSettingsOverrides: testState.projectDefaultEnabled
            ? { "project-primary": { defaultEnvironmentId: "environment-ssh" } }
            : {},
          defaultRuntimeMode: "approval-required",
          newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
        },
      },
    ],
    [
      "environment-ssh",
      { settings: { ...testState.targetSettings, projectSettingsOverrides: {} } },
    ],
  ]);

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "primary-id"
        ? "environment-primary"
        : atom === "connected-environment-ids"
          ? testState.connectedEnvironmentIds
          : testServerConfigs(),
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    typeof atom === "object" && atom !== null && "environmentSettingsIds" in atom
      ? (atom as { environmentSettingsIds: string[] }).environmentSettingsIds.map(
          (id) => testServerConfigs().get(id)?.settings ?? null,
        )
      : atom === "primary-settings"
        ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
        : testServerConfigs(),
}));
vi.mock("@t3tools/shared/projectSettings", () => ({
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
  resolveNewThreadEnvMode: (input: {
    projectSettings: { settings: { defaultThreadEnvMode: "local" | "worktree" } };
  }) => input.projectSettings.settings.defaultThreadEnvMode,
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
vi.mock("../composerDraftStore", () => {
  const useComposerDraftStore = Object.assign(() => null, {
    getState: () => testState.draftStore,
  });
  return {
    composerDraftHasUserContent: (draft: { readonly draftId?: string } | null | undefined) =>
      testState.hasUserText(draft),
    markPromotedDraftThreadByRef: vi.fn(),
    useComposerDraftStore,
  };
});
vi.mock("../lib/chatThreadActions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/chatThreadActions")>()),
  hasExplicitComposerModelSelection: () => false,
  resolveNewThreadModelSelectionOverride: () => null,
}));
vi.mock("../providerInstances", () => ({
  resolveProjectDefaultProviderModelSelection: () => null,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/project-grouping")>()),
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => {
  const projects = [
    ["environment-primary", "project-primary", "/primary/project"],
    ["environment-ssh", "project-remote", "/remote/project"],
  ].map(([environmentId, id, workspaceRoot]) => ({
    environmentId,
    id,
    workspaceRoot,
    title: "Project",
    repositoryIdentity: {
      canonicalKey: "github.com/t3tools/project",
      name: "project",
      displayName: "Project",
    },
    defaultThreadEnvMode: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  }));
  return {
    readProject: (ref: { environmentId: string; projectId: string }) =>
      testState.projectRemoved
        ? null
        : projects.find(
            (project) =>
              project.environmentId === ref.environmentId && project.id === ref.projectId,
          ),
    readProjects: () => (testState.projectRemoved ? [] : projects),
    readThreadShell: () => null,
    readThreadShells: () => [],
    useProjects: () => projects,
    useThread: () => null,
    useThreadShell: () => null,
  };
});
vi.mock("../state/environments", () => ({
  useConnectedEnvironmentIds: () => testState.connectedEnvironmentIds,
  usePrimaryEnvironmentId: () => "environment-primary",
  readPrimaryEnvironmentId: () => "environment-primary",
}));
vi.mock("../state/environmentAtomList", () => ({
  environmentIdsKey: (ids: string[]) => ids.join("\n"),
  environmentAtomList: () => (key: string) => ({ environmentSettingsIds: key.split("\n") }),
}));
vi.mock("../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));
vi.mock("../state/presentation", () => ({
  environmentSummaries: { connectedEnvironmentIdsAtom: "connected-environment-ids" },
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  serverEnvironment: { settingsValueAtom: vi.fn() },
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteTarget: () =>
    testState.routeDraftId
      ? { kind: "draft", draftId: testState.routeDraftId }
      : testState.openDraftRoute,
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({
  getClientSettings: () => ({}),
  useClientSettings: () => ({
    sidebarProjectGroupingMode: "repository",
    sidebarProjectGroupingOverrides: {},
  }),
}));

import { startNewThreadFromContext } from "../lib/chatThreadActions";
import { useNewThreadHandler } from "./useHandleNewThread";

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

  it("sets the prompt before the draft shows", async () => {
    testState.reset(draft);
    const pendingOpen = useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;

    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(
      opened?.draftId,
      "Read the playbook. ",
    );
    expect(testState.draftStore.setPrompt.mock.invocationCallOrder[0]).toBeLessThan(
      testState.router.navigate.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("abandons a delayed draft open when the project is removed meanwhile", async () => {
    testState.reset(draft);
    const pendingOpen = useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    testState.removeProject();
    testState.completeProjectFileRead(null);

    await expect(pendingOpen).resolves.toBeNull();
    expect(testState.router.navigate).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();
  });
});

describe("useNewThreadHandler", () => {
  it("keeps the text of a draft that gained some while it waited", async () => {
    testState.reset(null);
    const raced = {
      draftId: "draft-raced",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-raced",
    };
    testState.draftStore.getDraftSessionByLogicalProjectKey
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(raced as never);
    testState.giveUserText("draft-raced");

    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(opened?.draftId).toBe("draft-raced");
    expect(testState.draftStore.setPrompt).not.toHaveBeenCalled();
  });

  it("seeds the prompt into the empty draft that is already open", async () => {
    testState.reset(null);
    testState.openEmptyDraft("draft-open");

    const opened = await useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. " },
    );

    expect(opened?.draftId).toBe("draft-open");
    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(
      "draft-open",
      "Read the playbook. ",
    );
  });

  it("opens the draft without waiting on a project file from an offline machine", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: false });
    testState.disconnect("environment-ssh");

    const opened = await useNewThreadHandler()(
      {
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never,
      { environmentSelection: "manual" },
    );

    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
    expect(testState.router.navigate).toHaveBeenCalledOnce();
  });
});

describe("new threads routed by a project default", () => {
  beforeEach(() => {
    testState.projectDefaultEnabled = true;
  });
  afterEach(() => {
    testState.projectDefaultEnabled = false;
    testState.routeDraftId = null;
    testState.connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
  });

  it("starts on the project default when New thread is invoked from a thread on another environment", async () => {
    testState.reset(null);
    await startNewThreadFromContext({
      activeThread: {
        environmentId: "environment-primary",
        projectId: "project-primary",
      } as never,
      activeDraftThread: null,
      defaultProjectRef: null,
      handleNewThread: useNewThreadHandler(),
    });
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      { environmentId: "environment-ssh", projectId: "project-remote" },
      "draft-delayed",
      expect.objectContaining({
        environmentSelection: "project-default",
        runtimeMode: "full-access",
      }),
    );
  });

  it("keeps explicit checkout requests on the selected environment", async () => {
    testState.reset(null);
    const projectRef = {
      environmentId: "environment-primary",
      projectId: "project-primary",
    } as never;
    const opened = await useNewThreadHandler()(projectRef, {
      branch: "feature",
      worktreePath: "/checkout",
      envMode: "worktree",
    });
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      projectRef,
      opened!.draftId,
      expect.objectContaining({
        environmentSelection: "manual",
        branch: "feature",
        worktreePath: "/checkout",
      }),
    );
  });

  it.each(["manual", "auto", "project-default"] as const)(
    "keeps the connected environment of the current empty %s draft ahead of the project default",
    async (environmentSelection) => {
      testState.reset({
        draftId: "draft-existing",
        environmentId: "environment-primary",
        projectId: "project-primary",
        logicalProjectKey: "remote-project",
        environmentSelection,
        loadBalancedEnvironmentId: "environment-primary",
        promotedTo: null,
        threadId: "thread-existing",
      });
      testState.routeDraftId = "draft-existing";
      const projectRef = { environmentId: "environment-ssh", projectId: "project-remote" } as never;
      const opened = await useNewThreadHandler()(projectRef);
      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        { environmentId: "environment-primary", projectId: "project-primary" },
        opened!.draftId,
        expect.objectContaining({
          environmentSelection,
          loadBalancedEnvironmentId: "environment-primary",
        }),
      );
      expect(testState.draftStore.setDraftThreadContext).not.toHaveBeenCalled();
    },
  );

  it("moves an automatic draft to the connected default when its environment disconnects", async () => {
    testState.reset({
      draftId: "draft-existing",
      environmentId: "environment-primary",
      projectId: "project-primary",
      logicalProjectKey: "remote-project",
      environmentSelection: "auto",
      promotedTo: null,
      threadId: "thread-existing",
    });
    testState.routeDraftId = "draft-existing";
    testState.connectedEnvironmentIds = ["environment-ssh"];
    const opened = await useNewThreadHandler()({
      environmentId: "environment-primary",
      projectId: "project-primary",
    } as never);

    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      { environmentId: "environment-ssh", projectId: "project-remote" },
      opened!.draftId,
      expect.objectContaining({ environmentSelection: "project-default" }),
    );
  });
});
