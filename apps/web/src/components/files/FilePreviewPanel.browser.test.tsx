import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { EnvironmentId, ThreadId, type ProjectReadFileResult } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { StrictMode, type ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { cdp, userEvent } from "vite-plus/test/browser";
import { act, fakeTimers, render } from "../../../test/render";
import appCss from "~/index.css?inline";
import { isMacPlatform } from "~/lib/utils";
import {
  createWorkspaceFocusController,
  startWorkspaceFocus,
  workspaceAreaProps,
} from "~/lib/workspaceFocus";

const state = vi.hoisted(() => ({
  file: null as ProjectReadFileResult | null,
  optimistic: null as ProjectReadFileResult | null,
  writeFile: vi.fn(),
  assetUrl: { _tag: "Loading" } as import("~/assets/assetUrls").AssetUrlState,
  assetUrlForRevision: null as
    | ((revision: string | null | undefined) => import("~/assets/assetUrls").AssetUrlState)
    | null,
  assetResources: [] as Array<import("@t3tools/contracts").AssetResource>,
  mintUrl: vi.fn<() => Promise<string | null>>(),
  browserAssetMints: 0,
  openedBrowserUrls: [] as string[],
  diffWorkersReady: true,
}));

vi.mock(import("@t3tools/client-runtime/state/runtime"), async (original) => ({
  ...(await original()),
  runAtomCommand: ((_registry: unknown, _command: unknown, request: unknown) =>
    state.writeFile(request)) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => true,
}));
vi.mock(import("~/state/filesystem"), async (original) => ({
  ...(await original()),
  useFilesystemReadAccess: () => ({ canReadFiles: true, isPending: false, error: null }),
}));
vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.writeFile) as never,
}));
vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("~/remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenState: () => ({ mode: "local-exec" }) as never,
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
vi.mock(import("~/hooks/useTheme"), async (original) => ({
  ...(await original()),
  useTheme: () => ({ resolvedTheme: "dark" }) as never,
  useRenderedAppearance: () => "dark",
}));
vi.mock(import("~/hooks/useWorkspaceMutationRefresh"), () => ({
  useWorkspaceMutationRefresh: vi.fn(),
}));
vi.mock(import("~/assets/assetUrls"), async (original) => ({
  ...(await original()),
  useAssetUrlRefresh: () => state.mintUrl,
  useAssetUrlState: (
    _environmentId: unknown,
    resource: import("@t3tools/contracts").AssetResource | null,
    revision?: string | null,
  ) => {
    if (resource) state.assetResources.push(resource);
    return state.assetUrlForRevision ? state.assetUrlForRevision(revision) : state.assetUrl;
  },
}));
vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  usePreviewAvailable: () => true,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentHttpBaseUrl: () => "http://environment.test",
}));
vi.mock(import("~/state/assets"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const Effect = await import("effect/Effect");
  // Like the real query family, a minted URL stays cached until the atom is refreshed.
  const createUrl = Atom.family((_key: string) =>
    Atom.make(
      Effect.sync(() => ({
        relativeUrl: `/api/assets/mint-${++state.browserAssetMints}/page.html`,
        expiresAt: Number.MAX_SAFE_INTEGER,
      })),
    ).pipe(Atom.keepAlive),
  );
  return {
    ...actual,
    assetEnvironment: {
      ...actual.assetEnvironment,
      createUrl: ((target: { input: { resource: { path: string } } }) =>
        createUrl(target.input.resource.path)) as never,
    },
  };
});
vi.mock(import("~/browser/openFileInPreview"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    openFileInPreview: (async (input: Parameters<typeof actual.openFileInPreview>[0]) => {
      const result = await input.createAssetUrl({
        environmentId: input.threadRef.environmentId,
        input: {
          resource: {
            _tag: "workspace-file",
            threadId: input.threadRef.threadId,
            path: input.filePath,
          },
        },
      });
      if (result._tag === "Success") state.openedBrowserUrls.push(result.value.relativeUrl);
      return AsyncResult.success(undefined);
    }) as never,
  };
});
// The Word engine compiles a large WebAssembly bundle; these tests only need the URL it loads.
vi.mock(import("./OfficeFilePreview"), () => ({
  OfficeFilePreview: ({ src }: { src: string }) => <div data-testid="office-preview">{src}</div>,
}));
vi.mock(import("./FileBreadcrumbs"), () => ({ FileBreadcrumbs: () => <></> }));
vi.mock(import("./FileBrowserPanel"), () => ({
  default: ({ onRefreshSelectedFile }: { onRefreshSelectedFile?: () => void }) => (
    <div role="tree">
      {onRefreshSelectedFile ? (
        <button type="button" onClick={onRefreshSelectedFile}>
          Refresh workspace files
        </button>
      ) : null}
      <button type="button" role="treeitem" data-item-path="src/">
        src
      </button>
      <button type="button" role="treeitem" data-item-path="server.ts">
        server.ts
      </button>
    </div>
  ),
}));
vi.mock(import("../DiffWorkerPoolProvider"), () => ({
  // Like the real provider, a pool that is still starting unmounts the viewer it wraps.
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => (
    <>{state.diffWorkersReady ? children : null}</>
  ),
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: () => ({
    data: state.file,
    error: null,
    isPending: false,
    readError: null,
    isNotFile: false,
    isFile: true,
    refresh: vi.fn(),
  }),
  getOptimisticProjectFileQueryData: () => state.optimistic,
  getUnsavedProjectFileQueryData: () => null,
  setProjectFileQueryData: (
    _environmentId: EnvironmentId,
    _cwd: string,
    relativePath: string,
    contents: string,
  ) => {
    state.optimistic = { relativePath, contents, truncated: false, byteLength: contents.length };
  },
  confirmProjectFileQueryData: () => true,
}));

import FilePreviewPanel from "./FilePreviewPanel";
import NotebookPreview from "./NotebookPreview";
import { PREVIEW_PAGE_ROWS } from "./largeTextProtocol";
import { PreviewPositionKey } from "./previewPosition";
import VirtualTablePreview from "./VirtualTablePreview";
import { ChunkedMarkdown } from "./ChunkedMarkdown";
import { splitMarkdown } from "@t3tools/shared/markdownChunks";

const environmentId = EnvironmentId.make("markdown-preview-test");
const threadRef = { environmentId, threadId: ThreadId.make("thread") };
function setup() {
  const keys = ["t3code.fileExplorerOpen", "t3code.renderMarkdown"];
  const previous = keys.map((key) => localStorage.getItem(key));
  localStorage.setItem(keys[0]!, "false");
  localStorage.setItem(keys[1]!, "true");
  state.file = null;
  state.optimistic = null;
  state.assetUrl = { _tag: "Loading" };
  state.assetUrlForRevision = null;
  state.assetResources = [];
  state.openedBrowserUrls = [];
  state.diffWorkersReady = true;
  let mints = 0;
  state.mintUrl.mockReset().mockImplementation(async () => `/assets/report.docx?mint=${++mints}`);
  state.writeFile.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  return {
    [Symbol.dispose]() {
      for (const [index, key] of keys.entries()) {
        const value = previous[index];
        if (value == null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
      }
    },
  };
}

function markdownPreview(
  truncated: boolean,
  contents = "- [ ] Keep the rest of this file\n",
  relativePath = "tasks.md",
) {
  state.file = {
    relativePath,
    contents,
    byteLength: truncated ? 1_200_000 : contents.length,
    truncated,
  };
  return filePreview(relativePath);
}

function filePreview(
  relativePath: string,
  workspaceMutationId: string | null = null,
  reveal: { line: number; requestId: number } | null = null,
  thread = threadRef,
) {
  return (
    <FilePreviewPanel
      environmentId={environmentId}
      cwd="/workspace"
      projectName="Project"
      relativePath={relativePath}
      threadRef={thread}
      composerDraftTarget={thread}
      keybindings={[]}
      availableEditors={[]}
      openInShortcutEnabled={false}
      revealLine={reveal?.line ?? null}
      revealRequestId={reveal?.requestId ?? 0}
      onOpenFile={vi.fn()}
      onNavigateFolder={vi.fn()}
      folderTrail={undefined}
      onPendingChange={vi.fn()}
      selectedFilePending={false}
      workspaceMutationId={workspaceMutationId}
    />
  );
}

function documentPreview(workspaceMutationId: string, fileRevision: string) {
  state.file = null;
  state.assetUrl = {
    _tag: "Success",
    url: "/assets/report.docx",
    expiresAt: Number.MAX_SAFE_INTEGER,
    fileRevision,
  };
  return filePreview("report.docx", workspaceMutationId);
}

function deepActiveElement() {
  let active = document.activeElement;
  while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
  return active;
}

describe("source file focus", () => {
  it("hands panel focus to the file's editor, which owns mod+f", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const panel = () => (
      <div {...workspaceAreaProps("panel", 1, "Workspace panel")}>
        <div data-right-panel-surface-content>{filePreview("server.ts")}</div>
      </div>
    );
    const editorHasFocus = () => expect(deepActiveElement()?.matches("[data-content]")).toBe(true);

    await using screen = await render(panel());
    const focus = createWorkspaceFocusController(document);
    using _focus = { [Symbol.dispose]: focus.dispose };
    expect(focus.focus("panel")).toBe(true);
    state.file = {
      relativePath: "server.ts",
      contents: "const server = 1;\n",
      byteLength: 18,
      truncated: false,
    };
    await screen.rerender(panel());
    await vi.waitFor(editorHasFocus);
    await userEvent.keyboard("x");
    await vi.waitFor(() => expect(deepActiveElement()?.textContent).toContain("xconst server"));

    (deepActiveElement() as HTMLElement).blur();
    expect(focus.focus("panel", false)).toBe(true);
    await vi.waitFor(editorHasFocus);
    await userEvent.keyboard(
      isMacPlatform(navigator.platform) ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}",
    );
    await vi.waitFor(() => expect(deepActiveElement()).toBeInstanceOf(HTMLInputElement));

    const findField = deepActiveElement() as HTMLInputElement;
    await userEvent.keyboard("server");
    findField.blur();
    expect(focus.focus("panel", false)).toBe(true);
    await vi.waitFor(editorHasFocus);
    const editor = deepActiveElement() as HTMLElement;
    await userEvent.keyboard("ab");
    await vi.waitFor(() => expect(editor.textContent).toContain("xabconst server"));
    expect(findField.value).toBe("server");
    editorHasFocus();
  });

  it("focuses the editor when a file row is clicked or activated with Enter", async () => {
    using _settings = setup();
    localStorage.setItem("t3code.fileExplorerOpen", "true");
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    state.file = {
      relativePath: "server.ts",
      contents: "const server = 1;\n",
      byteLength: 18,
      truncated: false,
    };
    await using screen = await render(
      <div {...workspaceAreaProps("panel", 1, "Workspace panel")} style={{ width: 900 }}>
        <div data-right-panel-surface-content>{filePreview("server.ts")}</div>
      </div>,
    );
    using _focus = {
      [Symbol.dispose]: startWorkspaceFocus({ subscribe: () => () => {} } as never),
    };
    const editorHasFocus = () => expect(deepActiveElement()?.matches("[data-content]")).toBe(true);
    // The explorer measures its parent row; a wrapper without a box would cap it at the minimum.
    await expect
      .element(screen.getByRole("separator", { name: "Resize file explorer" }))
      .toHaveAttribute("aria-valuemax", "560");
    const folderRow = screen.getByRole("treeitem", { name: "src" });
    const fileRow = screen.getByRole("treeitem", { name: "server.ts" });

    (folderRow.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    expect(document.activeElement).toBe(folderRow.element());

    await userEvent.click(fileRow);
    await vi.waitFor(editorHasFocus);

    (fileRow.element() as HTMLElement).focus();
    await userEvent.keyboard("{Enter}");
    await vi.waitFor(editorHasFocus);
  });
});

describe("source file scroll", () => {
  it("returns a file tab to where it was scrolled after another file was shown", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const sourceFile = (relativePath: string, lines: number) => {
      const contents = Array.from({ length: lines }, (_, i) => `const line${i} = ${i};`).join("\n");
      state.file = { relativePath, contents, byteLength: contents.length, truncated: false };
      // The app mounts under StrictMode, whose remount must not wipe the saved offset.
      return (
        <StrictMode>
          <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
            {filePreview(relativePath)}
          </div>
        </StrictMode>
      );
    };
    const scroller = () => document.querySelector<HTMLElement>(".file-preview-virtualizer");

    await using screen = await render(sourceFile("a.ts", 2000));
    await vi.waitFor(() => expect(scroller()?.scrollHeight).toBeGreaterThan(5000));
    scroller()!.scrollTop = 4200;
    await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(4200));

    await screen.rerender(sourceFile("b.ts", 1500));
    await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(0));
    await screen.rerender(sourceFile("a.ts", 2000));

    await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(4200));
  });

  it("returns a file to where it was scrolled in each thread after the panel remounts", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const contents = Array.from({ length: 2000 }, (_, i) => `const line${i} = ${i};`).join("\n");
    state.file = { relativePath: "a.ts", contents, byteLength: contents.length, truncated: false };
    const otherThread = { environmentId, threadId: ThreadId.make("other-thread") };
    const panel = (thread: typeof threadRef) => (
      <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
        {filePreview("a.ts", null, null, thread)}
      </div>
    );
    const scroller = () => document.querySelector<HTMLElement>(".file-preview-virtualizer");
    const scrollTo = async (top: number) => {
      await vi.waitFor(() => expect(scroller()?.scrollHeight).toBeGreaterThan(5000));
      scroller()!.scrollTop = top;
      await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(top));
    };

    for (const [thread, top] of [
      [threadRef, 4200],
      [otherThread, 1000],
    ] as const) {
      await using _screen = await render(panel(thread));
      await scrollTo(top);
    }
    for (const [thread, top] of [
      [threadRef, 4200],
      [otherThread, 1000],
    ] as const) {
      await using _screen = await render(panel(thread));
      await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(top));
    }
  });

  it.each([
    ["an editable file", "a.ts"],
    ["a read-only host file", "/outside/a.ts"],
  ])(
    "keeps each thread's offset in %s when the panel stays mounted across threads",
    async (_, path) => {
      using _settings = setup();
      const style = document.createElement("style");
      style.textContent = appCss;
      document.head.append(style);
      using _style = { [Symbol.dispose]: () => style.remove() };
      await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
      const contents = Array.from({ length: 2000 }, (_, i) => `const line${i} = ${i};`).join("\n");
      state.file = { relativePath: path, contents, byteLength: contents.length, truncated: false };
      const first = { environmentId, threadId: ThreadId.make(`mounted-first:${path}`) };
      const second = { environmentId, threadId: ThreadId.make(`mounted-second:${path}`) };
      const panel = (thread: typeof threadRef) => (
        <div style={{ height: 400, display: "flex", flexDirection: "column" }}>
          {filePreview(path, null, null, thread)}
        </div>
      );
      const scroller = () => document.querySelector<HTMLElement>(".file-preview-virtualizer");
      const scrollTo = async (top: number) => {
        await vi.waitFor(() => expect(scroller()?.scrollHeight).toBeGreaterThan(5000));
        scroller()!.scrollTop = top;
        await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(top));
      };

      await using screen = await render(panel(first));
      await scrollTo(4200);
      await screen.rerender(panel(second));
      await scrollTo(1000);
      await screen.rerender(panel(first));
      await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(4200));
      await screen.rerender(panel(second));
      await vi.waitFor(() => expect(scroller()?.scrollTop).toBe(1000));
    },
  );

  it("centers a linked line in a scrolled read-only file, and again when the viewer is rebuilt", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["text"] });
    // Wrapped lines of differing lengths, so the viewer estimates heights until it measures them.
    const contents = Array.from(
      { length: 140 },
      (_, i) =>
        `Line ${i + 1}. ${"Notes that wrap across the preview. ".repeat(2 + ((i * 7) % 9))}`,
    ).join("\n");
    // A file outside the workspace is read-only, which CodeView renders.
    const hostFile = (reveal: { line: number; requestId: number } | null) => {
      const relativePath = "/outside/notes.txt";
      state.file = { relativePath, contents, byteLength: contents.length, truncated: false };
      return (
        <div style={{ height: 400, width: 500, display: "flex", flexDirection: "column" }}>
          {filePreview(relativePath, null, reveal)}
        </div>
      );
    };
    const scroller = () => document.querySelector<HTMLElement>(".file-preview-virtualizer");
    const row = (line: number) =>
      document.querySelector("diffs-container")?.shadowRoot?.querySelector(`[data-line="${line}"]`);
    const middle = (element: Element | null | undefined) => {
      const rect = element?.getBoundingClientRect();
      return rect ? (rect.top + rect.bottom) / 2 : Number.NaN;
    };
    const lineIsCentered = () =>
      expect(Math.abs(middle(row(82)) - middle(scroller()))).toBeLessThan(2);

    await using screen = await render(hostFile(null));
    await vi.waitFor(() => expect(scroller()?.scrollHeight).toBeGreaterThan(3000));
    scroller()!.scrollTop = 2500;
    // The viewer has moved its window of mounted rows to the new offset.
    await vi.waitFor(() => expect(row(1)).toBeNull());

    await screen.rerender(hostFile({ line: 82, requestId: 1 }));
    await vi.waitFor(lineIsCentered);

    // Starting the worker pool unmounts the viewer and mounts a new one.
    state.diffWorkersReady = false;
    await screen.rerender(hostFile({ line: 82, requestId: 1 }));
    await vi.waitFor(() => expect(scroller()).toBeNull());
    state.diffWorkersReady = true;
    await screen.rerender(hostFile({ line: 82, requestId: 1 }));
    await vi.waitFor(lineIsCentered);
  });

  it.each([
    {
      label: "keeps a downward drag whose anchor stays mounted across a window shift",
      startLine: 65,
      initialScrollLine: 65,
      direction: "down" as const,
      targetFirstMounted: 101,
      expectedIncludedLine: 121,
    },
    {
      label: "keeps a downward drag whose anchor unmounts on a window shift",
      startLine: 5,
      initialScrollLine: null,
      direction: "down" as const,
      targetFirstMounted: 101,
      expectedIncludedLine: 121,
    },
    {
      label: "keeps an upward drag whose anchor unmounts on a window shift",
      startLine: 385,
      initialScrollLine: 385,
      direction: "up" as const,
      targetFirstMounted: 201,
      expectedIncludedLine: 290,
    },
  ])(
    "$label",
    async ({
      label,
      startLine,
      initialScrollLine,
      direction,
      targetFirstMounted,
      expectedIncludedLine,
    }) => {
      using _settings = setup();
      localStorage.setItem("t3code.renderMarkdown", "false");
      const style = document.createElement("style");
      style.textContent = appCss;
      document.head.append(style);
      using _style = { [Symbol.dispose]: () => style.remove() };
      await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["markdown"] });

      const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1} markdown content`);
      const contents = `${lines.join("\n")}\n`;
      state.file = {
        relativePath: "notes.md",
        contents,
        byteLength: contents.length,
        truncated: false,
      };

      await using screen = await render(
        <div style={{ width: 560, height: 400, display: "flex", flexDirection: "column" }}>
          {/* Each case gets its own thread so it does not resume the previous case's scroll. */}
          {filePreview("notes.md", null, null, { environmentId, threadId: ThreadId.make(label) })}
        </div>,
      );

      const shadowRoot = () => screen.container.querySelector("diffs-container")?.shadowRoot;
      const rows = () => shadowRoot()?.querySelectorAll<HTMLElement>("[data-line]") ?? [];
      await vi.waitFor(() =>
        expect(
          shadowRoot()?.querySelector('[data-content][contenteditable="true"]'),
        ).not.toBeNull(),
      );

      const scroller = screen.container.querySelector<HTMLElement>(".file-preview-virtualizer")!;
      if (initialScrollLine !== null) {
        if (direction === "up") {
          await vi.waitFor(() => expect(scroller.scrollHeight).toBeGreaterThan(5000));
          scroller.scrollTop = scroller.scrollHeight;
          await vi.waitFor(() =>
            expect(
              [...rows()].some((row) => row.getAttribute("data-line") === String(startLine)),
            ).toBe(true),
          );
        }
        const target = [...rows()].find(
          (row) => row.getAttribute("data-line") === String(initialScrollLine),
        );
        expect(target).toBeDefined();
        target!.scrollIntoView({ block: direction === "up" ? "end" : "start" });
        await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
      }

      const startRow = [...rows()].find(
        (row) => row.getAttribute("data-line") === String(startLine),
      );
      expect(startRow).toBeDefined();
      const startRect = startRow!.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      const nearEdgeY = direction === "down" ? scrollerRect.bottom - 5 : scrollerRect.top + 5;
      const outsideEdgeY = direction === "down" ? scrollerRect.bottom + 60 : scrollerRect.top - 60;
      const frame = window.frameElement?.getBoundingClientRect();
      const mouse = (type: "mousePressed" | "mouseMoved" | "mouseReleased", x: number, y: number) =>
        cdp().send("Input.dispatchMouseEvent", {
          type,
          x: x + (frame?.left ?? 0),
          y: y + (frame?.top ?? 0),
          button: "left",
          buttons: type === "mouseReleased" ? 0 : 1,
          clickCount: 1,
        });

      const startX = direction === "up" ? startRect.left + 140 : startRect.left + 2;
      // The editor records the drag anchor on the press's selectionchange; drag only after it.
      const anchored = new Promise((resolve) =>
        document.addEventListener("selectionchange", resolve, { once: true }),
      );
      await mouse("mousePressed", startX, startRect.top + 5);
      await anchored;
      await mouse("mouseMoved", startRect.left + 80, nearEdgeY);
      await mouse("mouseMoved", startRect.left + 80, outsideEdgeY);
      await vi.waitFor(() => {
        const firstMounted = Number(rows()[0]?.getAttribute("data-line"));
        if (direction === "down") {
          expect(firstMounted).toBeGreaterThanOrEqual(targetFirstMounted);
        } else {
          expect(firstMounted).toBeLessThanOrEqual(targetFirstMounted);
        }
      });
      await mouse("mouseReleased", startRect.left + 80, outsideEdgeY);

      const overlayRanges = shadowRoot()!.querySelectorAll("[data-selection-range]");
      expect(overlayRanges.length).toBeGreaterThan(0);

      const clipboardData = new DataTransfer();
      const contentEl = shadowRoot()!.querySelector("[data-content]")!;
      const handled = !contentEl.dispatchEvent(
        new ClipboardEvent("copy", {
          clipboardData,
          bubbles: true,
          cancelable: true,
          composed: true,
        }),
      );
      expect(handled).toBe(true);
      const copied = clipboardData.getData("text/plain");
      expect(copied).toContain(`line ${startLine} `);
      expect(copied).toContain(`line ${expectedIncludedLine} markdown content`);
    },
  );

  it("scrolls a find match below many wrapped lines into view", async () => {
    using _settings = setup();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    using _style = { [Symbol.dispose]: () => style.remove() };
    await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
    const wrapped = "wrap ".repeat(60);
    const lines = Array.from({ length: 800 }, (_, i) => `const line${i} = "${wrapped}";`);
    lines.push(
      "const needle = 1;",
      ...Array.from({ length: 40 }, (_, i) => `const tail${i} = ${i};`),
    );
    const contents = lines.join("\n");
    state.file = {
      relativePath: "wrapped.ts",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    const scroller = () => document.querySelector<HTMLElement>(".file-preview-virtualizer");

    await using _screen = await render(
      <div style={{ width: 500, height: 400, display: "flex", flexDirection: "column" }}>
        {filePreview("wrapped.ts")}
      </div>,
    );
    await vi.waitFor(() => expect(scroller()?.scrollHeight).toBeGreaterThan(20_000));
    const shadowRows = () =>
      [...document.querySelectorAll("*")].flatMap((host) =>
        host.shadowRoot ? [...host.shadowRoot.querySelectorAll<HTMLElement>("[data-line]")] : [],
      );
    await userEvent.click(shadowRows().find((row) => row.getAttribute("data-line") === "1")!);
    await vi.waitFor(() => expect(deepActiveElement()?.matches("[data-content]")).toBe(true));
    await userEvent.keyboard(
      isMacPlatform(navigator.platform) ? "{Meta>}f{/Meta}" : "{Control>}f{/Control}",
    );
    await vi.waitFor(() => expect(deepActiveElement()).toBeInstanceOf(HTMLInputElement));
    await userEvent.keyboard("needle{Enter}");

    const visibleLines = () => {
      const viewport = scroller()!.getBoundingClientRect();
      return shadowRows()
        .filter((row) => {
          const box = row.getBoundingClientRect();
          return box.height > 0 && box.top >= viewport.top && box.bottom <= viewport.bottom;
        })
        .map((row) => Number(row.getAttribute("data-line")));
    };
    await vi.waitFor(() => expect(visibleLines()).toContain(801));
  });
});

describe("rendered Markdown task saves", () => {
  it("renders the whole file of a truncated read, read-only", async () => {
    using _settings = setup();
    state.assetUrl = {
      _tag: "Success",
      url: "/assets/tasks.md",
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    const realFetch = globalThis.fetch;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) =>
        new URL(String(input), location.href).pathname === "/assets/tasks.md"
          ? Promise.resolve(
              new Response("- [ ] Keep the rest of this file\n\nPast the first megabyte\n"),
            )
          : realFetch(input, init),
      );
    await using screen = await render(markdownPreview(true));
    await expect.element(screen.getByText("Past the first megabyte")).toBeVisible();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox.disabled).toBe(true);
    await act(async () => checkbox.click());
    expect(state.optimistic).toBeNull();
    expect(state.writeFile).not.toHaveBeenCalled();
  });

  it("still toggles and saves tasks from a complete read", async () => {
    using _settings = setup();
    await using screen = await render(markdownPreview(false));
    // The virtualized list mounts its pieces after measuring the viewport.
    await expect.element(screen.getByRole("checkbox")).toBeInTheDocument();
    using _timers = fakeTimers();
    const checkbox = screen.container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(checkbox).not.toBeNull();
    expect(checkbox.disabled).toBe(false);
    await act(async () => checkbox.click());
    await vi.advanceTimersByTimeAsync(500);
    expect(state.writeFile).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: {
        cwd: "/workspace",
        relativePath: "tasks.md",
        contents: "- [x] Keep the rest of this file\n",
      },
    });
  });
});

describe("workspace document previews", () => {
  it("keeps an unchanged document loaded when another workspace change lands", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");
    const loaded = preview.element();

    await screen.rerender(documentPreview("mutation-2", "revision-1"));

    expect(state.mintUrl, "an unchanged document re-minted its URL").toHaveBeenCalledOnce();
    expect(screen.container.contains(loaded), "an unchanged document was remounted").toBe(true);
  });

  it("keeps an unchanged document mounted while its revision check reloads", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");
    const loaded = preview.element();

    state.assetUrl = { _tag: "Loading" };
    await screen.rerender(filePreview("report.docx", "mutation-1"));
    await screen.rerender(documentPreview("mutation-1", "revision-1"));

    expect(
      state.mintUrl,
      "a reloading revision check re-minted the document URL",
    ).toHaveBeenCalledOnce();
    expect(
      screen.container.contains(loaded),
      "a reloading revision check remounted the document",
    ).toBe(true);
  });

  it("reloads the document when its URL can no longer be minted", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");

    state.assetUrl = { _tag: "Failure" };
    await screen.rerender(filePreview("report.docx", "mutation-2"));

    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=2");
  });

  it("loads the new bytes when the document itself changes", async () => {
    using _settings = setup();
    await using screen = await render(documentPreview("mutation-1", "revision-1"));
    const preview = screen.getByTestId("office-preview");
    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=1");

    await screen.rerender(documentPreview("mutation-2", "revision-2"));

    await expect.element(preview).toHaveTextContent("/assets/report.docx?mint=2");
  });
});

describe("open file in preview browser", () => {
  it("mints a fresh asset URL on every click so the browser cannot reuse cached bytes", async () => {
    using _settings = setup();
    state.file = {
      relativePath: "page.html",
      contents: "<h1>page</h1>",
      byteLength: 13,
      truncated: false,
    };
    await using screen = await render(filePreview("page.html"));
    const button = screen.getByRole("button", { name: "Open file in preview browser" });

    await userEvent.click(button);
    await vi.waitFor(() => expect(state.openedBrowserUrls).toHaveLength(1));
    await userEvent.click(button);
    await vi.waitFor(() => expect(state.openedBrowserUrls).toHaveLength(2));

    expect(state.openedBrowserUrls[1], "the second click reused the first signed URL").not.toBe(
      state.openedBrowserUrls[0],
    );
  });
});

describe("workspace HTML preview refresh", () => {
  it.each([
    {
      label: "reloads a rendered HTML preview on refresh when fileRevision advances",
      workspaceMutationId: null as string | null,
      withFileRevision: true,
    },
    {
      label: "reloads a rendered HTML preview on refresh without a server fileRevision",
      workspaceMutationId: "mutation-1" as string | null,
      withFileRevision: false,
    },
  ])("$label", async ({ workspaceMutationId, withFileRevision }) => {
    using _settings = setup();
    localStorage.setItem("t3code.fileExplorerOpen", "true");
    state.file = {
      relativePath: "page.html",
      contents: "<h1>v1</h1>",
      byteLength: 11,
      truncated: false,
    };
    const seenRevisions: Array<string | null | undefined> = [];
    state.assetUrlForRevision = (revision) => {
      seenRevisions.push(revision);
      const refreshed = revision !== workspaceMutationId;
      return {
        _tag: "Success",
        url: refreshed ? "data:text/html,v2" : "data:text/html,v1",
        expiresAt: Number.MAX_SAFE_INTEGER,
        ...(withFileRevision ? { fileRevision: refreshed ? "rev-2" : "rev-1" } : {}),
      };
    };

    await using screen = await render(filePreview("page.html", workspaceMutationId));
    const shownIframeSrc = () =>
      screen.container.querySelector('iframe:not([aria-hidden="true"])')?.getAttribute("src");
    await vi.waitFor(() => expect(shownIframeSrc()).toMatch(/^data:text\/html,v1/));

    await userEvent.click(screen.getByRole("button", { name: "Refresh workspace files" }));

    await vi.waitFor(() => expect(shownIframeSrc()).toMatch(/^data:text\/html,v2/));
    expect(seenRevisions.at(-1)).not.toBe(workspaceMutationId);
  });
});

describe("workspace large file preview refresh", () => {
  it.each([
    {
      label: "reloads a large file preview on refresh when fileRevision advances",
      workspaceMutationId: null as string | null,
      withFileRevision: true,
      assetPath: "/assets/large-refresh-rev.md",
    },
    {
      label: "reloads a large file preview on refresh without a server fileRevision",
      workspaceMutationId: "mutation-1" as string | null,
      withFileRevision: false,
      assetPath: "/assets/large-refresh-legacy.md",
    },
  ])("$label", async ({ workspaceMutationId, withFileRevision, assetPath }) => {
    using _settings = setup();
    localStorage.setItem("t3code.fileExplorerOpen", "true");
    state.file = {
      relativePath: "large.md",
      contents: "Initial preview.\n",
      byteLength: 1_200_000,
      truncated: true,
    };
    let waitingForRefresh = false;
    state.assetUrlForRevision = (revision) => {
      const refreshed = (revision ?? null) !== workspaceMutationId;
      if (refreshed && waitingForRefresh) {
        return {
          _tag: "Success",
          url: `${assetPath}?v=1`,
          expiresAt: Number.MAX_SAFE_INTEGER,
          waiting: true,
          ...(withFileRevision ? { fileRevision: "rev-1" } : {}),
        };
      }
      return {
        _tag: "Success",
        url: refreshed ? `${assetPath}?v=2` : `${assetPath}?v=1`,
        expiresAt: Number.MAX_SAFE_INTEGER,
        ...(withFileRevision ? { fileRevision: refreshed ? "rev-2" : "rev-1" } : {}),
      };
    };
    const realFetch = globalThis.fetch;
    using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(String(input), location.href);
      if (url.pathname !== assetPath) return realFetch(input, init);
      const version = url.searchParams.get("v");
      if (version === "1") return Promise.resolve(new Response("Initial large body.\n"));
      if (version === "2") return Promise.resolve(new Response("Updated large body.\n"));
      return Promise.resolve(new Response("", { status: 404 }));
    });

    await using screen = await render(filePreview("large.md", workspaceMutationId));
    await expect.element(screen.getByText("Initial large body.")).toBeVisible();

    waitingForRefresh = true;
    await userEvent.click(screen.getByRole("button", { name: "Refresh workspace files" }));
    waitingForRefresh = false;
    await screen.rerender(filePreview("large.md", workspaceMutationId));

    await expect.element(screen.getByText("Updated large body.")).toBeVisible();
  });
});

describe("save file", () => {
  it("offers one Save file, whether the toolbar or the preview provides it", async () => {
    using _settings = setup();
    state.file = { relativePath: "notes.txt", contents: "notes", byteLength: 5, truncated: false };
    await using screen = await render(filePreview("notes.txt"));
    await expect.element(screen.getByRole("button", { name: "Save file" })).toBeVisible();

    await screen.rerender(documentPreview("mutation-1", "revision-1"));
    await expect.element(screen.getByTestId("office-preview")).toBeVisible();
    expect(screen.getByRole("button", { name: "Save file" }).elements()).toHaveLength(1);
  });
});

describe("workspace image previews", () => {
  it("omits the word-wrap toggle on SVG image previews", async () => {
    using _settings = setup();
    const contents = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"></svg>';
    state.file = {
      relativePath: "icon.svg",
      contents,
      byteLength: contents.length,
      truncated: false,
    };
    state.assetUrl = {
      _tag: "Success",
      url: `data:image/svg+xml,${encodeURIComponent(contents)}`,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    await using screen = await render(filePreview("icon.svg"));
    await expect.element(screen.getByRole("img", { name: "icon.svg" })).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: /word wrap/i }))
      .not.toBeInTheDocument();
  });
});

describe("rendered Markdown select all", () => {
  it("selects only the rendered file, including after a task toggle", async () => {
    using _settings = setup();
    await using screen = await render(
      <>
        <p>Transcript text from the chat thread.</p>
        {markdownPreview(false, "- [ ] Task item\n\nRendered file body.\n")}
      </>,
    );
    const expectFileOnlySelection = async () => {
      await userEvent.keyboard(
        isMacPlatform(navigator.platform) ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}",
      );
      const selection = window.getSelection()?.toString() ?? "";
      expect(selection).toContain("Rendered file body.");
      expect(selection).not.toContain("Transcript text from the chat thread.");
    };

    await userEvent.click(screen.getByText("Rendered file body."));
    await expectFileOnlySelection();
    // A toggled checkbox keeps focus on an input inside the preview.
    await userEvent.click(screen.getByRole("checkbox"));
    await expectFileOnlySelection();
  });

  it("copies the whole chunked file with its own line endings", async () => {
    using _settings = setup();
    const contents = `first\r\r# ${"x\r\r# ".repeat(2_000)}end`;
    await using _screen = await render(
      <div style={{ height: 600, display: "flex", flexDirection: "column" }}>
        {markdownPreview(false, contents, "cr.md")}
      </div>,
    );
    const firstChunk = await vi.waitFor(() => {
      const first = document.querySelector("h1");
      expect(first).not.toBeNull();
      return first!;
    });
    await userEvent.click(firstChunk);
    await userEvent.keyboard(
      isMacPlatform(navigator.platform) ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}",
    );
    let copied: string | undefined;
    const read = (event: ClipboardEvent) => {
      copied = event.clipboardData?.getData("text/plain");
    };
    window.addEventListener("copy", read);
    using _listener = { [Symbol.dispose]: () => window.removeEventListener("copy", read) };
    document.execCommand("copy");
    expect(copied).toBe(contents);
  });

  it("selects and copies the whole file in a large rendered Markdown preview", async () => {
    using _settings = setup();
    using _style = withAppCss();
    const block = `## Section\n\n${"Paragraph body text. ".repeat(4)}\n\n`;
    const contents = `Loaded opening body.\n\n${block.repeat(400)}Trailing sentinel.`;
    state.assetUrl = {
      _tag: "Success",
      url: "/assets/large.md",
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    const realFetch = globalThis.fetch;
    using _fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) =>
        new URL(String(input), location.href).pathname === "/assets/large.md"
          ? Promise.resolve(new Response(contents))
          : realFetch(input, init),
      );
    await using screen = await render(
      <>
        <p>Transcript text from the chat thread.</p>
        {sized(markdownPreview(true, `Initial preview.\n\n${block.repeat(40)}`, "large.md"))}
      </>,
    );
    await expect.element(screen.getByText("Loaded opening body.")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Trailing sentinel.");

    await userEvent.click(screen.getByText("Loaded opening body."));
    await userEvent.keyboard(
      isMacPlatform(navigator.platform) ? "{Meta>}a{/Meta}" : "{Control>}a{/Control}",
    );
    const selection = window.getSelection()?.toString() ?? "";
    expect(selection).toContain("Loaded opening body.");
    expect(selection).not.toContain("Transcript text from the chat thread.");

    let copied: string | undefined;
    const read = (event: ClipboardEvent) => {
      copied = event.clipboardData?.getData("text/plain");
    };
    window.addEventListener("copy", read);
    using _listener = { [Symbol.dispose]: () => window.removeEventListener("copy", read) };
    document.execCommand("copy");
    expect(copied).toBe(contents);
  });
});

describe("rendered Markdown relative images", () => {
  it.each([
    ["2026-11-23T14:05/README.md", "/workspace/2026-11-23T14:05/diagram.png"],
    ["/README.md", "/diagram.png"],
  ])("resolves relative images in %s against its folder", async (relativePath, expectedPath) => {
    using _settings = setup();
    await using _screen = await render(
      markdownPreview(false, "![diagram](diagram.png)\n", relativePath),
    );
    await vi.waitFor(() => expect(state.assetResources).not.toHaveLength(0));
    expect(state.assetResources).toContainEqual(
      expect.objectContaining({ _tag: "media-file", path: expectedPath }),
    );
  });
});

describe("rendered Markdown image refresh", () => {
  it("re-mints embedded workspace images when workspace files refresh", async () => {
    using _settings = setup();
    localStorage.setItem("t3code.fileExplorerOpen", "true");
    const seenRevisions: Array<string | null | undefined> = [];
    state.assetUrlForRevision = (revision) => {
      seenRevisions.push(revision);
      return {
        _tag: "Success",
        url: `data:image/png;base64,${typeof revision === "string" ? "djI=" : "djE="}`,
        expiresAt: Number.MAX_SAFE_INTEGER,
      };
    };
    await using screen = await render(markdownPreview(false, "![diagram](diagram.png)\n"));
    await vi.waitFor(() => expect(seenRevisions).not.toHaveLength(0));
    const loaded = seenRevisions.at(-1);

    await userEvent.click(screen.getByRole("button", { name: "Refresh workspace files" }));

    await vi.waitFor(() => {
      expect(seenRevisions.at(-1)).toEqual(expect.any(String));
      expect(seenRevisions.at(-1)).not.toBe(loaded);
    });
  });
});

function withAppCss() {
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  return { [Symbol.dispose]: () => style.remove() };
}

function sized(children: ReactNode) {
  return (
    <div style={{ width: 500, height: 400, display: "flex", flexDirection: "column" }}>
      {children}
    </div>
  );
}

describe("rendered Markdown scroll position", () => {
  const sections = Array.from(
    { length: 200 },
    (_, index) => `## Section ${index}\n\nParagraph ${index}.\n`,
  ).join("\n");
  const scroller = () =>
    document.querySelector<HTMLElement>(".scrollbar-gutter-both") ?? expect.unreachable();
  /** The first heading in view and its offset from the top of the viewport. */
  const readingPosition = () => {
    const top = scroller().getBoundingClientRect().top;
    for (const heading of scroller().querySelectorAll("h2")) {
      const offset = Math.round(heading.getBoundingClientRect().top - top);
      if (offset > -100) return { heading: heading.textContent, offset };
    }
    return null;
  };
  const scrollDown = async () => {
    scroller().scrollTop = 3000;
    scroller().dispatchEvent(new Event("scroll"));
    await vi.waitFor(() => expect(readingPosition()?.heading).not.toBe("Section 0"));
    return readingPosition();
  };
  const expectReadingPosition = (saved: ReturnType<typeof readingPosition>) =>
    vi.waitFor(() => {
      const position = readingPosition();
      expect(position?.heading).toBe(saved?.heading);
      expect(Math.abs((position?.offset ?? 0) - (saved?.offset ?? 0))).toBeLessThanOrEqual(2);
    });

  it("restores each file's reading position after the preview remounts", async () => {
    using _settings = setup();
    using _style = withAppCss();
    const preview = (relativePath: string) => sized(markdownPreview(false, sections, relativePath));

    let saved: ReturnType<typeof readingPosition>;
    {
      await using screen = await render(preview("long.md"));
      await expect.element(screen.getByText("Section 0", { exact: true })).toBeInTheDocument();
      saved = await scrollDown();
    }
    {
      await using screen = await render(preview("other.md"));
      await expect.element(screen.getByText("Section 0", { exact: true })).toBeInTheDocument();
      expect(scroller().scrollTop, "another file opens at the top").toBe(0);
    }
    await using _screen = await render(preview("long.md"));
    await expectReadingPosition(saved);
  });

  it("waits for the saved chunk when a reopened file is still streaming in", async () => {
    using _settings = setup();
    using _style = withAppCss();
    const { chunks, definitions } = splitMarkdown(sections, 200);
    const preview = (loaded: number, loading: boolean) =>
      sized(
        <ChunkedMarkdown
          chunks={chunks.slice(0, loaded)}
          definitions={definitions}
          loading={loading}
          cwd="/workspace"
          relativePath="streaming.md"
          threadRef={threadRef}
          workspaceMutationId={null}
        />,
      );

    let saved: ReturnType<typeof readingPosition>;
    {
      await using screen = await render(preview(chunks.length, false));
      await expect.element(screen.getByText("Section 0", { exact: true })).toBeInTheDocument();
      saved = await scrollDown();
    }
    await using screen = await render(preview(3, true));
    expect(document.querySelector(".scrollbar-gutter-both"), "no list before the chunk").toBeNull();
    await screen.rerender(preview(chunks.length, false));
    await expectReadingPosition(saved);
  });

  it("keeps each thread's position when the same file stays open across threads", async () => {
    using _settings = setup();
    using _style = withAppCss();
    const { chunks, definitions } = splitMarkdown(sections, 200);
    const preview = (threadId: string) =>
      sized(
        <ChunkedMarkdown
          chunks={chunks}
          definitions={definitions}
          cwd="/workspace"
          relativePath="shared.md"
          threadRef={{ environmentId, threadId: ThreadId.make(threadId) }}
          workspaceMutationId={null}
        />,
      );

    await using screen = await render(preview("first"));
    await expect.element(screen.getByText("Section 0", { exact: true })).toBeInTheDocument();
    const saved = await scrollDown();
    await screen.rerender(preview("second"));
    await vi.waitFor(() => expect(readingPosition()?.heading).toBe("Section 0"));
    await screen.rerender(preview("first"));
    await expectReadingPosition(saved);
  });
});

describe("rendered Markdown footnotes across chunks", () => {
  it("renders cross-chunk footnotes with document-wide numbering and one footnotes section", async () => {
    using _settings = setup();
    using _style = withAppCss();
    const paragraphs = Array.from(
      { length: 60 },
      (_, i) =>
        `Paragraph ${i}. ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(2)}`,
    );
    const markdown = [
      "A footnote reference.[^1]",
      "",
      ...paragraphs.slice(0, 35).flatMap((p) => [p, ""]),
      "Second note[^second] and repeat[^1].",
      "",
      ...paragraphs.slice(35).flatMap((p) => [p, ""]),
      "[^1]: The footnote text.",
      "[^second]: The second footnote.",
      "",
      "    - [ ] Footnote task",
    ].join("\n");
    const onTaskListChange = vi.fn();

    const split = splitMarkdown(markdown);
    expect(split.chunks.length).toBeGreaterThan(1);
    expect(split.footnotes).toBeDefined();

    await using screen = await render(
      sized(
        <ChunkedMarkdown
          {...split}
          cwd="/workspace"
          relativePath="footnotes.md"
          threadRef={threadRef}
          workspaceMutationId={null}
          onTaskListChange={onTaskListChange}
        />,
      ),
    );

    const firstRef = await vi.waitFor(() => {
      const link = screen.container.querySelector<HTMLAnchorElement>(
        'a[data-footnote-ref][href="#user-content-fn-1"]',
      );
      expect(link).not.toBeNull();
      return link!;
    });
    expect(firstRef.textContent).toBe("1");
    expect(screen.container.textContent).not.toContain("[^1]");

    // Clicking the footnote ref scrolls to the trailing footnotes section even in a virtualized list.
    firstRef.click();
    await vi.waitFor(() => {
      const sections = screen.container.querySelectorAll("section[data-footnotes]");
      expect(sections.length).toBe(1);
      expect(sections[0]!.textContent).toContain("The footnote text.");
      expect(sections[0]!.textContent).toContain("The second footnote.");
    });

    // A task in a footnote edits its line in the file, not in the section's own text.
    await act(async () =>
      screen.container
        .querySelector<HTMLInputElement>('section[data-footnotes] input[type="checkbox"]')!
        .click(),
    );
    expect(onTaskListChange).toHaveBeenCalledExactlyOnceWith({
      markerOffset: markdown.indexOf("[ ] Footnote task"),
      checked: true,
    });

    // Clicking the backref returns to the first reference (fnref-1) at the top of chunk 0.
    const backref = screen.container.querySelector<HTMLAnchorElement>(
      'section[data-footnotes] a[data-footnote-backref][href="#user-content-fnref-1"]',
    );
    expect(backref).not.toBeNull();
    const scroller = screen.container.querySelector<HTMLElement>(".scrollbar-gutter-both")!;
    expect(scroller.scrollTop).toBeGreaterThan(0);
    backref!.click();
    await vi.waitFor(() => {
      const topRef = screen.container.querySelector<HTMLAnchorElement>(
        'a[data-footnote-ref][id$="fnref-1"]',
      );
      expect(topRef).not.toBeNull();
      expect(topRef!.textContent).toBe("1");
      expect(scroller.scrollTop).toBeLessThan(200);
    });
  });
});

function withPreviewAppCss() {
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  return { [Symbol.dispose]: () => style.remove() };
}

function opened(positionKey: string, children: ReactNode, height = 400) {
  return (
    <PreviewPositionKey value={positionKey}>
      <div style={{ width: 500, height, display: "flex", flexDirection: "column" }}>{children}</div>
    </PreviewPositionKey>
  );
}

describe("large text scroll position", () => {
  const log = (count: number, indexing = false, revealLine?: number) => (
    <VirtualTablePreview
      name="app.log"
      indexing={indexing}
      revealLine={revealLine ?? null}
      revealRequestId={1}
      count={count}
      columns={1}
      source
      getRows={(page) =>
        Array.from({ length: PREVIEW_PAGE_ROWS }, (_, row) => [
          `entry ${page * PREVIEW_PAGE_ROWS + row + 1}`,
        ])
      }
    />
  );
  const scroller = () =>
    document
      .querySelector<HTMLElement>("[data-preview-row]")
      ?.closest<HTMLElement>(".overflow-auto") ?? expect.unreachable();
  const firstVisibleRow = () => {
    const top = scroller().getBoundingClientRect().top;
    const row = Array.from(scroller().querySelectorAll<HTMLElement>("[data-preview-row]")).find(
      (node) => node.getBoundingClientRect().bottom > top + 1,
    );
    return Number(row?.dataset.previewRow);
  };

  it("returns a reopened log to its line, once that line has streamed in", async () => {
    using _style = withPreviewAppCss();
    let saved: number;
    {
      await using _screen = await render(opened("app.log", log(5000)));
      await vi.waitFor(() => expect(firstVisibleRow()).toBe(0));
      scroller().scrollTop = 1000 * 29;
      scroller().dispatchEvent(new Event("scroll"));
      await vi.waitFor(() => expect(firstVisibleRow()).toBeGreaterThan(900));
      saved = firstVisibleRow();
    }
    {
      await using _screen = await render(opened("other.log", log(5000)));
      await vi.waitFor(() => expect(firstVisibleRow(), "another file opens at the top").toBe(0));
    }
    await using screen = await render(opened("app.log", log(100)));
    await vi.waitFor(() => expect(firstVisibleRow()).toBe(0));
    await screen.rerender(opened("app.log", log(5000)));
    await vi.waitFor(() => expect(firstVisibleRow()).toBe(saved));
  });

  it.each([{ indexing: true }, { indexing: false }])(
    "keeps the reading row past a cited line on return (indexing: $indexing)",
    async ({ indexing }) => {
      using _style = withPreviewAppCss();
      const key = `cited-log-${indexing}`;
      {
        await using _screen = await render(opened(key, log(66000, false, 1000), 608));
        await vi.waitFor(() => expect(firstVisibleRow()).toBe(999));
        scroller().scrollTop = 1499 * 29;
        scroller().dispatchEvent(new Event("scroll"));
        await vi.waitFor(() => expect(firstVisibleRow()).toBe(1499));
      }
      // While indexing, the viewer has no line request yet.
      await using screen = await render(
        opened(key, indexing ? log(2000, true) : log(66000, false, 1000), 608),
      );
      if (indexing) {
        await vi.waitFor(() => expect(firstVisibleRow()).toBe(1499));
        await screen.rerender(opened(key, log(66000, false, 1000), 608));
      }
      await vi.waitFor(() => expect(firstVisibleRow()).toBe(1499));
    },
  );

  const wrappedLog = (
    count: number,
    { missingPage = -1, indexing = false, wrap = true, wide = false } = {},
  ) => (
    <VirtualTablePreview
      name="wrapped.log"
      count={count}
      indexing={indexing}
      columns={wide ? 8 : 1}
      source={!wide}
      wrap={wrap}
      getRows={(page) =>
        page === missingPage
          ? undefined
          : Array.from({ length: PREVIEW_PAGE_ROWS }, (_, local) => {
              const index = page * PREVIEW_PAGE_ROWS + local;
              return [
                `entry ${index}: ${index >= 80 ? "wrapped content ".repeat(wide && index >= 96 ? 2 : 60) : ""}`,
              ];
            })
      }
    />
  );
  const row = (index: number) =>
    scroller().querySelector<HTMLElement>(`[data-preview-row="${index}"]`);
  const waitForRowLayout = (index: number) =>
    new Promise<void>((resolve) => {
      const observer = new ResizeObserver(() => {
        observer.disconnect();
        resolve();
      });
      observer.observe(row(index)!);
    });
  const atEnd = (index: number) =>
    Math.abs(
      (row(index)?.getBoundingClientRect().bottom ?? 0) - scroller().getBoundingClientRect().bottom,
    ) < 2;
  const scrollToEnd = async () => {
    await vi.waitFor(() => expect(firstVisibleRow()).toBe(0));
    await act(() =>
      scroller().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
    );
    await vi.waitFor(() => expect(atEnd(99)).toBe(true));
    await act(() => scroller().dispatchEvent(new Event("scroll")));
  };
  const scrollToRow = async (index: number) => {
    const viewport = scroller();
    await act(() => {
      viewport.scrollTop +=
        row(index)!.getBoundingClientRect().top - viewport.getBoundingClientRect().top + 2;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await vi.waitFor(() => expect(firstVisibleRow()).toBe(index));
  };

  it.each([
    { name: "an interior row in the wrapped tail", interior: true, count: 100 },
    { name: "the new bottom after truncation", interior: false, count: 98 },
  ])("restores $name when reopening a preview", async ({ name, interior, count }) => {
    using _style = withPreviewAppCss();
    {
      await using _screen = await render(opened(name, wrappedLog(100)));
      await scrollToEnd();
      if (interior) await scrollToRow(94);
    }
    await using screen = await render(
      opened(name, wrappedLog(interior ? count : 85, { indexing: !interior })),
    );
    if (!interior) {
      await vi.waitFor(() => expect(firstVisibleRow()).toBe(0));
      await screen.rerender(opened(name, wrappedLog(count)));
    }
    await vi.waitFor(() => {
      if (interior) expect(firstVisibleRow()).toBe(94);
      else expect(atEnd(count - 1)).toBe(true);
    });
  });

  it("keeps a manual scroll made before the final page arrives", async () => {
    using _style = withPreviewAppCss();
    const key = "wrapped log with delayed final page";
    {
      await using _screen = await render(opened(key, wrappedLog(100)));
      await scrollToEnd();
    }
    await using screen = await render(opened(key, wrappedLog(100, { missingPage: 3 })));
    await vi.waitFor(() => expect(row(94)?.textContent).toContain("entry 94"));
    await scrollToRow(94);
    await screen.rerender(opened(key, wrappedLog(100)));
    await vi.waitFor(() => expect(row(99)?.textContent).toContain("entry 99"));
    await waitForRowLayout(99);
    expect(firstVisibleRow()).toBe(94);
  });

  it.each([false, true])(
    "handles a late preceding page with manual scrolling set to %s",
    async (manualScroll) => {
      using _style = withPreviewAppCss();
      const key = `wrapped log with late preceding page ${manualScroll}`;
      {
        await using _screen = await render(opened(key, wrappedLog(100)));
        await scrollToEnd();
        await scrollToRow(96);
      }
      await using screen = await render(opened(key, wrappedLog(100, { missingPage: 2 })));
      await vi.waitFor(() => expect(row(96)?.textContent).toContain("entry 96"));
      await waitForRowLayout(96);
      const viewport = scroller();
      if (manualScroll) {
        viewport.style.overflowAnchor = "none";
        await scrollToRow(97);
      }
      const manualTop = viewport.scrollTop;
      await screen.rerender(opened(key, wrappedLog(100)));
      await vi.waitFor(() => expect(row(94)?.textContent).toContain("entry 94"));
      if (manualScroll) {
        await waitForRowLayout(94);
        expect(viewport.scrollTop).toBe(manualTop);
      } else await vi.waitFor(() => expect(firstVisibleRow()).toBe(96));
    },
  );

  it("keeps a wide table at the bottom when the preceding tail page arrives last", async () => {
    using _style = withPreviewAppCss();
    const key = "wide table with late preceding page";
    {
      await using _screen = await render(opened(key, wrappedLog(100, { wide: true })));
      await scrollToEnd();
    }
    await using screen = await render(opened(key, wrappedLog(100, { wide: true, missingPage: 2 })));
    // Require the preview to preserve the bottom even when the browser does not anchor it.
    scroller().style.overflowAnchor = "none";
    await vi.waitFor(() => expect(atEnd(99)).toBe(true));
    await waitForRowLayout(99);
    await screen.rerender(opened(key, wrappedLog(100, { wide: true })));
    await vi.waitFor(() => {
      expect(row(94)?.offsetHeight).toBeGreaterThan(29);
      expect(atEnd(99)).toBe(true);
    });
  });

  it("allows scrolling up after a saved tail row can no longer align with the top", async () => {
    using _style = withPreviewAppCss();
    const key = "wrapped log with wrap turned off";
    {
      await using _screen = await render(opened(key, wrappedLog(100)));
      await scrollToEnd();
      await scrollToRow(94);
    }
    await using _screen = await render(opened(key, wrappedLog(100, { wrap: false })));
    const viewport = scroller();
    await vi.waitFor(() => {
      expect(viewport.scrollTop).toBeGreaterThan(0);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThan(2);
    });
    await act(() => {
      viewport.scrollTop -= 3 * 29;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await vi.waitFor(() => expect(firstVisibleRow()).toBeLessThan(87));
  });
});

describe("notebook scroll position", () => {
  const notebook = (
    <NotebookPreview
      notebook={{
        type: "notebook",
        language: "python",
        cells: Array.from({ length: 40 }, (_, index) => ({
          kind: "raw" as const,
          source: Array.from({ length: 8 }, (_, line) => `cell ${index} line ${line}`).join("\n"),
          outputs: [],
        })),
      }}
    />
  );
  const scroller = () =>
    document.querySelector<HTMLElement>("section")?.closest<HTMLElement>(".overflow-auto") ??
    expect.unreachable();
  const readingPosition = () => {
    const top = scroller().getBoundingClientRect().top;
    const cells = Array.from(scroller().querySelectorAll("section"));
    const cell = cells.findIndex((node) => node.getBoundingClientRect().bottom > top);
    return { cell, offset: Math.round(top - cells[cell]!.getBoundingClientRect().top) };
  };

  it("keeps cells shown with Show more when the notebook closes without another scroll", async () => {
    using _style = withPreviewAppCss();
    {
      await using screen = await render(opened("expanded.ipynb", notebook));
      await screen.getByRole("button", { name: /Show more cells/ }).click();
      await vi.waitFor(() => expect(scroller().querySelectorAll("section")).toHaveLength(40));
    }
    await using _screen = await render(opened("expanded.ipynb", notebook));
    await vi.waitFor(() => expect(scroller().querySelectorAll("section")).toHaveLength(40));
  });

  it("returns a reopened notebook to its cell, including cells shown with Show more", async () => {
    using _style = withPreviewAppCss();
    let saved: ReturnType<typeof readingPosition>;
    {
      await using screen = await render(opened("analysis.ipynb", notebook));
      await screen.getByRole("button", { name: /Show more cells/ }).click();
      await vi.waitFor(() => expect(scroller().querySelectorAll("section")).toHaveLength(40));
      scroller().scrollTop = scroller().scrollHeight - scroller().clientHeight - 200;
      scroller().dispatchEvent(new Event("scroll"));
      saved = readingPosition();
      expect(saved.cell, "scrolled into the cells Show more added").toBeGreaterThan(20);
    }
    {
      await using _screen = await render(opened("other.ipynb", notebook));
      await vi.waitFor(() => expect(scroller().querySelectorAll("section")).toHaveLength(20));
      expect(scroller().scrollTop, "another notebook opens at the top").toBe(0);
    }
    await using _screen = await render(opened("analysis.ipynb", notebook));
    await vi.waitFor(() => {
      const position = readingPosition();
      expect(position.cell).toBe(saved.cell);
      expect(Math.abs(position.offset - saved.offset)).toBeLessThanOrEqual(2);
    });
  });
});

it("highlights Jupyter kernel languages while keeping labels and raw cells plain", async () => {
  // Loading a grammar on first use can outlast waitFor on a busy runner.
  await preloadHighlighter({
    themes: Object.values(DEFAULT_THEMES),
    langs: ["rust", "cpp", "csharp", "fsharp", "zsh"],
  });
  for (const [language, source] of [
    ["Rust", 'fn main() { println!("hi"); }'],
    ["C++17", "int main() { return 0; }"],
    ["C#", "class C { int x = 1; }"],
    ["F#", "let answer = 42"],
    ["Bash", 'if [ -n "$HOME" ]; then echo "hi"; fi'],
  ] as const) {
    const cells = (["code", "raw"] as const).map((kind) => ({ kind, source, outputs: [] }));
    const notebook = { type: "notebook" as const, language, cells };
    await using screen = await render(<NotebookPreview notebook={notebook} />);
    expect(screen.getByRole("status").first().element().textContent).toContain(`· ${language}`);
    expect(screen.container.querySelector("section > div")?.textContent).toBe(`${language} · 1`);
    await vi.waitFor(() => {
      const [code, raw] = [...screen.container.querySelectorAll("diffs-container")].map((el) => {
        const spans = el.shadowRoot?.querySelectorAll("[data-line] span") ?? [];
        return new Set(Array.from(spans, (span) => getComputedStyle(span).color)).size;
      });
      expect(code, language).toBeGreaterThan(1);
      expect(raw, `raw:${language}`).toBe(1);
    });
  }
});
