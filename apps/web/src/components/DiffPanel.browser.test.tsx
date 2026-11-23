import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  CheckpointRef,
  CheckpointScopeId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  type ClientSettings,
  type OrchestrationGetTurnDiffResult,
  type ReviewBranchCommitsResult,
  type ReviewRepositoriesResult,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSource,
  type ScopedThreadRef,
  type VcsListRefsResult,
  type VcsStatusResult,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../test/render";
import { makeThreadFixture } from "~/test-fixtures";

type ResultAtom<A> = Atom.Atom<AsyncResult.AsyncResult<A, Error>>;

const state = vi.hoisted(() => ({
  thread: null as ReturnType<typeof makeThreadFixture> | null,
  threadRef: null as ScopedThreadRef | null,
  previews: new Map<string | null, ResultAtom<ReviewDiffPreviewResult>>(),
  repositoryPreviews: new Map<string, ResultAtom<ReviewDiffPreviewResult>>(),
  patch: null as unknown as ResultAtom<ReviewDiffPreviewSource>,
  diffFilesCollapsed: false,
  project: {
    workspaceRoot: "/project",
    repositoryIdentity: null as { rootPath: string } | null,
  },
  toolCallItem: null as unknown,
  config: null as unknown as Atom.Atom<null>,
  status: null as unknown as ResultAtom<VcsStatusResult>,
  localRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  remoteRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  repositories: null as unknown as ResultAtom<ReviewRepositoriesResult>,
  commits: null as unknown as ResultAtom<ReviewBranchCommitsResult>,
  checkpoints: [] as unknown[],
  checkpointDiff: null as Partial<OrchestrationGetTurnDiffResult> | null,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => state.config },
}));
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffPreview: ({ input }: { input: { cwd: string; baseRef?: string } }) =>
      state.repositoryPreviews.get(input.cwd) ?? state.previews.get(input.baseRef ?? null)!,
    repositories: () => state.repositories,
    branchCommits: () => state.commits,
    diffFilePatch: () => state.patch,
    diffFileContents: {},
  },
}));
vi.mock("~/state/vcs", () => ({
  vcsEnvironment: {
    status: () => state.status,
    listRefs: ({ input }: { input: { refKind: "local" | "remote" } }) =>
      input.refKind === "local" ? state.localRefs : state.remoteRefs,
  },
}));
vi.mock("~/state/entities", () => ({
  useQuietThreadShell: () => state.thread,
  useProject: () => state.project,
  useThreadCheckpointSummaries: () => state.checkpoints,
  useQuietThreadVisibleTurnItems: () => [],
  useQuietThreadProjection: () => null,
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
  filesystemEnvironment: {},
}));
vi.mock("~/hooks/useThreadRouteTarget", () => ({ useThreadRouteRef: () => state.threadRef }));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: ClientSettings) => unknown) =>
    select({ ...DEFAULT_CLIENT_SETTINGS, diffFilesCollapsed: state.diffFilesCollapsed }),
  updateClientSettings: async () => {},
}));
vi.mock("~/hooks/useTheme", () => ({
  useRenderedAppearance: () => "dark",
  getRenderedAppearance: () => "dark",
  subscribeRenderedAppearance: () => () => {},
}));
vi.mock("~/state/queries", () => ({
  useCheckpointDiff: () => ({ data: state.checkpointDiff, error: null, isPending: false }),
  useTurnItemDetail: () => ({
    data: state.toolCallItem ? { item: state.toolCallItem } : null,
    error: null,
    isPending: false,
  }),
  useDebouncedValue: <A,>(value: A) => value,
}));
vi.mock("~/state/use-atom-command", () => ({ useAtomCommand: () => async () => {} }));
vi.mock("~/editorPreferences", () => ({ useOpenInPreferredEditor: () => async () => {} }));
vi.mock("~/fileContextMenu", () => ({ useFileContextMenuHandler: () => () => {} }));
vi.mock("~/browser/useOpenLink", () => ({ useOpenLink: () => async () => {} }));
vi.mock("./diffs/DiffCommentAnnotation", () => ({ DiffCommentAnnotation: () => null }));
vi.mock("./diffs/DiffFileTree", () => ({ DiffFileTree: () => null }));
vi.mock("./DiffFilePathCopyButton", () => ({ DiffFilePathCopyButton: () => null }));

import DiffPanel from "./DiffPanel";
import { useDiffPanelSessionStore, useDiffPanelStore } from "~/diffPanelStore";
import { selectThreadRightPanelState, useRightPanelStore } from "~/rightPanelStore";

const cwd = "/project-worktree";
const errorMessage = "Could not find a common commit between 'origin/orphan' and HEAD.";

function preview(): ReviewDiffPreviewResult {
  return {
    cwd,
    generatedAt: DateTime.makeUnsafe("2026-10-30T00:00:00Z"),
    sources: [
      {
        id: "branch",
        kind: "branch-range",
        title: "Changes",
        baseRef: "main",
        headRef: "dev",
        diff: "",
        diffHash: "empty",
        truncated: false,
        patchesDeferred: true,
        files: [],
      },
    ],
  };
}

function setup(failedBaseRef: string | null) {
  const reset = () => {
    useDiffPanelStore.setState({
      byThreadKey: {},
      branchBaseRefByThreadKey: {},
      repositoryCwdByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
    useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  };
  reset();
  state.diffFilesCollapsed = false;
  state.project = { workspaceRoot: "/project", repositoryIdentity: null };
  state.toolCallItem = null;
  state.checkpoints = [];
  state.checkpointDiff = null;
  const patch = Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource, Error>>(
    AsyncResult.initial(),
  );
  state.patch = patch;
  state.threadRef = {
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
  };
  state.thread = makeThreadFixture({
    ...state.threadRef,
    id: state.threadRef.threadId,
    projectId: ProjectId.make("project"),
    branch: "dev",
    worktreePath: cwd,
  });
  state.previews.clear();
  state.repositoryPreviews.clear();
  state.previews.set(null, Atom.make(AsyncResult.success(preview())));
  state.previews.set("main", Atom.make(AsyncResult.success(preview())));
  state.previews.set(failedBaseRef, Atom.make(AsyncResult.fail(new Error(errorMessage))));
  state.repositories = Atom.make(AsyncResult.success({ repositories: [], truncated: false }));
  state.config = Atom.make(null);
  state.status = Atom.make(
    AsyncResult.success({
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "dev",
      hasWorkingTreeChanges: false,
      workingTree: { rootPath: cwd, files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
  );
  const refs = (names: string[], isRemote: boolean): VcsListRefsResult => ({
    isRepo: true,
    hasPrimaryRemote: true,
    nextCursor: null,
    totalCount: names.length,
    refs: names.map((name) => ({
      name,
      isRemote,
      ...(isRemote ? { remoteName: "origin" } : {}),
      current: name === "dev",
      isDefault: name === "main",
      worktreePath: null,
    })),
  });
  state.localRefs = Atom.make(AsyncResult.success(refs(["dev", "main"], false)));
  state.remoteRefs = Atom.make(AsyncResult.success(refs(["origin/orphan"], true)));
  state.commits = Atom.make(AsyncResult.success({ commits: [], truncated: false }));
  useDiffPanelStore.getState().selectBranchBaseRef(state.threadRef, failedBaseRef);
  const registry = AtomRegistry.make();
  return {
    registry,
    patch,
    threadRef: state.threadRef,
    [Symbol.dispose]() {
      registry.dispose();
      reset();
    },
  };
}

it.each([
  {
    name: "a saved unrelated branch",
    failedBaseRef: "origin/orphan",
    recovery: "Automatic",
    baseRef: null,
  },
  {
    name: "an automatic base with unrelated history",
    failedBaseRef: null,
    recovery: "main",
    baseRef: "main",
  },
])(
  "recovers from $name without leaving the diff panel",
  async ({ failedBaseRef, recovery, baseRef }) => {
    using context = setup(failedBaseRef);
    await using screen = await render(
      <RegistryContext.Provider value={context.registry}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </RegistryContext.Provider>,
    );
    await expect.element(screen.getByText(errorMessage, { exact: true })).toBeVisible();
    const selector = screen.getByRole("combobox", { name: /Change comparison target/ });
    await vi.waitFor(() => expect(selector.query()).not.toBeNull());
    await userEvent.click(selector);
    await expect.element(page.getByRole("option", { name: "main", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("option", { name: recovery, exact: true }));
    await expect.element(screen.getByText("No net changes in this selection.")).toBeVisible();
    await expect.element(screen.getByText(errorMessage, { exact: true })).not.toBeInTheDocument();
    const key = scopedThreadKey(context.threadRef);
    await vi.waitFor(() => {
      expect(useDiffPanelStore.getState().byThreadKey[key]).toEqual({ kind: "branch", baseRef });
      expect(useDiffPanelStore.getState().branchBaseRefByThreadKey[key]).toBe(baseRef);
    });
  },
);

it("opens a repository-relative file from a nested project without a remote", async () => {
  using context = setup("origin/orphan");
  state.thread = { ...state.thread!, worktreePath: null };
  const path = "project/back\\slash.txt";
  const metadata = preview();
  const source = {
    ...metadata.sources[0]!,
    files: [{ path, previousPath: null, additions: 1, deletions: 0 }],
  };
  state.previews.set("main", Atom.make(AsyncResult.success({ ...metadata, sources: [source] })));
  state.status = Atom.make(
    AsyncResult.success({
      ...AsyncResult.getOrElse(context.registry.get(state.status), () => {
        throw new Error("Missing status");
      }),
      workingTree: { rootPath: "/", files: [], insertions: 0, deletions: 0 },
    }),
  );
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.getByText(path, { exact: true }));
  expect(
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, context.threadRef),
  ).toMatchObject({ activeSurfaceId: "file:back\\slash.txt" });
});

it.each([false, true])(
  "expands an unloaded file on the first click with default collapse %s",
  async (collapsed) => {
    using context = setup("origin/orphan");
    state.diffFilesCollapsed = collapsed;
    const path = `pending-${collapsed}.txt`;
    const metadata = preview();
    const source = {
      ...metadata.sources[0]!,
      files: [{ path, previousPath: null, additions: 1, deletions: 1 }],
    };
    state.previews.set("main", Atom.make(AsyncResult.success({ ...metadata, sources: [source] })));
    useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
    await using screen = await render(
      <RegistryContext.Provider value={context.registry}>
        <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
          <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
        </div>
      </RegistryContext.Provider>,
    );
    const toggle = screen.getByRole("button", { name: `Expand ${path}`, exact: true });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(toggle);
    await act(() =>
      context.registry.set(
        context.patch,
        AsyncResult.success({
          ...source,
          diff: `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`,
        }),
      ),
    );
    const loadedToggle = screen.getByRole("button", { name: `Collapse ${path}`, exact: true });
    await expect.element(loadedToggle).toHaveAttribute("aria-expanded", "true");
    await expect.element(screen.getByText("after", { exact: true })).toBeVisible();
    await userEvent.click(loadedToggle);
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
  },
);

it("switches Changes between the workspace and an initialized submodule", async () => {
  using context = setup("main");
  const childCwd = `${cwd}/packages/auth`;
  state.repositories = Atom.make(
    AsyncResult.success({
      repositories: [
        { cwd, name: "workspace", path: "", branch: "dev" },
        { cwd: childCwd, name: "auth", path: "packages/auth", branch: "fix-auth" },
      ],
      truncated: false,
    }),
  );
  const childPreview = preview();
  state.repositoryPreviews.set(
    childCwd,
    Atom.make(
      AsyncResult.success({
        ...childPreview,
        cwd: childCwd,
        sources: childPreview.sources.map((source) => ({ ...source, baseRef: "auth-base" })),
      }),
    ),
  );
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Repository: Project folder: dev" }));
  await userEvent.click(page.getByRole("option", { name: /auth: fix-auth/ }));
  await expect
    .element(screen.getByRole("combobox", { name: "Repository: auth: fix-auth" }))
    .toBeVisible();
  await expect.element(screen.getByLabelText("Comparing dev against auth-base")).toBeVisible();
  expect(
    useDiffPanelStore.getState().branchBaseRefByThreadKey[scopedThreadKey(context.threadRef)],
  ).toBeNull();
});

it("keeps the loading state while a saved repository is still being discovered", async () => {
  using context = setup(null);
  state.repositories = Atom.make(AsyncResult.initial(true));
  useDiffPanelStore.getState().selectRepository(context.threadRef, `${cwd}/packages/auth`);
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByRole("status", { name: "Loading changes..." })).toBeVisible();
});

it("shows a failed repository discovery instead of the workspace diff", async () => {
  using context = setup(null);
  state.repositories = Atom.make(AsyncResult.fail(new Error("discovery failed")));
  useDiffPanelStore.getState().selectRepository(context.threadRef, `${cwd}/packages/auth`);
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("discovery failed", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Review the thread's repository" }));
  await expect
    .element(screen.getByText("discovery failed", { exact: true }))
    .not.toBeInTheDocument();
  expect(
    useDiffPanelStore.getState().repositoryCwdByThreadKey[scopedThreadKey(context.threadRef)],
  ).toBeUndefined();
});

it("says a turn diff cut off at the server's size limit is incomplete", async () => {
  using context = setup("origin/orphan");
  state.checkpoints = [
    {
      runId: "run",
      checkpointTurnCount: 1,
      checkpointRef: "ref",
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: "2026-01-01T00:00:00Z",
    },
  ];
  state.checkpointDiff = {
    diff: "diff --git a/first.txt b/first.txt\n--- a/first.txt\n+++ b/first.txt\n@@ -0,0 +1 @@\n+visible\n\n[truncated]",
  };
  useDiffPanelStore.getState().selectTurn(context.threadRef, RunId.make("run"));
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  await expect.element(screen.getByText("first.txt", { exact: true }).first()).toBeVisible();
  await expect
    .element(screen.getByText("This preview exceeds the size limit. Changes shown are incomplete."))
    .toBeVisible();
});

it("shows a turn's repositories in a folder that is not a Git repository", async () => {
  using context = setup("origin/orphan");
  state.status = Atom.make(
    AsyncResult.success({
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    }),
  );
  const patch = (path: string) =>
    `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`;
  const repository = (name: string) => ({
    scopeId: CheckpointScopeId.make(`scope-${name}`),
    name,
    repositoryPath: `${cwd}/${name}`,
    cwd: `${cwd}/${name}`,
    relativePath: name,
    files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 1 }],
    baselineMissing: false,
  });
  state.checkpoints = [
    {
      runId: RunId.make("run-1"),
      checkpointTurnCount: 1,
      checkpointRef: CheckpointRef.make("refs/t3/root-1"),
      status: "missing",
      files: [],
      repositories: [repository("api"), repository("web")],
      assistantMessageId: null,
      completedAt: "2026-11-10T00:00:00.000Z",
    },
  ];
  state.checkpointDiff = {
    threadId: context.threadRef.threadId,
    fromTurnCount: 0,
    toTurnCount: 1,
    diff: "",
    repositories: ["api", "web"].map((name) => ({
      name,
      repositoryPath: `${cwd}/${name}`,
      relativePath: name,
      diff: patch("README.md"),
    })),
  };
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, width: 390, display: "flex", flexDirection: "column" }}>
        <DiffPanel
          mode="embedded"
          composerDraftTarget={context.threadRef}
          workspaceMutationId={null}
          visible
        />
      </div>
    </RegistryContext.Provider>,
  );
  const api = screen.getByRole("button", { name: "Collapse api/README.md", exact: true });
  const web = screen.getByRole("button", { name: "Collapse web/README.md", exact: true });
  await expect.element(api).toBeVisible();
  await expect.element(web).toBeVisible();
  // Both pickers keep their labels in a phone-width panel.
  await expect.element(screen.getByText("Latest turn", { exact: true })).toBeVisible();
  const picker = screen.getByRole("button", { name: "Repository: All repositories" });
  await expect.element(picker.getByText("All repositories")).toBeVisible();
  await userEvent.click(picker);
  await userEvent.click(page.getByRole("menuitemradio", { name: "web" }));
  await expect.element(web).toBeVisible();
  await expect.element(api).not.toBeInTheDocument();
});

// Paths as git's numstat reports them; the parsed patch keeps their edge whitespace.
it.each([
  { path: " leading.ts", name: " leading.ts" },
  { path: "src/trailing.ts ", name: "src/trailing.ts " },
])("reveals the turn file $path picked from the changed files", async ({ path, name }) => {
  using context = setup("origin/orphan");
  state.diffFilesCollapsed = true;
  state.checkpoints = [
    {
      runId: "run",
      checkpointTurnCount: 1,
      checkpointRef: "ref",
      status: "ready",
      files: [],
      assistantMessageId: null,
      completedAt: "2026-01-01T00:00:00Z",
    },
  ];
  state.checkpointDiff = {
    diff: `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\t\n@@ -0,0 +1 @@\n+revealed\n`,
  };
  useDiffPanelStore.getState().selectTurn(context.threadRef, RunId.make("run"), path);
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  await expect
    .element(screen.getByRole("button", { name: `Collapse ${name}`, exact: true }))
    .toHaveAttribute("aria-expanded", "true");
});

it("opens a file from a tool call's diff by the path its agent recorded", async () => {
  using context = setup("origin/orphan");
  // A local thread in a project that is the repository's apps/web folder.
  state.thread = { ...state.thread!, worktreePath: null };
  state.project = { workspaceRoot: "/repo/apps/web", repositoryIdentity: { rootPath: "/repo" } };
  const status = AsyncResult.getOrThrow(context.registry.get(state.status));
  state.status = Atom.make(
    AsyncResult.success({ ...status, workingTree: { ...status.workingTree, rootPath: "/repo" } }),
  );
  // Claude's Edit can record a path relative to the workspace, unlike the repository's diffs.
  state.toolCallItem = {
    type: "file_change",
    fileName: "src/a.ts",
    diffStr: "--- src/a.ts\n+++ src/a.ts\n@@ -1 +1 @@\n-before\n+after\n",
  };
  useDiffPanelStore.getState().selectToolCall(context.threadRef, {
    threadId: context.threadRef.threadId,
    itemId: TurnItemId.make("edit"),
    revision: "1",
  });
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div className="flex h-[600px] flex-col">
        <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
      </div>
    </RegistryContext.Provider>,
  );
  await userEvent.click(screen.getByText("src/a.ts", { exact: true }));
  await vi.waitFor(() =>
    expect(
      selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, context.threadRef),
    ).toMatchObject({ activeSurfaceId: "file:src/a.ts" }),
  );
});
