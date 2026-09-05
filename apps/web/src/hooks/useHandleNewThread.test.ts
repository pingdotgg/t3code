import { EnvironmentId, ProjectId, type ScopedProjectRef } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => {
  type StoredDraft = {
    readonly draftId: string;
    readonly environmentId: string;
    readonly logicalProjectKey: string;
    readonly promotedTo: null;
    readonly threadId: string;
  };
  let completeProjectFileRead: (value: null) => void = () => undefined;
  let projectFileRead = Promise.resolve<null>(null);
  let storedDraft: StoredDraft | null = null;
  let prompts: Record<string, string> = {};
  let navigationFailure: Error | null = null;
  let completeNavigation: (() => void) | null = null;
  const router = {
    state: {
      location: { href: "/" },
      matches: [{ params: {} }],
    },
    navigate: vi.fn(async (request: { readonly params: { readonly draftId: string } }) => {
      if (navigationFailure !== null) throw navigationFailure;
      if (completeNavigation !== null) {
        await new Promise<void>((resolve) => {
          completeNavigation = resolve;
        });
      }
      router.state.location.href = `/draft/${request.params.draftId}`;
    }),
  };
  const draftStore = {
    getComposerDraft: vi.fn((draftId: string) => ({ prompt: prompts[draftId] ?? "" })),
    getDraftSessionByLogicalProjectKey: vi.fn(() => storedDraft),
    getDraftSession: vi.fn((draftId: string) =>
      storedDraft?.draftId === draftId ? storedDraft : null,
    ),
    getDraftThread: vi.fn(() => null),
    applyStickyState: vi.fn(),
    setDraftThreadContext: vi.fn(),
    setLogicalProjectDraftThreadId: vi.fn(
      (
        logicalProjectKey: string,
        projectRef: { readonly environmentId: string },
        draftId: string,
        state: { readonly threadId: string },
      ) => {
        storedDraft = {
          draftId,
          environmentId: projectRef.environmentId,
          logicalProjectKey,
          promotedTo: null,
          threadId: state.threadId,
        };
      },
    ),
    setModelSelection: vi.fn(),
    setPrompt: vi.fn((draftId: string, prompt: string) => {
      prompts[draftId] = prompt;
    }),
  };

  return {
    completeProjectFileRead: (value: null) => completeProjectFileRead(value),
    draftStore,
    get projectFileRead() {
      return projectFileRead;
    },
    editPrompt(draftId: string, prompt: string) {
      prompts[draftId] = prompt;
    },
    prompt(draftId: string) {
      return prompts[draftId];
    },
    reset(nextStoredDraft: Omit<StoredDraft, "logicalProjectKey"> | null) {
      storedDraft =
        nextStoredDraft === null
          ? null
          : { ...nextStoredDraft, logicalProjectKey: "remote-project" };
      prompts = {};
      navigationFailure = null;
      completeNavigation = null;
      router.state.location.href = "/";
      router.navigate.mockClear();
      draftStore.setLogicalProjectDraftThreadId.mockClear();
      draftStore.setPrompt.mockClear();
      projectFileRead = new Promise<null>((resolve) => {
        completeProjectFileRead = resolve;
      });
    },
    router,
    holdNavigation() {
      completeNavigation = () => undefined;
    },
    releaseNavigation() {
      completeNavigation?.();
      completeNavigation = null;
    },
    setNavigationFailure(error: Error | null) {
      navigationFailure = error;
    },
  };
});

vi.mock("@effect/atom-react", () => ({
  useAtomValue: () => ({ defaultThreadEnvMode: "local", newWorktreesStartFromOrigin: false }),
}));
vi.mock("@t3tools/client-runtime/environment", () => ({
  scopedProjectKey: () => "remote-project",
  scopeProjectRef: (environmentId: string, projectId: string) => ({ environmentId, projectId }),
  scopeThreadRef: (environmentId: string, threadId: string) => ({ environmentId, threadId }),
}));
vi.mock("@t3tools/contracts", () => ({
  DEFAULT_RUNTIME_MODE: "default",
  EnvironmentId: { make: (value: string) => value },
  ProjectId: { make: (value: string) => value },
}));
vi.mock("@t3tools/shared/threadEnvMode", () => ({
  resolveDefaultThreadEnvMode: (input: {
    readonly projectFile: "local" | "worktree" | null;
    readonly globalDefault: "local" | "worktree";
  }) => input.projectFile ?? input.globalDefault,
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
    composerDraftHasUserContent: (draft: { readonly prompt?: string }) =>
      (draft.prompt?.length ?? 0) > 0,
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
vi.mock("../state/server", () => ({ primaryServerSettingsAtom: {} }));
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

  it.each([
    ["new", null, "draft-delayed"],
    [
      "reused",
      {
        draftId: "draft-existing",
        environmentId: "environment-ssh",
        promotedTo: null,
        threadId: "thread-existing",
      },
      "draft-existing",
    ],
  ])("writes an initial prompt before navigating to a %s draft", async (_, draft, draftId) => {
    testState.reset(draft);
    const openThread = useNewThreadHandler();
    const pendingOpen = openThread(
      { environmentId: "environment-ssh", projectId: "project-remote" } as never,
      { initialPrompt: "Generated handover" },
    );

    testState.completeProjectFileRead(null);
    const opened = await pendingOpen;

    expect(opened?.draftId).toBe(draftId);
    expect(testState.draftStore.setPrompt).toHaveBeenCalledWith(draftId, "Generated handover");
    expect(testState.router.navigate).toHaveBeenCalledOnce();
    expect(testState.draftStore.setPrompt.mock.invocationCallOrder[0]!).toBeLessThan(
      testState.router.navigate.mock.invocationCallOrder[0]!,
    );
  });

  it("reopens the initialized draft after navigation fails without overwriting edits", async () => {
    testState.reset(null);
    testState.setNavigationFailure(new Error("navigation failed"));
    const openThread = useNewThreadHandler();
    let retainedDraftId: string | undefined;
    const open = () =>
      openThread({ environmentId: "environment-ssh", projectId: "project-remote" } as never, {
        initialPrompt: "Generated handover",
        ...(retainedDraftId === undefined ? {} : { reopenDraftId: retainedDraftId as never }),
        onDraftReady: (draftId) => {
          retainedDraftId = draftId;
        },
      });

    const firstOpen = open();
    testState.completeProjectFileRead(null);
    await expect(firstOpen).rejects.toThrow("navigation failed");
    expect(retainedDraftId).toBe("draft-delayed");
    testState.editPrompt("draft-delayed", "Edited handover");

    testState.setNavigationFailure(null);
    const reopened = await open();

    expect(reopened?.draftId).toBe("draft-delayed");
    expect(testState.prompt("draft-delayed")).toBe("Edited handover");
    expect(testState.draftStore.setPrompt).toHaveBeenCalledOnce();
    expect(testState.router.navigate).toHaveBeenCalledTimes(2);
  });

  it("does not deliver a raced handover into another invocation's draft", async () => {
    testState.reset(null);
    testState.holdNavigation();
    const openThread = useNewThreadHandler();
    const projectRef = {
      environmentId: EnvironmentId.make("environment-ssh"),
      projectId: ProjectId.make("project-remote"),
    } satisfies ScopedProjectRef;
    const ordinaryOpen = openThread(projectRef);
    const onHandoverDraftReady = vi.fn();
    const handoverOpen = openThread(projectRef, {
      initialPrompt: "Generated handover",
      onDraftReady: onHandoverDraftReady,
    });

    testState.completeProjectFileRead(null);

    await expect(handoverOpen).resolves.toBeNull();
    expect(testState.draftStore.setPrompt).not.toHaveBeenCalled();
    expect(onHandoverDraftReady).not.toHaveBeenCalled();
    expect(testState.router.navigate).toHaveBeenCalledOnce();

    testState.releaseNavigation();
    await expect(ordinaryOpen).resolves.toMatchObject({ draftId: "draft-delayed" });
  });
});
