import { describe, expect, it, vi } from "vite-plus/test";
import type {
  EnvironmentId,
  ProjectId,
  ProjectReadFileResult,
  RuntimeMode,
  T3ProjectFile,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: T3ProjectFile | null) => void = () => undefined;
  let projectFileRead = Promise.resolve<T3ProjectFile | null>(null);
  const readT3ProjectFile = vi.fn(() => projectFileRead);
  const refreshQuery = vi.fn();
  const projectFile = {
    relativePath: "t3.json",
    contents: '{"defaultThreadEnvMode":"worktree"}',
    byteLength: 35,
    truncated: false,
  };
  let cachedProjectFile: ProjectReadFileResult | null = null;
  let optimisticProjectFile: ProjectReadFileResult | null = null;
  let cachedFileTimestamp = 0;
  let cachedFileWaiting = false;
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
    buildLocation: (request: { readonly params: { readonly draftId: string } }) => ({
      href: `/draft/${request.params.draftId}`,
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn((draftId: string) => ({ draftId })),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() =>
      openDraftRoute === null
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
    completeProjectFileRead: (value: T3ProjectFile | null) => completeProjectFileRead(value),
    draftStore,
    readT3ProjectFile,
    refreshQuery,
    get cachedProjectFile() {
      return cachedProjectFile;
    },
    get cachedFileTimestamp() {
      return cachedFileTimestamp;
    },
    get cachedFileWaiting() {
      return cachedFileWaiting;
    },
    cacheProjectFile(
      timestamp: number,
      overrides?: Partial<ProjectReadFileResult>,
      waiting = false,
    ) {
      cachedProjectFile = { ...projectFile, ...overrides };
      cachedFileTimestamp = timestamp;
      cachedFileWaiting = waiting;
    },
    get optimisticProjectFile() {
      return optimisticProjectFile;
    },
    editProjectFile(contents: string) {
      optimisticProjectFile = { ...projectFile, contents, byteLength: contents.length };
    },
    get projectRemoved() {
      return projectRemoved;
    },
    get connectedEnvironmentIds() {
      return connectedEnvironmentIds;
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
    registerDraft(draft: NonNullable<typeof storedDraft>) {
      storedDraft = draft;
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
      readT3ProjectFile.mockClear();
      refreshQuery.mockClear();
      cachedProjectFile = null;
      cachedFileWaiting = false;
      optimisticProjectFile = null;
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setPrompt.mockClear();
      projectFileRead = new Promise<T3ProjectFile | null>((resolve) => {
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
          newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
        },
      },
    ],
    ["environment-ssh", { settings: testState.targetSettings }],
  ]);

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => {
      if (atom === "connected-environment-ids") return testState.connectedEnvironmentIds;
      if (atom === "project-file-query") {
        return testState.cachedProjectFile
          ? AsyncResult.success(testState.cachedProjectFile, {
              timestamp: testState.cachedFileTimestamp,
              waiting: testState.cachedFileWaiting,
            })
          : AsyncResult.initial(true);
      }
      return testServerConfigs();
    },
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : testServerConfigs(),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: (ref: { environmentId: string; projectId: string }) =>
    `${ref.environmentId}:${ref.projectId}`,
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock(import("@t3tools/contracts"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    DEFAULT_RUNTIME_MODE: "default" as typeof actual.DEFAULT_RUNTIME_MODE,
    DEFAULT_SERVER_SETTINGS: {} as typeof actual.DEFAULT_SERVER_SETTINGS,
  };
});
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
vi.mock("../components/Sidebar.logic", () => ({
  orderItemsByPreferredIds: ({ items }: { items: unknown[] }) => items,
}));
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
vi.mock("../providerInstances", () => ({ resolveDefaultProviderModelSelection: () => null }));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: testState.readT3ProjectFile,
}));
vi.mock("../components/files/projectFilesQueryState", () => ({
  getProjectFileQueryAtom: () => "project-file-query",
  getOptimisticProjectFileQueryData: () => testState.optimisticProjectFile,
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({
  executeAtomQuery: testState.refreshQuery,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("@t3tools/client-runtime/state/project-grouping", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => {
  const project = {
    id: "project-remote",
    environmentId: "environment-ssh",
    workspaceRoot: "/remote/project",
    defaultThreadEnvMode: null,
    defaultModelSelection: null,
  };
  return {
    readProject: () => (testState.projectRemoved ? null : project),
    readProjects: () => (testState.projectRemoved ? [] : [project]),
    readThreadShell: () => null,
    readThreadShells: () => [],
    useProjects: () => [],
    useThread: () => null,
  };
});
vi.mock("../state/projects", () => ({ defaultProjectFallbackReadyAtom: () => true }));
vi.mock("../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));
vi.mock("../state/presentation", () => ({
  environmentSummaries: { connectedEnvironmentIdsAtom: "connected-environment-ids" },
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteTarget: () => testState.openDraftRoute,
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ getClientSettings: () => ({}) }));

import { resolveDefaultProjectRef, useNewThreadHandler } from "./useHandleNewThread";

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
    testState.reset(draft, { envMode: null, startFromOrigin: false });
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

  it("resolves to the draft another opener showed for the same project meanwhile", async () => {
    testState.reset(draft, { envMode: null, startFromOrigin: false });
    const pendingOpen = useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { replace: true },
    );

    // The location moves before the route matches do.
    testState.registerDraft({
      draftId: "draft-home",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-home",
    });
    testState.router.state.location.href = "/draft/draft-home";
    testState.completeProjectFileRead(null);

    await expect(pendingOpen).resolves.toEqual({
      draftId: "draft-home",
      threadId: "thread-home",
    });
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
    testState.reset(draft, { envMode: null, startFromOrigin: false });
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
  it("opens synchronously from a fresh, settled cached file", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: true });
    const now = Date.parse("2026-01-02T00:00:00.000Z");
    using _clock = vi.spyOn(Date, "now").mockReturnValue(now);
    testState.cacheProjectFile(now);

    const pendingOpen = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(testState.router.navigate).toHaveBeenCalledOnce();
    expect(testState.readT3ProjectFile).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      expect.anything(),
      "draft-delayed",
      expect.objectContaining({ envMode: "worktree", startFromOrigin: true }),
    );
    await pendingOpen;
  });

  it.each([
    { label: "stale cache", ageMs: 60_000, waiting: false },
    { label: "in-flight refresh", ageMs: 0, waiting: true },
  ])(
    "waits for the authoritative file read on $label when the workspace mode changes",
    async ({ ageMs, waiting }) => {
      testState.reset(null, { envMode: null, startFromOrigin: true });
      const now = Date.parse("2026-01-02T00:00:00.000Z");
      using _clock = vi.spyOn(Date, "now").mockReturnValue(now);
      testState.cacheProjectFile(
        now - ageMs,
        { contents: '{"defaultThreadEnvMode":"local"}', byteLength: 32 },
        waiting,
      );

      const pendingOpen = useNewThreadHandler()({
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never);

      expect(testState.readT3ProjectFile).toHaveBeenCalledWith(
        "environment-ssh",
        "/remote/project",
      );
      expect(testState.router.navigate).not.toHaveBeenCalled();
      expect(testState.draftStore.setLogicalProjectDraftThreadId).not.toHaveBeenCalled();

      testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
      await pendingOpen;

      expect(testState.router.navigate).toHaveBeenCalledOnce();
      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        expect.anything(),
        "draft-delayed",
        expect.objectContaining({ envMode: "worktree", startFromOrigin: true }),
      );
    },
  );

  it.each([{ exists: false }, { truncated: true }])(
    "uses the fallback synchronously for a missing or truncated cached file (%j)",
    async (file) => {
      testState.reset(null, { envMode: null, startFromOrigin: false });
      const now = Date.parse("2026-01-02T00:00:00.000Z");
      using _clock = vi.spyOn(Date, "now").mockReturnValue(now);
      testState.cacheProjectFile(now, file);
      const pendingOpen = useNewThreadHandler()({
        environmentId: "environment-ssh",
        projectId: "project-remote",
      } as never);
      expect(testState.router.navigate).toHaveBeenCalledOnce();
      expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
        "remote-project",
        expect.anything(),
        "draft-delayed",
        expect.objectContaining({ envMode: "local" }),
      );
      await pendingOpen;
    },
  );

  it("opens synchronously from an optimistic edit while the base read is pending", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: true });
    testState.editProjectFile('{"defaultThreadEnvMode":"worktree"}');
    const pendingOpen = useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);
    expect(testState.router.navigate).toHaveBeenCalledOnce();
    expect(testState.readT3ProjectFile).not.toHaveBeenCalled();
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      expect.anything(),
      "draft-delayed",
      expect.objectContaining({ envMode: "worktree", startFromOrigin: true }),
    );
    await pendingOpen;
  });

  it("waits for the file default when a fresh draft supplies only a branch", async () => {
    testState.reset(null, { envMode: null, startFromOrigin: true });

    const pendingOpen = useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { branch: "topic" },
    );

    expect(testState.readT3ProjectFile).toHaveBeenCalledWith("environment-ssh", "/remote/project");
    expect(testState.router.navigate).not.toHaveBeenCalled();
    testState.completeProjectFileRead({ defaultThreadEnvMode: "worktree" });
    await pendingOpen;
    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      "remote-project",
      expect.anything(),
      "draft-delayed",
      expect.objectContaining({ branch: "topic", envMode: "worktree", startFromOrigin: true }),
    );
  });

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

    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
    expect(testState.router.navigate).toHaveBeenCalledOnce();
  });
});

describe("default project selection", () => {
  it("prefers the last used project in its environment and falls back when unavailable", () => {
    const projects = [
      { id: "project", environmentId: "first", workspaceRoot: "/first" },
      { id: "project", environmentId: "last-used", workspaceRoot: "/last-used" },
    ].map((project) => ({
      ...project,
      id: project.id as ProjectId,
      environmentId: project.environmentId as EnvironmentId,
      title: project.environmentId,
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-11-09T00:00:00.000Z",
      updatedAt: "2026-11-09T00:00:00.000Z",
    }));
    expect(resolveDefaultProjectRef(projects, [], "last-used:project")).toEqual({
      environmentId: "last-used",
      projectId: "project",
    });
    expect(
      resolveDefaultProjectRef(projects.slice(0, 1), [], "last-used:project", false),
    ).toBeNull();
    expect(resolveDefaultProjectRef(projects.slice(0, 1), [], "last-used:project")).toEqual({
      environmentId: "first",
      projectId: "project",
    });
    expect(
      resolveDefaultProjectRef(
        [projects[0]!, { ...projects[1]!, archivedAt: "2026-11-09T00:00:00.000Z" }],
        [],
        "last-used:project",
      ),
    ).toEqual({ environmentId: "first", projectId: "project" });
  });
});
