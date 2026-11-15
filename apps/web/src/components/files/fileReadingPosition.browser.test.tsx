import { DEFAULT_THEMES, preloadHighlighter } from "@pierre/diffs";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ThreadId,
  type ProjectReadFileResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import appCss from "~/index.css?inline";
import { useClosedViewStore } from "~/closedViewStore";
import { selectActiveRightPanelSurface, useRightPanelStore } from "~/rightPanelStore";

const state = vi.hoisted(() => ({
  file: null as ProjectReadFileResult | null,
  files: {} as Record<string, ProjectReadFileResult>,
  optimistic: null as ProjectReadFileResult | null,
  writeFile: vi.fn(),
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
}));
vi.mock(import("~/hooks/useWorkspaceMutationRefresh"), () => ({
  useWorkspaceMutationRefresh: vi.fn(),
}));
vi.mock(import("./FileBreadcrumbs"), () => ({ FileBreadcrumbs: () => <></> }));
vi.mock(import("./FileBrowserPanel"), () => ({ default: () => <div role="tree" /> }));
vi.mock(import("../DiffWorkerPoolProvider"), () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => <>{children}</>,
}));
vi.mock(import("./projectFilesQueryState"), async (original) => ({
  ...(await original()),
  useProjectFileQuery: (_environmentId: EnvironmentId, _cwd: string, path: string | null) => ({
    data: (path === null ? undefined : state.files[path]) ?? state.file,
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
import { type FileReadingKey, usePdfReadingView } from "./fileReadingSave";
import { FILE_LINK_REVEAL_ATTRIBUTE } from "./fileSurfaceChrome";

const environmentId = EnvironmentId.make("file-reading-position-test");

function setup() {
  const keys = ["t3code.fileExplorerOpen", "t3code.renderMarkdown"];
  const previous = keys.map((key) => localStorage.getItem(key));
  localStorage.setItem(keys[0]!, "false");
  localStorage.setItem(keys[1]!, "true");
  state.file = null;
  state.files = {};
  state.optimistic = null;
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

const noop = () => {};

function sourceFile(relativePath: string, word: string, lines: number): ProjectReadFileResult {
  const contents = Array.from(
    { length: lines },
    (_, index) => `const ${word}_${index + 1} = ${index + 1};`,
  ).join("\n");
  return { relativePath, contents, byteLength: contents.length, truncated: false };
}

async function readingSetup(name: string) {
  await preloadHighlighter({ themes: Object.values(DEFAULT_THEMES), langs: ["typescript"] });
  const settings = setup();
  const style = document.createElement("style");
  style.textContent = appCss;
  document.head.append(style);
  const doc = Array.from({ length: 80 }, (_, index) => `Paragraph ${index + 1}.`).join("\n\n");
  state.files = {
    "a.ts": sourceFile("a.ts", "alpha", 300),
    "b.ts": sourceFile("b.ts", "beta", 300),
    "c.ts": sourceFile("c.ts", "gamma", 10),
    "doc.md": { relativePath: "doc.md", contents: doc, byteLength: doc.length, truncated: false },
  };
  const ref = scopeThreadRef(environmentId, ThreadId.make(`reading-${name}`));
  const cwd = `/reading/${name}`;
  return {
    ref,
    cwd,
    panel: useRightPanelStore.getState(),
    saved: (path: string, view: "source" | "rendered") =>
      JSON.parse(
        localStorage.getItem(
          `t3code.fileReading.v1:${JSON.stringify([environmentId, `${cwd}/${path}`, view])}`,
        ) ?? "null",
      ) as { line?: number; block?: number; at: number } | null,
    [Symbol.dispose]() {
      useRightPanelStore.getState().removeThread(ref);
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("t3code.fileReading.v1:") || key.startsWith("t3code.fileReveal.v1:")) {
          localStorage.removeItem(key);
        }
      }
      style.remove();
      settings[Symbol.dispose]();
    },
  };
}

/** Renders the active file tab the way the right panel does: one panel per workspace. */
function ReadingPanel(props: { readonly threadRef: ScopedThreadRef; readonly cwd: string }) {
  const surface = useRightPanelStore((store) =>
    selectActiveRightPanelSurface(store.byThreadKey, props.threadRef),
  );
  return (
    <div style={{ display: "flex", height: 400, width: 700 }}>
      {surface?.kind === "file" ? (
        <FilePreviewPanel
          environmentId={environmentId}
          cwd={props.cwd}
          projectName="Project"
          relativePath={surface.relativePath}
          threadRef={props.threadRef}
          composerDraftTarget={props.threadRef}
          keybindings={[]}
          availableEditors={[]}
          openInShortcutEnabled={false}
          revealLine={surface.revealLine}
          revealRequestId={surface.revealRequestId}
          onOpenFile={noop}
          onNavigateFolder={noop}
          folderTrail={undefined}
          onPendingChange={noop}
          selectedFilePending={false}
          workspaceMutationId={null}
        />
      ) : null}
    </div>
  );
}

function sourceView(container: HTMLElement) {
  const scroller = () => container.querySelector<HTMLElement>(".file-preview-virtualizer")!;
  const line = (lineNumber: number) =>
    container
      .querySelector("diffs-container")
      ?.shadowRoot?.querySelector<HTMLElement>(`[data-line="${lineNumber}"]`) ?? null;
  return {
    scroller,
    line,
    /** The first row the viewport shows, partly or fully, and its top relative to the viewport. */
    topLine() {
      const top = scroller().getBoundingClientRect().top;
      const rows = container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelectorAll("[data-line]");
      const row = [...(rows ?? [])]
        .filter((element) => element.getBoundingClientRect().bottom > top + 0.5)
        .sort(
          (left, right) =>
            Number(left.getAttribute("data-line")) - Number(right.getAttribute("data-line")),
        )[0];
      return {
        line: Number(row?.getAttribute("data-line")),
        offset: Math.round(row!.getBoundingClientRect().top - top),
      };
    },
    expectLineInView(lineNumber: number, text: string) {
      const element = line(lineNumber);
      expect(element?.textContent).toContain(text);
      const view = scroller().getBoundingClientRect();
      const rect = element!.getBoundingClientRect();
      expect(rect.top).toBeGreaterThanOrEqual(view.top - 1);
      expect(rect.bottom).toBeLessThanOrEqual(view.bottom + 1);
    },
  };
}

describe("file reading position", () => {
  it("returns a source file to the reader's line after a tab switch and a panel remount", async () => {
    using reading = await readingSetup("switch");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "a.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"));
    await userEvent.wheel(view.scroller(), { delta: { y: 1213 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(50));
    const before = view.topLine();
    expect(before.offset).toBeLessThan(0);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:a.ts"));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before));

    await screen.rerender(<></>);
    await screen.rerender(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    await vi.waitFor(() => expect(view.topLine()).toEqual(before));
  });

  it("reveals a citation over a saved position, then keeps the reader's later place", async () => {
    using reading = await readingSetup("cited");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "a.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"));
    await userEvent.wheel(view.scroller(), { delta: { y: 3000 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(100));

    await act(() => panel.openFile(ref, "a.ts", 40));
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.activateSurface(ref, "file:a.ts"));
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
    expect(reading.saved("a.ts", "source")?.line).toBe(40);
    await userEvent.wheel(view.scroller(), { delta: { y: 230 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(40));
    const before = view.topLine();
    expect(before.line).toBeLessThan(100);

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.openFile(ref, "c.ts"));
    await act(() => panel.closeSurface(ref, "file:c.ts"));
    await act(() => panel.activateSurface(ref, "file:a.ts"));
    await vi.waitFor(() => expect(view.topLine()).toEqual(before));
    expect(view.line(40)?.hasAttribute(FILE_LINK_REVEAL_ATTRIBUTE)).toBe(true);
  });

  it("clamps a saved position past the end of shorter contents without rewriting it", async () => {
    using reading = await readingSetup("shorter");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "a.ts");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(1, "alpha_1"));
    await userEvent.wheel(view.scroller(), { delta: { y: 4000 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(150));
    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    const saved = reading.saved("a.ts", "source");

    state.files["a.ts"] = sourceFile("a.ts", "alpha", 60);
    await act(() => panel.activateSurface(ref, "file:a.ts"));
    await vi.waitFor(() => view.expectLineInView(60, "alpha_60"));
    const scroller = view.scroller();
    expect(scroller.scrollTop).toBeGreaterThanOrEqual(
      scroller.scrollHeight - scroller.clientHeight - 1,
    );
    expect(reading.saved("a.ts", "source")).toEqual(saved);
  });

  it("returns rendered Markdown to the reader's block after a tab switch, clamped when shorter", async () => {
    using reading = await readingSetup("rendered");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "doc.md");
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const viewport = () =>
      screen.container
        .querySelector(".chat-markdown")
        ?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]');
    await vi.waitFor(() => expect(viewport()?.textContent).toContain("Paragraph 80."));
    await userEvent.wheel(viewport()!, { delta: { y: 1500 } });
    await vi.waitFor(() => expect(reading.saved("doc.md", "rendered")?.block).toBeGreaterThan(10));
    const wheeled = reading.saved("doc.md", "rendered")!.block!;

    // The custom scrollbar sits beside the viewport and moves it directly.
    const scrollbar = screen.container.querySelector<HTMLElement>(
      '[data-slot="scroll-area-scrollbar"]',
    )!;
    const track = scrollbar.getBoundingClientRect();
    await userEvent.click(scrollbar, {
      position: { x: track.width / 2, y: track.height - 4 },
    });
    await vi.waitFor(() =>
      expect(reading.saved("doc.md", "rendered")?.block).toBeGreaterThan(wheeled),
    );
    const before = viewport()!.scrollTop;

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => expect(viewport()).toBeFalsy());
    await act(() => panel.activateSurface(ref, "file:doc.md"));
    await vi.waitFor(() => expect(Math.abs(viewport()!.scrollTop - before)).toBeLessThanOrEqual(1));

    await act(() => panel.activateSurface(ref, "file:b.ts"));
    await vi.waitFor(() => expect(viewport()).toBeFalsy());
    const saved = reading.saved("doc.md", "rendered");
    const shorter = Array.from({ length: 30 }, (_, index) => `Paragraph ${index + 1}.`).join(
      "\n\n",
    );
    state.files["doc.md"] = {
      relativePath: "doc.md",
      contents: shorter,
      byteLength: shorter.length,
      truncated: false,
    };
    await act(() => panel.activateSurface(ref, "file:doc.md"));
    await vi.waitFor(() => {
      const element = viewport()!;
      expect(element.textContent).not.toContain("Paragraph 31.");
      expect(element.scrollHeight).toBeGreaterThan(element.clientHeight);
      expect(element.scrollTop).toBeGreaterThanOrEqual(
        element.scrollHeight - element.clientHeight - 1,
      );
    });
    expect(reading.saved("doc.md", "rendered")).toEqual(saved);
  });

  it("returns a citation reopened with Reopen Closed View to the reader's place", async () => {
    using reading = await readingSetup("reopen-closed");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "a.ts", 40);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
    await userEvent.wheel(view.scroller(), { delta: { y: 2000 } });
    await vi.waitFor(() => expect(reading.saved("a.ts", "source")?.line).toBeGreaterThan(100));
    const before = view.topLine();

    await act(() => panel.closeSurface(ref, "file:a.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    const entry = useClosedViewStore
      .getState()
      .entries.find((closed) => closed.kind === "panel-tab" && closed.surface.id === "file:a.ts")!;
    // Reopen Closed View opens the tab with its old line, then drops the closed entry after an await.
    panel.openFile(ref, "a.ts", 40);
    await Promise.resolve();
    useClosedViewStore.getState().remove(entry.id);

    await vi.waitFor(() => expect(view.topLine()).toEqual(before));
    expect(view.line(40)).toBeNull();
  });

  it("jumps to a Markdown citation reopened at request 1 after it was read rendered", async () => {
    using reading = await readingSetup("reopen-md");
    const { panel, ref } = reading;
    panel.openFile(ref, "b.ts");
    panel.openFile(ref, "doc.md", 40);
    await using screen = await render(<ReadingPanel threadRef={ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => expect(view.line(40)).toBeTruthy());
    await userEvent.click(screen.getByRole("button", { name: "Show rendered markdown" }));
    await vi.waitFor(() => expect(screen.container.querySelector(".chat-markdown")).toBeTruthy());

    await act(() => panel.closeSurface(ref, "file:doc.md"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.openFile(ref, "doc.md", 40));

    await vi.waitFor(() => expect(screen.container.querySelector(".chat-markdown")).toBeFalsy());
    await vi.waitFor(() =>
      expect(view.line(40)?.hasAttribute(FILE_LINK_REVEAL_ATTRIBUTE)).toBe(true),
    );
    const scroller = view.scroller();
    const line = view.line(40)!.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    expect(line.top).toBeGreaterThanOrEqual(box.top);
    expect(line.bottom).toBeLessThanOrEqual(box.bottom);
  });

  it("jumps to a citation reopened at request 1 after its tab was closed", async () => {
    using reading = await readingSetup("reopen");
    const panel = useRightPanelStore.getState();
    panel.openFile(reading.ref, "b.ts");
    panel.openFile(reading.ref, "a.ts", 40);
    await using screen = await render(<ReadingPanel threadRef={reading.ref} cwd={reading.cwd} />);
    const view = sourceView(screen.container);
    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
    const revealedTop = view.scroller().scrollTop;
    await userEvent.wheel(view.scroller(), { delta: { y: 2000 } });
    await vi.waitFor(() => expect(view.scroller().scrollTop).toBeGreaterThan(revealedTop + 1000));

    await act(() => panel.closeSurface(reading.ref, "file:a.ts"));
    await vi.waitFor(() => view.expectLineInView(1, "beta_1"));
    await act(() => panel.openFile(reading.ref, "a.ts", 40));

    await vi.waitFor(() => view.expectLineInView(40, "alpha_40"));
  });
});

describe("PDF reading view", () => {
  function PdfView(props: {
    readonly file: FileReadingKey;
    readonly onView: (page: number) => void;
  }) {
    const [view, setView] = usePdfReadingView(props.file);
    props.onView(view.page);
    return (
      <button type="button" onClick={() => setView({ page: 2, offset: 40, zoom: 1.5, left: 0 })}>
        Go to page 3
      </button>
    );
  }

  it("seeds a new PDF.js mount with the page saved by an earlier one", async () => {
    const file = { environmentId, absolutePath: "/reading/pdf/report.pdf" };
    const pages: number[] = [];
    try {
      {
        await using screen = await render(
          <PdfView file={file} onView={(page) => pages.push(page)} />,
        );
        await userEvent.click(screen.getByRole("button", { name: "Go to page 3" }));
        await vi.waitFor(() => expect(pages.at(-1)).toBe(2));
      }
      pages.length = 0;
      await using screen = await render(
        <PdfView file={file} onView={(page) => pages.push(page)} />,
      );
      await expect.element(screen.getByRole("button")).toBeVisible();
      expect(pages[0]).toBe(2);
    } finally {
      for (const key of Object.keys(localStorage)) {
        if (key.startsWith("t3code.fileReading.v1:")) localStorage.removeItem(key);
      }
    }
  });
});
