import { describe, expect, it, vi } from "vite-plus/test";
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
    providerInstances: {} as Record<string, unknown>,
    projectSettingsOverrides: {} as Record<string, unknown>,
  };
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  let providersByEnvironment: ReadonlyMap<string, ReadonlyArray<unknown>> = new Map();
  let modelSelectionOverride: unknown = null;
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
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get projectRemoved() {
      return projectRemoved;
    },
    get providersByEnvironment() {
      return providersByEnvironment;
    },
    get modelSelectionOverride() {
      return modelSelectionOverride;
    },
    set modelSelectionOverride(value: unknown) {
      modelSelectionOverride = value;
    },
    setProviders(entries: ReadonlyArray<readonly [string, ReadonlyArray<unknown>]>) {
      providersByEnvironment = new Map(entries);
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
      providersByEnvironment = new Map();
      modelSelectionOverride = null;
      connectedEnvironmentIds = ["environment-primary", "environment-ssh"];
      targetSettings = {
        defaultThreadEnvMode: workspaceDefaults.envMode,
        newWorktreesStartFromOrigin: workspaceDefaults.startFromOrigin,
        defaultModelSelection: null,
        defaultRuntimeMode: "full-access",
        providerInstances: {},
        projectSettingsOverrides: {},
      };
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setModelSelection.mockClear();
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
          newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin,
        },
      },
    ],
    ["environment-ssh", { settings: testState.targetSettings }],
  ]);

vi.mock("../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) =>
      atom === "providers-by-environment-atom"
        ? testState.providersByEnvironment
        : atom === "connected-environment-ids"
          ? testState.connectedEnvironmentIds
          : testServerConfigs(),
  },
}));

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: !testState.targetSettings.newWorktreesStartFromOrigin }
      : testServerConfigs(),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", () => ({
  DEFAULT_RUNTIME_MODE: "default",
  DEFAULT_SERVER_SETTINGS: { providerInstances: {}, projectSettingsOverrides: {} },
  ProviderInstanceId: { make: (value: string) => value },
  defaultInstanceIdForDriver: (driver: string) => driver,
  DEFAULT_MODEL_BY_PROVIDER: {},
  PROVIDER_DISPLAY_NAMES: {},
  resolveProjectProviderInstanceEnabled: (
    settings: {
      providerInstances?: Record<string, { enabled?: boolean }>;
      projectSettingsOverrides?: Record<
        string,
        { providerInstances?: Record<string, { enabled?: boolean }> }
      >;
    },
    projectId: string | null,
    instanceId: string,
  ) =>
    (projectId === null
      ? undefined
      : settings.projectSettingsOverrides?.[projectId]?.providerInstances?.[instanceId]?.enabled) ??
    settings.providerInstances?.[instanceId]?.enabled ??
    true,
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
  resolveNewThreadModelSelectionOverride: () => testState.modelSelectionOverride,
}));
vi.mock("../providerInstances", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../providerInstances")>()),
  resolveDefaultProviderModelSelection: () => null,
}));
vi.mock("../lib/t3ProjectFileDefaults", () => ({
  readT3ProjectFile: () => testState.projectFileRead,
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
vi.mock("../state/olderSettledShelf", () => ({ readUnloadedThreadCount: () => 0 }));
vi.mock("../state/presentation", () => ({
  environmentPresentations: { providersByEnvironmentAtom: "providers-by-environment-atom" },
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
vi.mock("@t3tools/shared/model", () => ({
  resolveSelectableModel: (_: unknown, model: string, options: Array<{ slug: string }>) =>
    options.find((option) => option.slug === model)?.slug ?? null,
}));
vi.mock("../modelSelection", () => ({
  getAppModelOptionsForInstance: (_: unknown, entry: { models: unknown[] }) => entry.models,
}));
vi.mock("./useSettings", () => ({
  getClientSettings: () => ({}),
  mergeEnvironmentSettings: (server: object, client: object) => ({ ...client, ...server }),
}));

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

  it("sets the prompt and pins the machine before the draft shows", async () => {
    testState.reset(draft);
    const pendingOpen = useNewThreadHandler()(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { prompt: "Read the playbook. ", environmentSelection: "manual" },
    );

    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;

    expect(testState.draftStore.setLogicalProjectDraftThreadId).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      opened?.draftId,
      expect.objectContaining({ environmentSelection: "manual" }),
    );

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

describe("useNewThreadHandler picker-carried model selection", () => {
  const projectRef = {
    environmentId: "environment-ssh",
    projectId: "project-remote",
  } as never;
  const pickerSelection = { instanceId: "codex", model: "gpt-5.4-codex" } as never;
  const selectableCodexProvider = {
    instanceId: "codex",
    driver: "codex",
    enabled: true,
    installed: true,
    status: "ready",
    availability: "available",
    models: [{ slug: "gpt-5.4-codex", name: "GPT-5.4 Codex", isCustom: false }],
  };

  it.each([
    ["new", null],
    [
      "reused",
      {
        draftId: "draft-existing",
        environmentId: "environment-ssh",
        promotedTo: null,
        threadId: "thread-existing",
      },
    ],
  ] as const)(
    "applies the picker's explicit provider selection to the %s destination draft",
    async (_, draft) => {
      testState.reset(draft);
      testState.setProviders([["environment-ssh", [selectableCodexProvider]]]);
      const projectDefault = { instanceId: "claudeAgent", model: "claude-sonnet" };
      testState.modelSelectionOverride = projectDefault;
      const openThread = useNewThreadHandler();

      const pendingOpen = openThread(projectRef, { modelSelection: pickerSelection });
      testState.completeProjectFileRead(null);
      const opened = await pendingOpen;

      expect(opened).not.toBeNull();
      expect(testState.draftStore.setModelSelection).toHaveBeenCalledWith(
        opened!.draftId,
        pickerSelection,
        { explicit: true, replaceOptions: true },
      );
      expect(testState.draftStore.setModelSelection).not.toHaveBeenCalledWith(
        opened!.draftId,
        projectDefault,
        expect.anything(),
      );
    },
  );

  it.each([
    ["provider", []],
    ["model", [{ ...selectableCodexProvider, models: [] }]],
  ] as const)(
    "falls back to ordinary resolution when the destination machine lacks the %s",
    async (_, providers) => {
      testState.reset(null);
      testState.setProviders([["environment-ssh", providers]]);
      const openThread = useNewThreadHandler();

      const pendingOpen = openThread(projectRef, { modelSelection: pickerSelection });
      testState.completeProjectFileRead(null);
      const opened = await pendingOpen;

      expect(opened).not.toBeNull();
      expect(testState.draftStore.setModelSelection).not.toHaveBeenCalledWith(
        "draft-delayed",
        pickerSelection,
        expect.anything(),
      );
    },
  );

  it("falls back to ordinary resolution when project settings disable the provider", async () => {
    testState.reset(null);
    testState.setProviders([["environment-ssh", [selectableCodexProvider]]]);
    testState.targetSettings.projectSettingsOverrides = {
      "project-remote": { providerInstances: { codex: { enabled: false } } },
    } as never;
    const openThread = useNewThreadHandler();

    const pendingOpen = openThread(projectRef, { modelSelection: pickerSelection });
    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;

    expect(opened).not.toBeNull();
    expect(testState.draftStore.setModelSelection).not.toHaveBeenCalledWith(
      "draft-delayed",
      pickerSelection,
      expect.anything(),
    );
  });

  it("leaves ordinary new-thread resolution untouched without a picker selection", async () => {
    testState.reset(null);
    testState.setProviders([["environment-ssh", [selectableCodexProvider]]]);
    const openThread = useNewThreadHandler();

    const pendingOpen = openThread(projectRef);
    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;

    expect(opened).not.toBeNull();
    expect(testState.draftStore.setModelSelection).not.toHaveBeenCalled();
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

    const opened = await useNewThreadHandler()({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    expect(opened).toEqual({ draftId: "draft-delayed", threadId: "thread-delayed" });
    expect(testState.router.navigate).toHaveBeenCalledOnce();
  });
});
