// @vitest-environment jsdom
import { getSharedHighlighter, type FileContents, type File as FileInstance } from "@pierre/diffs";
import { Editor, type EditorFactory, type EditorOptions } from "@pierre/diffs/edit";
import { EditProvider, File, Virtualizer } from "@pierre/diffs/react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { createFileEditorFocusRestorer } from "./fileEditorFocus";
import { observeCodeWhitespace, renderCodeWhitespace } from "~/lib/codeWhitespace";
import { EditableFileSurface } from "./FilePreviewPanel";

const surfaceState = vi.hoisted(() => ({
  width: 4,
  addReviewComment: vi.fn(),
  removeReviewComment: vi.fn(),
  saveCoordinator: { change: vi.fn() },
}));
vi.mock("~/hooks/useEditorConfigTabWidths", () => ({
  useEditorConfigTabWidths: () => new Map([["file.txt", surfaceState.width]]),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: () => false,
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: (select: (state: typeof surfaceState) => unknown) => select(surfaceState),
}));
vi.mock("./useFileSaveCoordinator", () => ({
  useFileSaveCoordinator: () => surfaceState.saveCoordinator,
}));
vi.mock("./projectFilesQueryState", () => ({
  getProjectFileContents: vi.fn(),
  setProjectFileQueryData: vi.fn(),
}));

const renderingManagerUrl = new URL(
  "./managers/UniversalRenderingManager.js",
  import.meta.resolve("@pierre/diffs"),
);
const { clearRenderQueue } = (await import(/* @vite-ignore */ renderingManagerUrl.href)) as {
  clearRenderQueue(): void;
};

const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let root: Root | undefined;
let editor: Editor<"file", undefined, undefined>;
let host: HTMLDivElement;
let restore: ReturnType<typeof createFileEditorFocusRestorer>;
const mountReadiness: boolean[] = [];
let stopObserving: (() => void) | undefined;
const file: FileContents = { name: "file.txt", cacheKey: "focus-test", contents: "\ttext\n" };
const createEditor: EditorFactory<undefined, undefined> = (type, options, key) =>
  new Editor(type, options, key);
let editorOptions: EditorOptions<"file", undefined, undefined>;
const scrollMethods = ["scrollTo", "scrollIntoView"] as const;
const scrollDescriptors = scrollMethods.map((method) =>
  Object.getOwnPropertyDescriptor(HTMLElement.prototype, method),
);

beforeAll(async () => {
  await getSharedHighlighter({ themes: ["pierre-dark"], langs: ["text", "typescript"] });
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    measureText: (text: string) => ({ width: text.length * 8 }),
  } as unknown as ReturnType<HTMLCanvasElement["getContext"]>);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
    new DOMRect(0, 0, 500, 200),
  );
  const computedStyle = window.getComputedStyle;
  vi.spyOn(window, "getComputedStyle").mockImplementation((element) => {
    const metrics = {
      fontFamily: "monospace",
      fontSize: "13px",
      lineHeight: "20px",
      paddingTop: "0px",
      tabSize: "2",
    };
    return new Proxy(computedStyle(element), {
      get(target, key) {
        if (key in metrics) return metrics[key as keyof typeof metrics];
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  });
  vi.stubGlobal("matchMedia", () => ({ matches: true }) as MediaQueryList);
  for (const method of scrollMethods) {
    Object.defineProperty(HTMLElement.prototype, method, { configurable: true, value: () => {} });
  }
  mountReadiness.length = 0;
  restore = createFileEditorFocusRestorer();
  editorOptions = {
    onAttach: (attachedEditor) => {
      editor = attachedEditor;
      restore.onAttach(attachedEditor);
    },
  };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  stopObserving?.();
  stopObserving = undefined;
  await act(async () => root?.unmount());
  root = undefined;
  clearRenderQueue();
  frames.clear();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const [index, method] of scrollMethods.entries()) {
    const descriptor = scrollDescriptors[index];
    if (descriptor) Object.defineProperty(HTMLElement.prototype, method, descriptor);
    else Reflect.deleteProperty(HTMLElement.prototype, method);
  }
});

async function drainFrames() {
  await act(async () => {
    for (let frame = 0; frames.size > 0; frame += 1) {
      if (frame === 20) throw new Error("Editor render queue did not settle");
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(frame);
    }
  });
}

async function render(width: number, contents = file, showWhitespace = false) {
  await act(async () => {
    root!.render(
      <EditProvider createEditor={createEditor}>
        <Virtualizer>
          <File
            key={width}
            file={contents}
            edit
            editorOptions={editorOptions}
            {...(contents.cacheKey ? { editStateKey: contents.cacheKey } : {})}
            disableWorkerPool
            options={{
              theme: "pierre-dark",
              themeType: "dark",
              disableFileHeader: true,
              unsafeCSS: `:host { --diffs-tab-size: ${width}; }`,
              onPostRender: (container, _instance, phase) => {
                if (phase === "unmount") restore.onUnmount(container);
                if (phase === "mount") mountReadiness.push(editor?.getFile() !== undefined);
                if (phase !== "unmount") renderCodeWhitespace(container, showWhitespace);
                // jsdom does not make contentEditable elements focusable like a browser does.
                const code = container.shadowRoot?.querySelector<HTMLElement>("[data-content]");
                if (code) code.tabIndex = 0;
              },
            }}
          />
        </Virtualizer>
      </EditProvider>,
    );
  });
}

function currentView() {
  const container = host.querySelector<HTMLElement>("diffs-container")!;
  const code = container.shadowRoot!.querySelector<HTMLElement>("[data-content]")!;
  return { container, code };
}

describe("file editor focus across view remounts", () => {
  it("retains an unsent file comment across tab-width remounts until submit or cancel", async () => {
    const target = {
      environmentId: EnvironmentId.make("draft-test"),
      threadId: ThreadId.make("draft-thread"),
    };
    let selectLines: FileInstance<undefined, undefined>["options"]["onLineSelectionEnd"];
    const renderSurface = async (width: number) => {
      surfaceState.width = width;
      await act(async () =>
        root!.render(
          <EditableFileSurface
            environmentId={target.environmentId}
            cwd="/repo"
            relativePath="file.txt"
            composerDraftTarget={target}
            contents={file.contents}
            resolvedTheme="dark"
            revealRequestId={0}
            wordWrap={false}
            onPostRender={(_container, fileInstance) => {
              selectLines = fileInstance.options.onLineSelectionEnd;
            }}
            onPendingChange={() => {}}
          />,
        ),
      );
      await drainFrames();
    };
    surfaceState.addReviewComment.mockClear();
    surfaceState.removeReviewComment.mockClear();
    await renderSurface(4);
    await act(async () => selectLines?.({ start: 1, end: 1 }));
    await drainFrames();
    const textarea = () => host.querySelector("textarea")!;
    const writeComment = async (text: string) => {
      await act(async () => {
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          textarea(),
          text,
        );
        textarea().dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    expect(textarea()).not.toBeNull();
    await writeComment("Unsent review text");
    expect(textarea().value).toBe("Unsent review text");
    const oldTextarea = textarea();
    await renderSurface(8);
    expect(textarea()).not.toBe(oldTextarea);
    expect(textarea().value).toBe("Unsent review text");
    expect(surfaceState.addReviewComment).not.toHaveBeenCalled();
    await act(async () =>
      textarea().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true }),
      ),
    );
    expect(surfaceState.addReviewComment).toHaveBeenCalledExactlyOnceWith(
      target,
      expect.objectContaining({ text: "Unsent review text" }),
    );
    expect(textarea()).toBeNull();
    await act(async () => selectLines?.({ start: 1, end: 1 }));
    await drainFrames();
    await writeComment("Discard this");
    await act(async () =>
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
    );
    expect(textarea()).toBeNull();
    await act(async () => selectLines?.({ start: 1, end: 1 }));
    await drainFrames();
    expect(textarea().value).toBe("");
    expect(surfaceState.addReviewComment).toHaveBeenCalledTimes(1);
  });

  it.each(["txt", "ts"])(
    "keeps native selection and edits aligned in .%s after patched rows are decorated and markers disabled",
    async (extension) => {
      const contents = "\t  hello world\n";
      await render(
        4,
        { name: `selection.${extension}`, cacheKey: `selection.${extension}`, contents },
        true,
      );
      await drainFrames();
      const { container, code } = currentView();
      stopObserving = observeCodeWhitespace(container);
      // Force the real EditorTokenizer/renderLineTokens path, which emits raw text for .txt.
      editor.applyEdits([
        {
          range: { start: { line: 0, character: 14 }, end: { line: 0, character: 14 } },
          newText: "!",
        },
      ]);
      await drainFrames();
      const line = () => code.querySelector<HTMLElement>("[data-code] [data-line]")!;
      expect(line().querySelector("[data-whitespace]")).not.toBeNull();
      editor.focus({ preventScroll: true });
      await drainFrames();

      // jsdom cannot store a shadow-root Selection. Supply its missing composed-range read,
      // but use real DOM Ranges and Pierre's selectionchange/beforeinput handlers throughout.
      const nativeSelection = document.getSelection()!;
      let composedRange: Range | undefined;
      vi.spyOn(document, "getSelection").mockReturnValue(
        new Proxy(nativeSelection, {
          get(target, key) {
            if (key === "getComposedRanges") return () => (composedRange ? [composedRange] : []);
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      );
      const setNativeSelection = vi.spyOn(nativeSelection, "setBaseAndExtent");
      for (const enabled of [true, false]) {
        renderCodeWhitespace(container, enabled);
        // Document -> DOM: requesting character zero must land before the tab, not after indent.
        setNativeSelection.mockClear();
        editor.setSelections([
          { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, direction: "none" },
        ]);
        editor.focus({ preventScroll: true });
        await drainFrames();
        expect(container.hasAttribute("data-show-whitespace")).toBe(enabled);
        const [node, offset] = setNativeSelection.mock.calls.at(-1)!;
        const prefix = document.createRange();
        prefix.setStart(line(), 0);
        prefix.setEnd(node, offset);
        expect(prefix.toString()).toBe("");

        // DOM -> document: select "world" directly in the rendered text, then replace it.
        const walker = document.createTreeWalker(line(), NodeFilter.SHOW_TEXT);
        let world: Node | null = null;
        while (walker.nextNode()) {
          if (walker.currentNode.textContent!.includes("world")) world = walker.currentNode;
        }
        expect(world).not.toBeNull();
        composedRange = document.createRange();
        const start = world!.textContent!.indexOf("world");
        composedRange.setStart(world!, start);
        composedRange.setEnd(world!, start + 5);
        document.dispatchEvent(new Event("selectionchange"));
        expect(editor.getViewState().selections).toMatchObject([
          { start: { line: 0, character: 9 }, end: { line: 0, character: 14 } },
        ]);
        code.dispatchEvent(
          new InputEvent("beforeinput", {
            inputType: "insertText",
            data: "earth",
            bubbles: true,
            cancelable: true,
          }),
        );
        expect(editor.getText()).toBe("\t  hello earth!\n");
        composedRange = undefined;
        await drainFrames();
        editor.undo();
        await drainFrames();
        expect(editor.getText()).toBe("\t  hello world!\n");
        expect(container.hasAttribute("data-show-whitespace")).toBe(enabled);
      }
      editor.undo();
      expect(editor.getText()).toBe(contents);
    },
  );

  it("restores focus after Pierre attaches the replacement editor, retaining selection and undo", async () => {
    await render(2);
    await drainFrames();
    editor.applyEdits([
      { range: { start: { line: 0, character: 5 }, end: { line: 0, character: 5 } }, newText: "!" },
    ]);
    await drainFrames();
    editor.setSelections([
      { start: { line: 0, character: 1 }, end: { line: 0, character: 1 }, direction: "none" },
    ]);
    editor.focus({ preventScroll: true });
    await drainFrames();
    const before = currentView();
    const state = editor.getViewState();
    const edited = editor.getText();
    expect(before.container.shadowRoot!.activeElement).toBe(before.code);
    await render(8);
    expect(mountReadiness).toEqual([false, false]);
    await drainFrames();
    const after = currentView();
    expect(after.code).not.toBe(before.code);
    expect(after.container.shadowRoot!.activeElement).toBe(after.code);
    expect(editor.getViewState().selections).toEqual(state.selections);
    expect(editor.getText()).toBe(edited);
    after.code.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "a",
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(editor.getText()).toBe("\tatext!\n");
    editor.undo();
    expect(editor.getText()).toBe(edited);
    editor.undo();
    expect(editor.getText()).toBe(file.contents);
  });

  it("does not focus an editor that was not focused before remount", async () => {
    await render(2);
    await drainFrames();
    await render(8);
    await drainFrames();
    expect(document.activeElement).toBe(document.body);
  });

  it("does not take focus from a control focused while attachment is pending", async () => {
    await render(2);
    await drainFrames();
    editor.focus({ preventScroll: true });
    await render(8);
    const control = document.createElement("input");
    document.body.append(control);
    control.focus();
    await drainFrames();
    expect(document.activeElement).toBe(control);
  });

  it("does not transfer comment focus into code", async () => {
    await render(2);
    await drainFrames();
    const before = currentView();
    const comment = document.createElement("input");
    before.container.shadowRoot!.append(comment);
    comment.focus();
    await render(8);
    await drainFrames();
    expect(document.activeElement).toBe(document.body);
  });
});
