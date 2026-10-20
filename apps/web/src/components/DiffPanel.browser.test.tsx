import "~/index.css";

import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  type ReviewDiffPreviewResult,
  type ReviewDiffPreviewSource,
} from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock("../hooks/useThreadRouteTarget", () => ({
  useThreadRouteRef: () => threadRef,
  useThreadRouteTarget: () => ({ ...threadRef, kind: "thread" }),
}));
vi.mock("../state/entities", () => ({
  useQuietThreadShell: () => thread,
  useThreadCheckpointSummaries: () => turns,
  useProject: () => null,
}));
vi.mock("../state/filesystem", () => ({ useFilesystemReadAccess: () => ({ canReadFiles: true }) }));
vi.mock("../state/server", () => ({ serverEnvironment: { configValueAtom: () => configAtom } }));
vi.mock("../state/vcs", () => ({ vcsEnvironment: { status: () => null, listRefs: () => null } }));
vi.mock("../state/review", () => ({
  reviewEnvironment: {
    diffPreview: () => previewAtom,
    diffFilePatch: ({ input }: { input: { request: { file: { path: string } } } }) =>
      patchAtoms(input.request.file.path),
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => ({
    ...DEFAULT_CLIENT_SETTINGS,
    diffFilesCollapsed: useAtomValue(collapsedAtom),
  }),
  updateClientSettings: vi.fn(),
}));
vi.mock("../hooks/useTheme", () => ({
  useRenderedAppearance: () => "dark",
  useTheme: () => ({ resolvedTheme: "dark" }),
}));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../fileContextMenu", () => ({ useFileContextMenuHandler: () => vi.fn() }));
vi.mock("../lib/checkpointDiffState", () => ({
  useCheckpointDiff: () => {
    const diff = useAtomValue(checkpointAtom);
    return { data: diff === null ? null : { diff }, isPending: diff === null, error: null };
  },
}));

import DiffPanel from "./DiffPanel";
import { useDiffPanelStore } from "../diffPanelStore";

const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
const thread = { ...threadRef, worktreePath: "/repo" };
const turns = [1, 2].map((ordinal) => ({
  runId: RunId.make(`turn-${ordinal}`),
  checkpointTurnCount: ordinal,
  completedAt: "2026-10-16T00:00:00Z",
}));
const paths = ["a.txt", "b.txt", "c.txt", "d.txt", "e.txt"];
function filePatch(path: string) {
  const count = path === "e.txt" ? 30 : 4;
  const lines = Array.from({ length: count }, (_, index) => `+after ${index}`).join("\n");
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,${count} @@\n-before\n${lines}\n`;
}
const source: ReviewDiffPreviewSource = {
  id: "branch",
  kind: "branch-range",
  title: "Changes",
  baseRef: "main",
  headRef: "HEAD",
  diff: "",
  diffHash: "branch-diff",
  truncated: true,
  files: paths.map((path) => ({
    path,
    previousPath: null,
    additions: path === "e.txt" ? 30 : 4,
    deletions: 1,
  })),
};
const configAtom = Atom.make(null);
const collapsedAtom = Atom.make(true);
const checkpointAtom = Atom.make<string | null>(null);
const previewAtom = Atom.make(
  AsyncResult.success<ReviewDiffPreviewResult>({
    cwd: "/repo",
    generatedAt: DateTime.makeUnsafe("2026-10-16T00:00:00Z"),
    sources: [source, { ...source, id: "working", kind: "working-tree" }],
  }),
);
function loadedPatch(path: string): ReviewDiffPreviewSource {
  return {
    ...source,
    diff: filePatch(path),
    files: source.files?.filter((file) => file.path === path) ?? [],
    truncated: false,
  };
}
const patchAtoms = Atom.family((path: string) =>
  Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource>>(
    path === "e.txt" ? AsyncResult.initial() : AsyncResult.success(loadedPatch(path)),
  ),
);
let registry: AtomRegistry.AtomRegistry;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.setItem("t3code.diffFileTreeOpen", "true");
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  registry = AtomRegistry.make();
  container = document.createElement("div");
  container.style.cssText = "width: 1000px; height: 300px";
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  localStorage.clear();
  vi.unstubAllGlobals();
});
async function render() {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <DiffPanel
          visible
          mode="embedded"
          composerDraftTarget={threadRef}
          workspaceMutationId={null}
        />
      </RegistryContext.Provider>,
    ),
  );
}
const toggle = (path: string, expanded: boolean) =>
  page.getByRole("button", { name: `${expanded ? "Collapse" : "Expand"} ${path}`, exact: true });
const viewport = () => container.querySelector<HTMLElement>(".diff-render-surface")!;
async function selectTurn(path?: string, turn = turns[0]!) {
  await act(async () => useDiffPanelStore.getState().selectTurn(threadRef, turn.runId, path));
}
async function expectRevealed(path: string) {
  await expect.element(toggle(path, true)).toBeInTheDocument();
  await expect
    .poll(() => {
      const bounds = viewport().getBoundingClientRect();
      const header = toggle(path, true).element().getBoundingClientRect();
      return viewport().scrollTop > 0 && header.top >= bounds.top && header.bottom <= bounds.bottom;
    })
    .toBe(true);
}
async function scrollToStart() {
  await act(async () => {
    viewport().scrollTop = 0;
    viewport().dispatchEvent(new Event("scroll"));
    await new Promise(requestAnimationFrame);
  });
}
async function selectTreeFile(path: string) {
  const tree = container.querySelector("file-tree-container")!;
  const row = tree.shadowRoot!.querySelector<HTMLElement>(`[data-item-path="${path}"]`)!;
  await act(async () =>
    row.dispatchEvent(
      new MouseEvent("click", { bubbles: true, composed: true, button: 0, detail: 1 }),
    ),
  );
}

it("reveals a delayed turn selection, preserves siblings, and repeats after scope changes", async () => {
  await selectTurn("e.txt");
  await render();
  await expect
    .element(page.getByRole("status", { name: "Loading checkpoint diff..." }))
    .toBeInTheDocument();
  await act(async () => registry.set(checkpointAtom, paths.map(filePatch).join("")));
  await expectRevealed("e.txt");
  await act(async () => useDiffPanelStore.getState().selectGitScope(threadRef, "branch"));
  await expect.element(toggle("a.txt", false)).toBeInTheDocument();
  await selectTurn("e.txt");
  await expectRevealed("e.txt");
  await scrollToStart();
  await toggle("a.txt", false).click();
  await selectTurn("b.txt");
  await expect.element(toggle("b.txt", true)).toBeInTheDocument();
  await toggle("b.txt", true).click();
  await selectTurn("e.txt");
  await expectRevealed("e.txt");
  await scrollToStart();
  await expect.element(toggle("a.txt", true)).toBeInTheDocument();
  await expect.element(toggle("b.txt", false)).toBeInTheDocument();
  await expect.element(toggle("c.txt", false)).toBeInTheDocument();
  await selectTurn("e.txt");
  await expectRevealed("e.txt");

  await selectTurn(undefined, turns[1]!);
  await expect.element(toggle("a.txt", false)).toBeInTheDocument();
  await expect.element(toggle("e.txt", false)).toBeInTheDocument();
});

it("waits for a lazy Git patch while preserving sibling choices and expanded defaults", async () => {
  registry.set(collapsedAtom, false);
  await render();
  await toggle("b.txt", true).click();
  await selectTreeFile("b.txt");
  await expect.element(toggle("b.txt", true)).toBeInTheDocument();
  await toggle("b.txt", true).click();
  await scrollToStart();
  await selectTreeFile("e.txt");
  expect(viewport().scrollTop).toBe(0);
  await expect.element(toggle("e.txt", true)).not.toBeInTheDocument();
  await act(async () =>
    registry.set(patchAtoms("e.txt"), AsyncResult.success(loadedPatch("e.txt"))),
  );
  await expectRevealed("e.txt");
  await scrollToStart();
  await expect.element(toggle("a.txt", true)).toBeInTheDocument();
  await expect.element(toggle("b.txt", false)).toBeInTheDocument();
  await act(async () => useDiffPanelStore.getState().selectGitScope(threadRef, "unstaged"));
  await expect.element(toggle("b.txt", true)).toBeInTheDocument();
});
