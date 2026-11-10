import { RegistryContext } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type ClientSettings,
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
import { commands, page, userEvent } from "vite-plus/test/browser";

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
  config: null as unknown as Atom.Atom<null>,
  status: null as unknown as ResultAtom<VcsStatusResult>,
  localRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  remoteRefs: null as unknown as ResultAtom<VcsListRefsResult>,
  commits: null as unknown as ResultAtom<ReviewBranchCommitsResult>,
}));

vi.mock("~/state/server", () => ({
  serverEnvironment: { configValueAtom: () => state.config },
}));
vi.mock("~/state/review", () => ({
  reviewEnvironment: {
    diffPreview: ({ input }: { input: { baseRef?: string } }) =>
      state.previews.get(input.baseRef ?? null)!,
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
  useProject: () => ({ workspaceRoot: "/project", repositoryIdentity: null }),
  useThreadCheckpointSummaries: () => [],
  useQuietThreadVisibleTurnItems: () => [],
}));
vi.mock("~/state/filesystem", () => ({
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
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
  useCheckpointDiff: () => ({ data: null, error: null, isPending: false }),
  useTurnItemDetail: () => ({ data: null, error: null, isPending: false }),
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
      keepSelectionOnOpenThreadKey: null,
    });
    useDiffPanelSessionStore.setState({ collapsedFileKeysByScopeKey: {} });
  };
  reset();
  state.diffFilesCollapsed = false;
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

const longFileLines = Array.from(
  { length: 300 },
  (_, index) =>
    `SELECT ${index + 1} AS value, 'row ${index + 1}' AS label; -- fixture line ${index + 1}`,
);

async function renderLongFileDiff(
  context: ReturnType<typeof setup>,
  path: string,
  others: ReadonlyArray<{ path: string; lines: readonly string[] }> = [],
  lines: readonly string[] = longFileLines,
) {
  const files = [{ path, lines }, ...others];
  const metadata = preview();
  const source = {
    ...metadata.sources[0]!,
    files: files.map((file) => ({
      path: file.path,
      previousPath: null,
      additions: file.lines.length,
      deletions: 0,
    })),
  };
  state.previews.set("main", Atom.make(AsyncResult.success({ ...metadata, sources: [source] })));
  useDiffPanelStore.getState().selectBranchBaseRef(context.threadRef, "main");
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <RegistryContext.Provider value={context.registry}>
        <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
          <DiffPanel composerDraftTarget={context.threadRef} workspaceMutationId={null} visible />
        </div>
        <textarea aria-label="Paste target" />
      </RegistryContext.Provider>,
    ),
  );
  for (const file of files) {
    await userEvent.click(screen.getByRole("button", { name: `Expand ${file.path}`, exact: true }));
  }
  act(() =>
    context.registry.set(
      context.patch,
      AsyncResult.success({
        ...source,
        diff: files
          .map(
            (file) =>
              `diff --git a/${file.path} b/${file.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${file.path}\n@@ -0,0 +1,${file.lines.length} @@\n${file.lines.map((line) => `+${line}\n`).join("")}`,
          )
          .join(""),
      }),
    ),
  );
  await expect.element(screen.getByText(longFileLines[0]!, { exact: true })).toBeVisible();
  const roots = () =>
    [...screen.container.querySelectorAll("diffs-container")].map((host) => host.shadowRoot!);
  const pasteTarget = screen.getByRole("textbox", { name: "Paste target" });
  // A copy that writes nothing must not pass with an earlier copy's text.
  await userEvent.fill(pasteTarget, "nothing was copied");
  (pasteTarget.element() as HTMLTextAreaElement).select();
  await userEvent.copy();
  await userEvent.clear(pasteTarget);
  const copied = async () => {
    await userEvent.copy();
    const textarea = pasteTarget.element() as HTMLTextAreaElement;
    // Playwright's click on the textarea stalls once the viewer has scrolled; paste needs focus only.
    textarea.focus();
    await userEvent.paste();
    return textarea.value;
  };
  return {
    screen: stack.move(),
    row: (line: number, file = 0) =>
      roots()[file]?.querySelector<HTMLElement>(`[data-line="${line}"]`) ?? null,
    scroller: screen.container.querySelector<HTMLElement>(".diff-render-surface")!,
    copied,
    copiedRows: async () => (await copied()).trimEnd().split("\n"),
  };
}

// A point on one of a row's characters, relative to the row: the left edge puts
// the caret before it, the right edge after it.
function charEdge(row: HTMLElement, index: number, edge: "left" | "right") {
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
  let text = walker.nextNode() as Text;
  while (index >= text.length) {
    index -= text.length;
    text = walker.nextNode() as Text;
  }
  const char = document.createRange();
  char.setStart(text, index);
  char.setEnd(text, index + 1);
  const glyph = char.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  return {
    x: (edge === "left" ? glyph.left + 1 : glyph.right - 1) - box.left,
    y: glyph.top + glyph.height / 2 - box.top,
  };
}

// The start of a row's code sits under the gutter's comment button, so the
// press lands mid-row; later hovers extend the selection from it.
const PRESS_OFFSET = 10;

async function pressRow(row: HTMLElement) {
  await userEvent.hover(row, { position: charEdge(row, PRESS_OFFSET, "left") });
  await commands.mouseDown();
}

async function dragToRowEnd(row: HTMLElement) {
  const last = row.textContent!.trimEnd().length - 1;
  await userEvent.hover(row, { position: charEdge(row, last, "right") });
}

it("copies every row of a long file after select-all inside its diff", async () => {
  using context = setup("origin/orphan");
  const diff = await renderLongFileDiff(context, "select-all.sql");
  await using _screen = diff.screen;
  await userEvent.click(diff.row(2)!);
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
  const copied = await diff.copiedRows();
  expect(copied, "select-all copies the whole file, not only mounted rows").toHaveLength(300);
  expect(copied).toEqual(longFileLines);
});

it("copies a selection whose first row has scrolled out of the mounted rows", async () => {
  using context = setup("origin/orphan");
  const diff = await renderLongFileDiff(context, "scrolled-selection.sql");
  await using _screen = diff.screen;
  await userEvent.click(diff.row(1)!);
  const last = diff.row(20)!;
  const selected = new Promise((resolve) =>
    document.addEventListener("selectionchange", resolve, { once: true }),
  );
  document.getSelection()!.setBaseAndExtent(diff.row(1)!, 0, last, last.childNodes.length);
  await selected;
  diff.scroller.scrollTop = 4000;
  await vi.waitFor(() => {
    expect(diff.row(160)).not.toBeNull();
    expect(diff.row(1)).toBeNull();
  });
  expect(await diff.copiedRows()).toEqual(longFileLines.slice(0, 20));
});

it("copies every row of a drag whose first row scrolls out of the mounted rows", async () => {
  using context = setup("origin/orphan");
  const diff = await renderLongFileDiff(context, "dragged-selection.sql");
  await using _screen = diff.screen;
  await pressRow(diff.row(1)!);
  await dragToRowEnd(diff.row(5)!);
  diff.scroller.scrollTop = 4000;
  await vi.waitFor(() => {
    expect(diff.row(160)).not.toBeNull();
    expect(diff.row(1)).toBeNull();
  });
  // The row in the middle of the viewport, once the scrolled rows are laid out.
  const viewport = diff.scroller.getBoundingClientRect();
  const [x, y] = [viewport.left + viewport.width / 2, viewport.top + viewport.height / 2];
  const last = await vi.waitFor(() => {
    const row = document.elementFromPoint(x, y)?.shadowRoot?.elementFromPoint(x, y);
    const line = row?.closest<HTMLElement>("[data-line]");
    expect(line).toBeTruthy();
    return line!;
  });
  await dragToRowEnd(last);
  await commands.mouseUp();
  expect(await diff.copied()).toBe(
    longFileLines.slice(0, Number(last.dataset.line)).join("\n").slice(PRESS_OFFSET),
  );
});

it("copies a backward drag whose selection reports no direction", async () => {
  using context = setup("origin/orphan");
  const diff = await renderLongFileDiff(context, "backward-selection.sql");
  await using _screen = diff.screen;
  // macOS Chromium reports mouse selections this way.
  using _direction = vi.spyOn(Selection.prototype, "direction", "get").mockReturnValue("none");
  await pressRow(diff.row(12)!);
  const first = diff.row(4)!;
  await userEvent.hover(first, { position: charEdge(first, PRESS_OFFSET, "left") });
  await commands.mouseUp();
  const text = longFileLines.slice(3, 12).join("\n");
  expect(await diff.copied()).toBe(
    text.slice(PRESS_OFFSET, text.length - longFileLines[11]!.length + PRESS_OFFSET),
  );
});

it("copies through the first row of a backward drag into the file header", async () => {
  using context = setup("origin/orphan");
  const diff = await renderLongFileDiff(context, "header-drag.sql");
  await using _screen = diff.screen;
  await pressRow(diff.row(12)!);
  const fourth = diff.row(4)!;
  await userEvent.hover(fourth, { position: charEdge(fourth, PRESS_OFFSET, "left") });
  const host = (fourth.getRootNode() as ShadowRoot).host as HTMLElement;
  const title = host.shadowRoot!.querySelector("[data-diffs-header] [data-title]")!;
  const [titleBox, hostBox] = [title.getBoundingClientRect(), host.getBoundingClientRect()];
  await userEvent.hover(host, {
    position: { x: titleBox.left + 4 - hostBox.left, y: titleBox.top + 4 - hostBox.top },
  });
  await commands.mouseUp();
  const text = longFileLines.slice(0, 12).join("\n");
  expect(await diff.copied()).toBe(
    text.slice(0, text.length - longFileLines[11]!.length + PRESS_OFFSET),
  );
});

it("copies a drag whose last extension is still unreported when the pointer lifts", async () => {
  using context = setup("origin/orphan");
  const diff = await renderLongFileDiff(context, "late-selection.sql");
  await using _screen = diff.screen;
  await pressRow(diff.row(1)!);
  await dragToRowEnd(diff.row(6)!);
  const last = diff.row(11)!;
  document.getSelection()!.setBaseAndExtent(diff.row(1)!, 0, last, last.childNodes.length);
  // Before the selectionchange for the extension runs.
  document.dispatchEvent(new PointerEvent("pointerup"));
  await commands.mouseUp();
  expect(await diff.copied()).toBe(longFileLines.slice(0, 11).join("\n").slice(PRESS_OFFSET));
});

it("leaves select all to the browser once the engaged file is collapsed", async () => {
  using context = setup("origin/orphan");
  const diff = await renderLongFileDiff(context, "collapsed-select-all.sql");
  await using _screen = diff.screen;
  await userEvent.click(diff.row(2)!);
  await userEvent.click(
    page.getByRole("button", { name: "Collapse collapsed-select-all.sql", exact: true }),
  );
  await vi.waitFor(() => expect(diff.row(2)).toBeNull());
  await userEvent.keyboard("{ControlOrMeta>}a{/ControlOrMeta}");
  expect(await diff.copied()).not.toContain(longFileLines[0]);
});

it("copies the browser's selection of a drag that continues into another file", async () => {
  using context = setup("origin/orphan");
  const lines = longFileLines.slice(0, 3);
  const otherLines = ["other file first", "other file second", "other file third"];
  const diff = await renderLongFileDiff(
    context,
    "a.sql",
    [{ path: "b.sql", lines: otherLines }],
    lines,
  );
  await using _screen = diff.screen;
  await vi.waitFor(() => expect(diff.row(2, 1)).not.toBeNull());
  await pressRow(diff.row(1)!);
  await dragToRowEnd(diff.row(3)!);
  await dragToRowEnd(diff.row(2, 1)!);
  await commands.mouseUp();
  const copied = await diff.copied();
  expect(copied).toContain(lines.join("\n").slice(PRESS_OFFSET));
  expect(copied).toContain(otherLines[1]);
});

it("copies every row of a file after select all without a keydown", async () => {
  using context = setup("origin/orphan");
  const diff = await renderLongFileDiff(context, "menu-select-all.sql");
  await using _screen = diff.screen;
  await userEvent.click(diff.row(2)!);
  const selected = new Promise((resolve) =>
    document.addEventListener("selectionchange", resolve, { once: true }),
  );
  // What the Edit and context menus' Select All run.
  document.execCommand("selectAll");
  await selected;
  expect(await diff.copiedRows()).toEqual(longFileLines);
});
