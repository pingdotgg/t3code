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
  patch: null as unknown as ResultAtom<ReviewDiffPreviewSource>,
  diffFilesCollapsed: false,
  project: {
    workspaceRoot: "/project",
    repositoryIdentity: null,
  } as {
    workspaceRoot: string;
    repositoryIdentity: { rootPath: string } | null;
    trackedFolders?: ReadonlyArray<unknown>;
  },
  gitRepositories: [] as ReadonlyArray<{ repositoryPath: string; name: string; cwd: string }>,
  taskFolder: null as { projectIsWorktree: boolean } | null,
  gitRepositoriesLoading: false,
  diffPreviewCwds: [] as string[],
  branchCommitsCwds: [] as string[],
  toolCallItem: null as unknown,
  config: null as unknown as Atom.Atom<null>,
  status: null as unknown as ResultAtom<VcsStatusResult>,
  localRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  remoteRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  commits: null as unknown as ResultAtom<ReviewBranchCommitsResult>,
  checkpoints: [] as unknown[],
  checkpointDiff: null as Partial<OrchestrationGetTurnDiffResult> | null,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => state.config },
}));
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffPreview: ({ input }: { input: { cwd: string; baseRef?: string } }) => {
      state.diffPreviewCwds.push(input.cwd);
      return state.previews.get(input.baseRef ?? null)!;
    },
    branchCommits: ({ input }: { input: { cwd: string } }) => {
      state.branchCommitsCwds.push(input.cwd);
      return state.commits;
    },
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
vi.mock("~/hooks/useThreadGitRepositories", () => ({
  useThreadGitRepositories: () => ({
    repositories: state.gitRepositories,
    taskFolder: state.taskFolder,
    settled: !state.gitRepositoriesLoading,
  }),
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
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlState: () => ({
    _tag: "Success",
    url: "data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACH5BAEAAAAALAAAAAABAAEAAAICRAEAOw==",
    expiresAt: Number.MAX_SAFE_INTEGER,
  }),
}));
vi.mock("./diffs/DiffFileTree", () => ({ DiffFileTree: () => null }));
vi.mock("./DiffFilePathCopyButton", () => ({ DiffFilePathCopyButton: () => null }));

import DiffPanel from "./DiffPanel";
import {
  chooseThreadGitRepository,
  useDiffPanelSessionStore,
  useDiffPanelStore,
} from "~/diffPanelStore";
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
      gitRepositoryPathByThreadKey: {},
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
    useRightPanelStore.setState({ byThreadKey: {}, threadPanelVisibilityByThreadKey: {} });
  };
  reset();
  state.diffFilesCollapsed = false;
  state.project = { workspaceRoot: "/project", repositoryIdentity: null };
  state.gitRepositories = [];
  state.taskFolder = null;
  state.gitRepositoriesLoading = false;
  state.diffPreviewCwds = [];
  state.branchCommitsCwds = [];
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
  state.previews.set(null, Atom.make(AsyncResult.success(preview())));
  state.previews.set("main", Atom.make(AsyncResult.success(preview())));
  state.previews.set(failedBaseRef, Atom.make(AsyncResult.fail(new Error(errorMessage))));
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

it("explains a branch diff whose only changes are hidden test files", async () => {
  using context = setup("origin/orphan");
  using _hideTestFiles = {
    [Symbol.dispose]() {
      window.localStorage.removeItem("t3code.diffHideTestFiles");
    },
  };
  const path = "math.test.ts";
  const metadata = preview();
  const source = {
    ...metadata.sources[0]!,
    files: [{ path, previousPath: null, additions: 1, deletions: 0 }],
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
  await expect.element(screen.getByText(path, { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Hide test files", exact: true }));
  await expect.element(screen.getByText(path, { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("1 test file hidden", { exact: true })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Show test files", exact: true }));
  await expect.element(screen.getByText(path, { exact: true })).toBeVisible();
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

it("previews a changed image when its file row is expanded", async () => {
  using context = setup("origin/orphan");
  const path = "changed.png";
  const metadata = preview();
  const source = {
    ...metadata.sources[0]!,
    files: [{ path, previousPath: null, additions: 0, deletions: 0 }],
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
  await userEvent.click(screen.getByRole("button", { name: `Expand ${path}`, exact: true }));
  await act(() =>
    context.registry.set(
      context.patch,
      AsyncResult.success({
        ...source,
        diff: `diff --git a/${path} b/${path}\nindex 19fc4a5..fd0af9e 100644\nBinary files a/${path} and b/${path} differ\n`,
      }),
    ),
  );
  await expect
    .element(screen.getByRole("button", { name: `Collapse ${path}`, exact: true }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByRole("img", { name: path })).toBeVisible();
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

it.each([
  { width: 600, path: "docs/server", fullPath: true },
  { width: 480, path: "docs/server", fullPath: true },
  { width: 480, path: "services/billing/api-server", fullPath: false },
  { width: 390, path: "docs/server", fullPath: false },
])("shows the repository path $path in a $width px panel", async ({ width, path, fullPath }) => {
  using context = setup("origin/orphan");
  // A feature branch against the automatic base, as most threads compare.
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, null);
  const branchPreview = preview();
  state.previews.set(
    null,
    Atom.make(
      AsyncResult.success({
        ...branchPreview,
        sources: branchPreview.sources.map((source) => ({
          ...source,
          headRef: "feature/43-nested-repos",
          baseRef: null,
        })),
      } as ReviewDiffPreviewResult),
    ),
  );
  state.project = { ...state.project, trackedFolders: [{ path: "server" }] };
  state.gitRepositories = ["server", path].map((repositoryPath) => ({
    repositoryPath: `/project/${repositoryPath}`,
    name: "server",
    cwd: `/project/${repositoryPath}`,
  }));
  chooseThreadGitRepository(context.threadRef, `/project/${path}`);
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, width, display: "flex", flexDirection: "column" }}>
        <DiffPanel
          mode="embedded"
          composerDraftTarget={context.threadRef}
          workspaceMutationId={null}
          visible
        />
      </div>
    </RegistryContext.Provider>,
  );
  const picker = screen.getByRole("button", { name: `Repository: ${path}` });
  const label = picker.getByText(path, { exact: true });
  await expect.element(label).toBeVisible();
  await vi.waitFor(() => {
    // The path, which tells `docs/server` from `server`, is not cut short where it fits.
    if (fullPath) {
      expect(label.element().scrollWidth).toBeLessThanOrEqual(label.element().clientWidth);
    }
    // At any width the header row still fits the panel.
    const headerRow = picker.element().parentElement!;
    expect(headerRow.scrollWidth).toBeLessThanOrEqual(headerRow.clientWidth);
  });
});

it("starts on the task folder's first repository when its project folder is no repository", async () => {
  using context = setup("origin/orphan");
  // The plain project folder sits inside an enclosing checkout, so Git calls it a repository.
  state.taskFolder = { projectIsWorktree: false };
  state.project = { ...state.project, trackedFolders: [{ path: "web" }] };
  state.gitRepositories = ["web", "server"].map((path) => ({
    repositoryPath: `/project/${path}`,
    name: path,
    cwd: `/task/${path}`,
  }));
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, width: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel
          mode="embedded"
          composerDraftTarget={context.threadRef}
          workspaceMutationId={null}
          visible
        />
      </div>
    </RegistryContext.Provider>,
  );
  // The same default the thread details panel resolves.
  const picker = screen.getByRole("button", { name: "Repository: web" });
  await expect.element(picker).toBeVisible();
  await userEvent.click(picker);
  await expect.element(page.getByRole("menuitemradio", { name: "plain" })).not.toBeInTheDocument();
});

it.each([
  { panel: "hidden", visible: false },
  { panel: "shown", visible: true },
])(
  "waits for a chosen repository before reading anything of it while the panel is $panel",
  async ({ visible }) => {
    using context = setup("origin/orphan");
    state.project = { ...state.project, trackedFolders: [{ path: "web" }] };
    // After a reload the chosen repository is known, but the repositories are still being read.
    chooseThreadGitRepository(context.threadRef, "/project/web");
    useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
    state.gitRepositoriesLoading = true;
    const panel = () => (
      <RegistryContext.Provider value={context.registry}>
        <div style={{ height: 600, width: 600, display: "flex", flexDirection: "column" }}>
          <DiffPanel
            mode="embedded"
            composerDraftTarget={context.threadRef}
            workspaceMutationId={null}
            visible={visible}
          />
        </div>
      </RegistryContext.Provider>
    );
    await using screen = await render(panel());
    // Nothing of the web repository is read in the thread's own folder: no diff, no commits.
    expect(state.diffPreviewCwds).not.toContain(cwd);
    expect(state.branchCommitsCwds).not.toContain(cwd);

    state.gitRepositoriesLoading = false;
    state.gitRepositories = [{ repositoryPath: "/project/web", name: "web", cwd: "/project/web" }];
    await screen.rerender(panel());
    await vi.waitFor(() => expect(state.diffPreviewCwds).toContain("/project/web"));
    expect(state.diffPreviewCwds).not.toContain(cwd);
    // A shown panel lists the chosen repository's commits, and never the thread folder's.
    if (visible) {
      await vi.waitFor(() => expect(state.branchCommitsCwds).toContain("/project/web"));
    }
    expect(state.branchCommitsCwds).not.toContain(cwd);
  },
);

it("goes back to the thread's folder once the folders are read without the chosen repository", async () => {
  using context = setup("origin/orphan");
  state.project = { ...state.project, trackedFolders: [{ path: "web" }] };
  chooseThreadGitRepository(context.threadRef, "/project/web");
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "origin/orphan");
  // The folders were read (or failed to be) and the web repository is not among them.
  state.gitRepositories = [{ repositoryPath: "/project/api", name: "api", cwd: "/project/api" }];
  await using screen = await render(
    <RegistryContext.Provider value={context.registry}>
      <div style={{ height: 600, width: 600, display: "flex", flexDirection: "column" }}>
        <DiffPanel
          mode="embedded"
          composerDraftTarget={context.threadRef}
          workspaceMutationId={null}
          visible
        />
      </div>
    </RegistryContext.Provider>,
  );
  // The thread's folder is compared on its own terms: the web repository's base ref, which
  // fails there, is set aside rather than sent.
  await vi.waitFor(() => expect(state.diffPreviewCwds).toContain(cwd));
  await expect.element(screen.getByText("No net changes in this selection.")).toBeVisible();
  await expect.element(screen.getByText(errorMessage, { exact: true })).not.toBeInTheDocument();

  // Picking the folder it stands in for replaces the lost choice, so the panel stays there when
  // the web repository is found again.
  const key = scopedThreadKey(context.threadRef);
  await userEvent.click(screen.getByRole("button", { name: "Repository: Project folder" }));
  await userEvent.click(page.getByRole("menuitemradio", { name: "Project folder" }));
  await vi.waitFor(() =>
    expect(useDiffPanelStore.getState().gitRepositoryPathByThreadKey[key]).toBeNull(),
  );
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
