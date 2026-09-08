import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => {
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
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
  const draftStore = {
    getComposerDraft: vi.fn(() => ({})),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn(() => null),
    getDraftThread: vi.fn(() => null),
    getLastUsedRuntimeMode: vi.fn(() => null),
    setLastUsedRuntimeMode: vi.fn(),
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
    reset(nextStoredDraft: typeof storedDraft) {
      storedDraft = nextStoredDraft;
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.getComposerDraft.mockReset();
      draftStore.getComposerDraft.mockImplementation(() => ({}));
      draftStore.getLastUsedRuntimeMode.mockReset();
      draftStore.getLastUsedRuntimeMode.mockImplementation(() => null);
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setRuntimeMode.mockClear();
      draftStore.setInteractionMode.mockClear();
      draftStore.setDraftThreadContext.mockClear();
      draftStore.setLastUsedRuntimeMode.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "primary-settings"
      ? { newWorktreesStartFromOrigin: false }
      : new Map([
          [
            "environment-ssh",
            {
              settings: {
                defaultThreadEnvMode: "local",
                newWorktreesStartFromOrigin: false,
                defaultModelSelection: null,
              },
            },
          ],
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
    readonly lastUsedRuntimeMode?: string | null;
    readonly configuredRuntimeMode?: string | null;
  }) =>
    sources.draftRuntimeMode ??
    sources.carryRuntimeMode ??
    sources.lastUsedRuntimeMode ??
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
vi.mock("../lib/chatThreadActions", () => ({
  hasExplicitComposerModelSelection: () => false,
  resolveNewDraftStartFromOrigin: () => false,
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
vi.mock("../threadRoutes", () => ({ resolveThreadRouteTarget: () => null }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "remote-project",
  useUiStateStore: () => [],
}));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));

import { useNewThreadHandler } from "./useHandleNewThread";

describe("useNewThreadHandler", () => {
  it.each([
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
  ])("abandons a delayed %s draft open when the user navigates elsewhere", async (_, draft) => {
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
    // No composer pick yet — do not seed last-used into the composer draft.
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
    testState.draftStore.getLastUsedRuntimeMode.mockImplementation(() => "auto-accept-edits");
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

  it("does not seed last-used from the machine default alone", async () => {
    testState.reset(null);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread({
      environmentId: "environment-ssh",
      projectId: "project-remote",
    } as never);

    testState.completeProjectFileRead(null);
    await pendingOpen;

    expect(testState.draftStore.setLastUsedRuntimeMode).not.toHaveBeenCalled();
  });
});
