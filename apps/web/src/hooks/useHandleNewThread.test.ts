import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let targetSettings = {
    defaultThreadEnvMode: "local" as "local" | "worktree",
    newWorktreesStartFromOrigin: false,
    defaultModelSelection: null,
    defaultRuntimeMode: "full-access" as const,
  };
  let storedDraft: {
    readonly draftId: string;
    readonly environmentId: string;
    readonly promotedTo: null;
    readonly threadId: string;
  } | null = null;
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  let routeTarget: { readonly kind: "draft"; readonly draftId: string } | null = null;
  let viewedDraftSession: {
    readonly draftId: string;
    readonly logicalProjectKey: string;
    readonly runtimeMode: string;
  } | null = null;
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn((draftId: string) =>
      viewedDraftSession?.draftId === draftId ? viewedDraftSession : null,
    ),
    getDraftThread: vi.fn(() => null),
    getStickyRuntimeMode: vi.fn((): string | null => null),
    setStickyRuntimeMode: vi.fn(),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(),
    setModelSelection: vi.fn(),
    setRuntimeMode: vi.fn(),
    setInteractionMode: vi.fn(),
  };

  return {
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    get targetSettings() {
      return targetSettings;
    },
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
      routeTarget = null;
      viewedDraftSession = null;
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.getComposerDraft.mockReset();
      draftStore.getComposerDraft.mockImplementation(() => ({}));
      draftStore.getStickyRuntimeMode.mockReset();
      draftStore.getStickyRuntimeMode.mockImplementation(() => null);
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setRuntimeMode.mockClear();
      draftStore.setInteractionMode.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setStickyRuntimeMode.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    routeTarget: {
      get current() {
        return routeTarget;
      },
      set(next: typeof routeTarget) {
        routeTarget = next;
      },
    },
    router,
    viewedDraftSession: {
      set(next: typeof viewedDraftSession) {
        viewedDraftSession = next;
      },
    },
  };
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
vi.mock("@t3tools/contracts", () => ({
  DEFAULT_SERVER_SETTINGS: {},
}));
vi.mock("@t3tools/shared/projectSettings", () => ({
  // Environment settings pass through; the tests set project fields on the
  // project record, which the hook still honors until the server folds them.
  resolveProjectSettings: (settings: Record<string, unknown>) => ({
    settings,
    sources: { defaultModelSelection: "environment", defaultThreadEnvMode: "environment" },
    overrides: {},
  }),
}));
vi.mock("@t3tools/shared/threadEnvMode", () => ({
  resolveDefaultThreadEnvMode: (input: {
    readonly projectFile: "local" | "worktree" | null;
    readonly globalDefault: "local" | "worktree";
  }) => input.projectFile ?? input.globalDefault,
}));
vi.mock("@t3tools/shared/runtimeMode", () => ({
  resolveNewThreadRuntimeMode: (sources: {
    readonly draftRuntimeMode?: string | null;
    readonly carryRuntimeMode?: string | null;
    readonly stickyRuntimeMode?: string | null;
    readonly configuredRuntimeMode?: string | null;
  }) =>
    sources.draftRuntimeMode ??
    sources.carryRuntimeMode ??
    sources.stickyRuntimeMode ??
    sources.configuredRuntimeMode ??
    "full-access",
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
  readT3ProjectFileDefaultThreadEnvMode: () => testState.projectFileRead,
}));
vi.mock("../lib/utils", () => ({
  newDraftId: () => "draft-delayed",
  newThreadId: () => "thread-delayed",
}));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "remote-project",
  getProjectOrderKey: () => "remote-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [
    {
      id: "project-remote",
      environmentId: "environment-ssh",
      workspaceRoot: "/remote/project",
      defaultThreadEnvMode: null,
      defaultModelSelection: null,
    },
  ],
  readThreadShell: () => null,
  useProjects: () => [],
  useThread: () => null,
}));
vi.mock("../state/server", () => ({
  environmentServerConfigsAtom: {},
  primaryServerSettingsAtom: "primary-settings",
}));
vi.mock("../threadRoutes", () => ({
  resolveThreadRouteTarget: () => testState.routeTarget.current,
}));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

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

  it("writes resolved runtime mode onto the draft session when resurrecting an empty draft", async () => {
    testState.reset({
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    });
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(
      "draft-existing",
      expect.objectContaining({ runtimeMode: "full-access" }),
    );
    // No composer pick yet — do not seed sticky into the composer draft.
    expect(testState.draftStore.setRuntimeMode).not.toHaveBeenCalled();
    expect(testState.router.navigate).toHaveBeenCalled();
  });

  it("keeps an empty draft's explicit composer runtime mode on resurrect", async () => {
    testState.reset({
      draftId: "draft-existing",
      environmentId: "environment-ssh",
      promotedTo: null,
      threadId: "thread-existing",
    });
    testState.draftStore.getComposerDraft.mockImplementation(() => ({
      runtimeMode: "approval-required",
    }));
    testState.draftStore.getStickyRuntimeMode.mockImplementation(() => "auto-accept-edits");
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.draftStore.setDraftThreadContext).toHaveBeenCalledWith(
      "draft-existing",
      expect.objectContaining({ runtimeMode: "approval-required" }),
    );
    expect(testState.draftStore.setRuntimeMode).toHaveBeenCalledWith(
      "draft-existing",
      "approval-required",
    );
  });

  it("does not seed sticky from the machine default alone", async () => {
    testState.reset(null);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.draftStore.setStickyRuntimeMode).not.toHaveBeenCalled();
  });

  it("does not sticky a viewed draft's seeded runtime mode", async () => {
    testState.reset(null);
    testState.routeTarget.set({ kind: "draft", draftId: "draft-viewed" });
    testState.viewedDraftSession.set({
      draftId: "draft-viewed",
      logicalProjectKey: "remote-project",
      runtimeMode: "full-access",
    });
    // Composer has no explicit pick — only the draft-session seed exists.
    testState.draftStore.getComposerDraft.mockImplementation(() => ({}));
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.draftStore.setStickyRuntimeMode).not.toHaveBeenCalled();
  });

  it("stickies carry from an explicit composer pick on a viewed draft", async () => {
    testState.reset(null);
    testState.routeTarget.set({ kind: "draft", draftId: "draft-viewed" });
    testState.viewedDraftSession.set({
      draftId: "draft-viewed",
      logicalProjectKey: "remote-project",
      runtimeMode: "full-access",
    });
    testState.draftStore.getComposerDraft.mockImplementation(() => ({
      runtimeMode: "approval-required",
    }));
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.draftStore.setStickyRuntimeMode).toHaveBeenCalledWith(
      "remote-project",
      "approval-required",
    );
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
        "remote-project",
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
        "remote-project",
        projectRef,
        opened!.draftId,
        expect.objectContaining({ envMode: "worktree", startFromOrigin }),
      );
    },
  );
});
