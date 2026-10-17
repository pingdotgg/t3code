// @vitest-environment jsdom

import { RegistryContext } from "@effect/atom-react";
import type { CodeViewScrollTarget } from "@pierre/diffs";
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
import {
  act,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  type ComponentProps,
  type ReactNode,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  patchAvailable: true,
  scroll: vi.fn<(target: CodeViewScrollTarget, collapsed: boolean | undefined) => void>(),
  requestPatch: vi.fn<(path: string) => void>(),
}));

vi.mock("@tanstack/react-router", () => ({ useParams: () => threadRef }));
vi.mock("../state/entities", () => ({
  useThreadShell: () => ({ ...threadRef, worktreePath: "/repo" }),
  useThreadProjection: () => null,
  useProject: () => null,
}));
vi.mock("../state/filesystem", () => ({ useFilesystemReadAccess: () => ({ canReadFiles: true }) }));
vi.mock("../state/server", () => ({ serverEnvironment: { configValueAtom: () => configAtom } }));
vi.mock("../state/vcs", () => ({
  vcsEnvironment: { status: () => null, listRefs: () => null },
}));
vi.mock("../state/review", () => ({
  reviewEnvironment: {
    diffPreview: () => previewAtom,
    diffFilePatch: ({ input }: { input: { request: { file: { path: string } } } }) => {
      state.requestPatch(input.request.file.path);
      return patchAtoms(input.request.file.path);
    },
  },
}));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../hooks/useSettings", () => ({
  useClientSettings: () => ({ ...DEFAULT_CLIENT_SETTINGS, diffFilesCollapsed: true }),
  useUpdateClientSettings: () => vi.fn(),
}));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useLocalStorage", () => ({ useLocalStorage: () => [true, vi.fn()] }));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("../fileContextMenu", () => ({ useFileContextMenuHandler: () => vi.fn() }));
vi.mock("../hooks/useTurnDiffSummaries", () => ({
  useTurnDiffSummaries: () => ({
    turnDiffSummaries: turns,
    inferredCheckpointTurnCountByRunId: {},
  }),
}));
vi.mock("../lib/checkpointDiffState", () => ({
  useCheckpointDiff: () => ({
    data: state.patchAvailable ? { diff: patch } : null,
    isPending: !state.patchAvailable,
  }),
}));
vi.mock("./ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render?: ReactNode; children?: ReactNode }) =>
    render ?? children,
  TooltipPopup: () => null,
}));
vi.mock("./diffs/DiffFileTree", () => ({
  DiffFileTree: ({
    entries,
    onSelectFile,
  }: ComponentProps<typeof import("./diffs/DiffFileTree").DiffFileTree>) =>
    entries.map(({ path }) => (
      <button key={path} onClick={() => onSelectFile(path)}>
        Reveal {path}
      </button>
    )),
}));

// Keep the panel's real state, patch loading, and reveal effects. Replace only the
// virtual viewer with headers and a scroll handle that observes committed rows.
vi.mock("./diffs/AnnotatableCodeView", () => ({
  AnnotatableCodeView: ({ files, viewerRef, renderHeaderPrefix }: ViewerProps) => {
    const committedFiles = useRef(files);
    useLayoutEffect(() => {
      committedFiles.current = files;
    }, [files]);
    useImperativeHandle(
      viewerRef,
      () => ({
        getInstance: () => committedFiles,
        scrollTo: (target: CodeViewScrollTarget) => {
          const file =
            target.type === "item"
              ? committedFiles.current.find((file) => file.fileKey === target.id)
              : undefined;
          state.scroll(target, file?.collapsed);
        },
      }),
      [],
    );
    return files.map((file) => (
      <section key={file.fileKey} aria-label={file.filePath}>
        {renderHeaderPrefix?.(file.fileDiff, file.fileKey, file.collapsed)}
        {!file.collapsed && <pre>{file.filePath} changes</pre>}
      </section>
    ));
  },
}));

import DiffPanel from "./DiffPanel";
import { useDiffPanelStore } from "../diffPanelStore";
import type { AnnotatableCodeView } from "./diffs/AnnotatableCodeView";

type ViewerProps = Pick<
  ComponentProps<typeof AnnotatableCodeView>,
  "files" | "renderHeaderPrefix"
> & {
  viewerRef: Ref<{ getInstance(): object; scrollTo(target: CodeViewScrollTarget): void }>;
};
const threadRef = scopeThreadRef(EnvironmentId.make("environment"), ThreadId.make("thread"));
const turns = [1, 2].map((ordinal) => ({
  runId: RunId.make(`turn-${ordinal}`),
  checkpointTurnCount: ordinal,
  completedAt: "2026-10-16T00:00:00Z",
}));
const paths = ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"];
function filePatch(path: string) {
  return `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-before\n+after\n`;
}
const patch = paths.map(filePatch).join("");
const source: ReviewDiffPreviewSource = {
  id: "branch",
  kind: "branch-range",
  title: "Changes",
  baseRef: "main",
  headRef: "HEAD",
  diff: patch,
  diffHash: "branch-diff",
  truncated: true,
  files: paths.map((path) => ({ path, previousPath: null, additions: 1, deletions: 1 })),
};
const configAtom = Atom.make(null);
const previewAtom = Atom.make(
  AsyncResult.success<ReviewDiffPreviewResult>({
    cwd: "/repo",
    generatedAt: DateTime.makeUnsafe("2026-10-16T00:00:00Z"),
    sources: [source, { ...source, id: "working", kind: "working-tree" }],
  }),
);
const patchAtoms = Atom.family((path: string) =>
  Atom.make<AsyncResult.AsyncResult<ReviewDiffPreviewSource>>(
    paths.indexOf(path) < 4 ? AsyncResult.success(loadedPatch(path)) : AsyncResult.initial(),
  ),
);
let registry: AtomRegistry.AtomRegistry;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.patchAvailable = true;
  state.scroll.mockClear();
  state.requestPatch.mockClear();
  useDiffPanelStore.setState({ byThreadKey: {}, branchBaseRefByThreadKey: {} });
  registry = AtomRegistry.make();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  registry.dispose();
  vi.unstubAllGlobals();
});
function loadedPatch(path: string): ReviewDiffPreviewSource {
  return {
    ...source,
    diff: filePatch(path),
    files: source.files?.filter((file) => file.path === path) ?? [],
    truncated: false,
  };
}
function completePatch(path: string) {
  registry.set(patchAtoms(path), AsyncResult.success(loadedPatch(path)));
}
async function render() {
  await act(async () =>
    root.render(
      <RegistryContext.Provider value={registry}>
        <DiffPanel composerDraftTarget={threadRef} workspaceMutationId={null} />
      </RegistryContext.Provider>,
    ),
  );
}
async function click(label: string) {
  const button = [...container.querySelectorAll("button")].find(
    (button) => button.getAttribute("aria-label") === label || button.textContent === label,
  );
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
}
function expectExpanded(expected: string[]) {
  expect(container.querySelectorAll("section").length).toBeGreaterThan(0);
  expect([...container.querySelectorAll("section pre")].map((pre) => pre.textContent)).toEqual(
    expected.map((path) => `${path} changes`),
  );
}
function expectScrolled(path: string) {
  expect(state.scroll).toHaveBeenLastCalledWith(
    { type: "item", id: expect.any(String), align: "start" },
    false,
  );
  const target = state.scroll.mock.lastCall?.[0];
  expect(target?.type === "item" && target.id).toContain(path);
}

it("reveals selected turn files after the patch arrives, preserving siblings and new-diff defaults", async () => {
  state.patchAvailable = false;
  useDiffPanelStore.getState().selectTurn(threadRef, turns[0]!.runId, "b.ts");
  await render();
  expect(state.scroll).not.toHaveBeenCalled();
  state.patchAvailable = true;
  await render();
  expectExpanded(["b.ts"]);
  expectScrolled("b.ts");
  await click("Expand a.ts");
  await act(async () =>
    useDiffPanelStore.getState().selectTurn(threadRef, turns[0]!.runId, "e.ts"),
  );
  expectExpanded(["a.ts", "b.ts", "e.ts"]);
  expectScrolled("e.ts");
  await click("Collapse b.ts");
  state.scroll.mockClear();
  await act(async () =>
    useDiffPanelStore.getState().selectTurn(threadRef, turns[0]!.runId, "e.ts"),
  );
  expectExpanded(["a.ts", "e.ts"]);
  expectScrolled("e.ts");
  expect(state.scroll).toHaveBeenCalledTimes(1);
  state.scroll.mockClear();
  await act(async () => useDiffPanelStore.getState().selectTurn(threadRef, turns[1]!.runId));
  expectExpanded([]);
  expect(state.scroll).not.toHaveBeenCalled();
  expect(state.requestPatch).not.toHaveBeenCalled();
});

it("loads and reveals a lazy file without changing siblings or the next diff's collapsed default", async () => {
  await render();
  expectExpanded([]);
  expect(state.requestPatch).not.toHaveBeenCalledWith("e.ts");
  await click("Expand a.ts");
  await click("Reveal b.ts");
  expectExpanded(["a.ts", "b.ts"]);
  expectScrolled("b.ts");
  await click("Collapse b.ts");
  state.scroll.mockClear();
  await click("Reveal e.ts");
  expect(state.requestPatch).toHaveBeenCalledWith("e.ts");
  expect(state.scroll).not.toHaveBeenCalled();
  await act(async () => completePatch("e.ts"));
  expectExpanded(["a.ts", "e.ts"]);
  expectScrolled("e.ts");
  await act(async () => useDiffPanelStore.getState().selectGitScope(threadRef, "unstaged"));
  expectExpanded([]);
});
