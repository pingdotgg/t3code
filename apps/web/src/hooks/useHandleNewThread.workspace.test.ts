import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { useNewThreadHandler } from "./useHandleNewThread";

const harness = vi.hoisted(() => ({
  envMode: "worktree" as "local" | "worktree",
  router: {
    state: {
      location: { href: "/agents" },
      matches: [{ params: {} as Record<string, string> }],
    },
    navigate: vi.fn(async ({ params }: { params: { draftId: string } }) => {
      harness.router.state.location.href = `/draft/${params.draftId}`;
      harness.router.state.matches = [{ params }];
    }),
  },
}));

vi.mock("@effect/atom-react", async () => {
  const { DEFAULT_SERVER_SETTINGS } = await import("@t3tools/contracts");
  return {
    useAtomValue: () =>
      new Map([
        [
          "environment-ssh",
          {
            settings: {
              ...DEFAULT_SERVER_SETTINGS,
              defaultThreadEnvMode: harness.envMode,
              newWorktreesStartFromOrigin: true,
              defaultModelSelection: null,
              defaultRuntimeMode: "full-access",
            },
          },
        ],
      ]),
  };
});
vi.mock("@tanstack/react-router", () => ({ useRouter: () => harness.router }));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T>(callback: T) => callback,
}));
vi.mock("../components/Sidebar.logic", () => ({ orderItemsByPreferredIds: () => [] }));
vi.mock("../logicalProject", () => ({
  deriveLogicalProjectKeyFromSettings: () => "logical-project",
  getProjectOrderKey: () => "logical-project",
  selectProjectGroupingSettings: () => ({}),
}));
vi.mock("../state/entities", () => ({
  readProjects: () => [
    {
      id: "project",
      environmentId: "environment-ssh",
      workspaceRoot: "/workspace/project",
      title: "Project",
      scripts: [],
      defaultModelSelection: null,
    },
  ],
  readThreadShell: () => null,
  useThreadShell: () => null,
  useProjects: () => [],
}));
vi.mock("../state/server", () => ({ environmentServerConfigsAtom: {} }));
vi.mock("../lib/t3ProjectFileDefaults", () => ({ readT3ProjectFile: async () => null }));
vi.mock("./useSettings", () => ({ useClientSettings: () => ({}) }));
vi.mock("../uiStateStore", () => ({
  legacyProjectCwdPreferenceKey: () => "logical-project",
  useUiStateStore: () => [],
}));

const projectRef = scopeProjectRef(
  EnvironmentId.make("environment-ssh"),
  ProjectId.make("project"),
);
const draftId = DraftId.make("old-task-draft");
const threadId = ThreadId.make("old-task-thread");
const initial = useComposerDraftStore.getInitialState();

beforeEach(() => {
  useComposerDraftStore.setState(initial, true);
  harness.envMode = "worktree";
  harness.router.state.location.href = "/agents";
  harness.router.state.matches = [{ params: {} }];
  harness.router.navigate.mockClear();
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId("logical-project", projectRef, draftId, {
      threadId,
      branch: "release/old",
      worktreePath: "/workspace/old-task",
      worktreeBranch: "team/old-issue",
      envMode: "worktree",
      startFromOrigin: false,
    });
});
afterEach(() => useComposerDraftStore.setState(initial, true));

describe("new-thread workspace reset with the persisted draft store", () => {
  it.each(["local", "worktree"] as const)(
    "clears a stale task branch when reopening an empty draft with %s defaults",
    async (envMode) => {
      harness.envMode = envMode;
      const opened = await useNewThreadHandler()(projectRef);
      expect(opened).toEqual({ draftId, threadId });
      expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
        branch: null,
        worktreePath: null,
        worktreeBranch: null,
        envMode,
        startFromOrigin: envMode === "worktree",
      });
      expect(harness.router.state.location.href).toBe(`/draft/${draftId}`);
    },
  );

  it("preserves a branch explicitly chosen in the currently open empty draft", async () => {
    harness.router.state.location.href = `/draft/${draftId}`;
    harness.router.state.matches = [{ params: { draftId } }];
    await useNewThreadHandler()(projectRef);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      branch: "release/old",
      worktreePath: "/workspace/old-task",
      worktreeBranch: "team/old-issue",
    });
    expect(harness.router.navigate).not.toHaveBeenCalled();
  });

  it.each(["team/new-issue", null])(
    "honors an explicit task branch of %s on reused drafts",
    async (worktreeBranch) => {
      await useNewThreadHandler()(projectRef, {
        branch: "main",
        worktreePath: null,
        envMode: "worktree",
        worktreeBranch,
      });
      expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
        branch: "main",
        worktreePath: null,
        envMode: "worktree",
        worktreeBranch,
      });
    },
  );

  it("keeps invested task drafts intact and starts new work without inheriting their branch", async () => {
    useComposerDraftStore.getState().setPrompt(draftId, "Continue investigating the old issue");
    const opened = await useNewThreadHandler()(projectRef);
    expect(opened?.draftId).not.toBe(draftId);
    const freshDraft = useComposerDraftStore.getState().getDraftSession(opened!.draftId);
    expect(freshDraft).toBeDefined();
    expect(freshDraft?.worktreeBranch).toBeUndefined();
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.worktreeBranch).toBe(
      "team/old-issue",
    );
    expect(useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt).toBe(
      "Continue investigating the old issue",
    );
  });
});
