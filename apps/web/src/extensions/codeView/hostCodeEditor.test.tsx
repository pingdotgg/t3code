// @vitest-environment jsdom

import type { ApiInvocation } from "@t3tools/extension-sdk/capabilities";
import type { Json } from "@t3tools/extension-sdk/contracts";
import type { ClientHost, CodeViewEditorProps } from "@t3tools/extension-sdk/environment";
import type { ViewSession } from "@t3tools/extension-sdk/host";
import { act, createElement } from "react";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { Editor } from "@pierre/diffs/editor";

import { themeStore } from "~/hooks/useTheme";
import { HostCodeEditor } from "./HostCodeViewRenderers";
import { hostCodeView } from "./hostCodeView";

const workerTransports = vi.hoisted(() => new Set<() => Promise<number>>());
vi.mock("@pierre/diffs/worker/worker.js?worker", async () => {
  const { Worker } = await import("node:worker_threads");
  const workerUrl = import.meta.resolve("@pierre/diffs/worker/worker.js");
  return {
    default: class extends EventTarget {
      readonly transport: InstanceType<typeof Worker>;
      constructor() {
        super();
        const source = `import { parentPort } from "node:worker_threads";
          globalThis.self = { addEventListener(type, listener) {
            if (type === "message") parentPort.on("message", data => listener({ data }));
          }};
          globalThis.postMessage = data => parentPort.postMessage(data);
          await import(${JSON.stringify(workerUrl)});`;
        this.transport = new Worker(new URL("data:text/javascript," + encodeURIComponent(source)));
        this.transport.on("message", (data: unknown) =>
          this.dispatchEvent(new MessageEvent("message", { data })),
        );
        this.transport.unref();
        workerTransports.add(() => this.transport.terminate());
      }
      postMessage(value: unknown) {
        this.transport.postMessage(value, []);
      }
      terminate() {
        void this.transport.terminate();
      }
    },
  };
});

afterAll(async () => {
  await Promise.all([...workerTransports].map((terminate) => terminate()));
});

const files = (
  (await import(
    "../../../../../packages/first-party-extensions/files/extension.tsx" as string
  )) as {
    default: {
      client(host: ClientHost): {
        surfaces: { createView(session: ViewSession): { renderer: React.ComponentType } }[];
      };
    };
  }
).default;

let root: Root;
let container: HTMLDivElement;
let stop: AbortController;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 800,
    bottom: 600,
    width: 800,
    height: 600,
    toJSON: () => ({}),
  });
  Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  });
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: () => {},
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", { configurable: true, value: () => {} });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((context: string) =>
    context === "2d"
      ? {
          font: "",
          measureText: (text: string) => ({ width: text.length * 8 }),
        }
      : null) as typeof HTMLCanvasElement.prototype.getContext);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  stop = new AbortController();
});

afterEach(async () => {
  await act(async () => {
    stop.abort();
    root.unmount();
  });
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function content() {
  const element = container
    .querySelector("diffs-container")
    ?.shadowRoot?.querySelector<HTMLElement>("[data-content]");
  expect(element).toBeTruthy();
  element!.tabIndex = 0;
  return element!;
}

function editorReady() {
  return new Promise<void>((resolve) => {
    const observer = new MutationObserver(() => {
      const file = container.querySelector("diffs-container");
      if (file?.shadowRoot?.querySelector('[data-content][role="textbox"]')) {
        observer.disconnect();
        resolve();
      } else if (file?.shadowRoot)
        observer.observe(file.shadowRoot, { childList: true, subtree: true, attributes: true });
    });
    observer.observe(container, { childList: true, subtree: true });
    if (
      container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector('[data-content][role="textbox"]')
    ) {
      observer.disconnect();
      resolve();
    }
  });
}

function typeText(element: HTMLElement, text: string) {
  element.focus();
  element.dispatchEvent(
    new InputEvent("beforeinput", {
      inputType: "insertText",
      data: text,
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  );
}

async function mountFiles(contents = "original", nativeEditor = true, revealLine?: number) {
  const saves: ApiInvocation[] = [];
  const requests: ApiInvocation[] = [];
  const host: ClientHost = {
    React,
    ...(nativeEditor ? { codeView: hostCodeView } : {}),
    discoverApis: async () => [],
    invokeTool: async () => {
      throw new Error("unavailable");
    },
    invokeApi: async (request) => {
      requests.push(request);
      if (request.method === "readSnapshot")
        return { kind: "editable", contents, revision: "base" };
      if (request.method === "save") {
        saves.push(request);
        return saves.length === 1
          ? { kind: "saved", revision: "saved-revision" }
          : { kind: "conflict" };
      }
      if (request.id === "t3.ui/preferences" && request.method === "getPreferences")
        return { wordWrap: false, renderBrowserFile: true };
      if (request.id === "t3.messages/enrichment" && request.method === "getCapabilities")
        return {
          adapter: "web",
          transport: "client",
          detail: null,
          operations: { attachAnnotation: true, listAnnotations: true, removeAnnotation: true },
        };
      throw new Error("unavailable: " + request.id + " " + request.method);
    },
    subscribeApi: (request, signal) =>
      (async function* () {
        if (request.id === "t3.workspace/tree") {
          yield {
            streamId: "tree",
            sequence: 1,
            type: "data",
            value: { kind: "chunk", entries: [{ path: "app.ts", kind: "file" }], truncated: false },
          };
          yield {
            streamId: "tree",
            sequence: 2,
            type: "data",
            value: { kind: "complete", truncated: false },
          };
        } else if (request.id === "t3.ui/preferences") {
          yield {
            streamId: "preferences",
            sequence: 1,
            type: "snapshot",
            value: { wordWrap: false, renderBrowserFile: true },
          };
        } else throw new Error("unavailable stream: " + request.id);
        await new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else signal.addEventListener("abort", () => resolve(), { once: true });
        });
      })(),
  };
  const session = {
    context: {
      client: "web",
      resource: {
        namespace: "t3.workspace",
        id: "files",
        environmentId: "env",
        projectId: "p",
        threadId: "t",
      },
    },
    visible: true,
    restoring: false,
    restoreState: {
      relativePath: "app.ts",
      ...(revealLine === undefined ? {} : { line: revealLine }),
    },
    signal: stop.signal,
    onVisibility: () => () => {},
    onDispose: () => {},
    save: () => true,
    publish: () => true,
  } as unknown as ViewSession;
  const View = files.client(host).surfaces[0]!.createView(session).renderer;
  await act(async () => {
    root.render(createElement(View));
    await vi.dynamicImportSettled();
  });
  return { saves, requests };
}

async function renderFiles(contents = "original") {
  const fileReads = vi.spyOn(Editor.prototype, "getFile");
  const { saves, requests } = await mountFiles(contents);
  expect(container.textContent).not.toContain("Native code editor unavailable");
  await editorReady();
  await act(async () => {});
  expect(content().textContent).toContain(contents.split("\n")[0]!);
  expect(container.textContent).not.toContain("unavailable on this client");
  const instance = fileReads.mock.contexts.at(-1) as Editor<unknown>;
  expect(instance).toBeInstanceOf(Editor);
  return { instance, saves, requests };
}

it("opens the real Files view editable, autosaves through CAS, and keeps its conflicted buffer", async () => {
  const { instance, saves, requests } = await renderFiles();
  const editor = content();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  instance.setSelections([
    { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, direction: "none" },
  ]);
  await act(async () => typeText(editor, "typed "));
  expect(container.textContent).toContain("Unsaved changes");
  expect(saves).toHaveLength(0);
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(saves[0]).toMatchObject({
    id: "t3.workspace/text-edits",
    method: "save",
    input: { relativePath: "app.ts", expectedRevision: "base", contents: "typed original" },
  });
  await act(async () => typeText(content(), "conflicted "));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(saves[1]?.input).toEqual({
    relativePath: "app.ts",
    expectedRevision: "saved-revision",
    contents: "typed conflicted original",
  } as Json);
  expect(container.textContent).toContain("Keep my version");
  expect(content().textContent).toContain("typed conflicted original");
  await act(async () => typeText(content(), "kept "));
  await act(async () => vi.advanceTimersByTimeAsync(500));
  expect(content().textContent).toContain("typed conflicted kept original");
  expect(saves).toHaveLength(2);
  expect(requests.filter((request) => request.id === "t3.ui/editor")).toEqual([
    expect.objectContaining({ method: "getCapabilities" }),
  ]);
});

it.each(["mouse", "touch"])(
  "opens a Files comment draft with a %s pointer",
  async (pointerType) => {
    const { instance } = await renderFiles("one\ntwo\nthree\n");
    instance.setSelections([
      { start: { line: 0, character: 0 }, end: { line: 2, character: 0 }, direction: "forward" },
    ]);
    await act(async () =>
      content().dispatchEvent(new Event("pointerup", { bubbles: true, composed: true })),
    );
    const button = container.querySelector<HTMLButtonElement>('[aria-label="File comment"] button');
    expect(button?.textContent).toBe("Comment on L1 to L2");
    await act(async () =>
      button!.dispatchEvent(
        new PointerEvent("pointerdown", { pointerType, bubbles: true, composed: true }),
      ),
    );
    expect(button?.isConnected).toBe(true);
    await act(async () => button!.click());
    expect(container.querySelector('textarea[aria-label="Comment text"]')).not.toBeNull();
    expect(container.textContent).toContain("Comment on L1 to L2");
  },
);

async function selectGutterLines() {
  const shadow = container.querySelector("diffs-container")!.shadowRoot!;
  const start = shadow.querySelector('[data-column-number="1"]');
  const end = shadow.querySelector('[data-column-number="2"]');
  expect(start).not.toBeNull();
  expect(end).not.toBeNull();
  await act(async () => {
    start!.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerId: 1,
        pointerType: "mouse",
        bubbles: true,
        composed: true,
      }),
    );
    end!.dispatchEvent(
      new PointerEvent("pointermove", {
        pointerId: 1,
        pointerType: "mouse",
        bubbles: true,
        composed: true,
      }),
    );
    end!.dispatchEvent(
      new PointerEvent("pointerup", {
        pointerId: 1,
        pointerType: "mouse",
        bubbles: true,
        composed: true,
      }),
    );
  });
}

it("clears the controlled gutter highlight on Escape and outside pointer dismissal", async () => {
  await renderFiles("one\ntwo\nthree\n");
  for (const reason of ["escape", "pointer"]) {
    await selectGutterLines();
    const shadow = container.querySelector("diffs-container")!.shadowRoot!;
    expect(shadow.querySelector("[data-selected-line]")).not.toBeNull();
    await act(async () => {
      if (reason === "escape") {
        content().focus();
        content().dispatchEvent(
          new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true }),
        );
      } else
        container.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, composed: true }));
    });
    expect(shadow.querySelector("[data-selected-line]")).toBeNull();
    expect(container.querySelector('[aria-label="File comment"]') === null).toBe(
      reason === "escape",
    );
  }
});

it("shows the Files comment toolbar when the same gutter lines are selected after an edit", async () => {
  const { instance } = await renderFiles("one\ntwo\nthree\n");
  await selectGutterLines();
  expect(container.querySelector('[aria-label="File comment"]')?.textContent).toBe(
    "Comment on L1 to L2",
  );
  instance.setSelections([
    { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, direction: "none" },
  ]);
  await act(async () => typeText(content(), "edited "));
  expect(container.querySelector('[aria-label="File comment"]')).toBeNull();
  await selectGutterLines();
  expect(container.querySelector('[aria-label="File comment"]')?.textContent).toBe(
    "Comment on L1 to L2",
  );
});

it("uses native dismissal, leaves save shortcuts alone, and remounts on a theme change", async () => {
  const onSelectionChange = vi.fn();
  const props: CodeViewEditorProps = {
    documentId: "app.ts",
    path: "app.ts",
    contents: "one\ntwo\n",
    onChange: vi.fn(),
    onSelectionChange,
  };
  await act(async () => root.render(<HostCodeEditor {...props} />));
  await editorReady();
  await act(async () => {});
  const editor = content();
  const save = new KeyboardEvent("keydown", {
    key: "s",
    metaKey: true,
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  editor.dispatchEvent(save);
  expect(save.defaultPrevented).toBe(false);
  editor.focus();
  const escape = new KeyboardEvent("keydown", {
    key: "Escape",
    bubbles: true,
    composed: true,
    cancelable: true,
  });
  editor.dispatchEvent(escape);
  expect(escape.defaultPrevented).toBe(true);
  expect(
    editor.getRootNode() instanceof ShadowRoot &&
      (editor.getRootNode() as ShadowRoot).activeElement === editor,
  ).toBe(false);
  const original = container.querySelector("diffs-container");
  await act(async () => {
    themeStore.setAppearanceMode("dark");
  });
  expect(container.querySelector("diffs-container")).not.toBe(original);
  await act(async () => {
    themeStore.setAppearanceMode("light");
  });
});

it("reports repeated text selections but dedupes empty selections after pointer dismissal", async () => {
  const fileReads = vi.spyOn(Editor.prototype, "getFile");
  const onSelectionChange = vi.fn();
  await act(async () =>
    root.render(
      <HostCodeEditor
        documentId="app.ts"
        path="app.ts"
        contents={"one\ntwo\n"}
        onChange={vi.fn()}
        onSelectionChange={onSelectionChange}
      />,
    ),
  );
  await editorReady();
  await act(async () => {});
  const editor = content();
  const instance = fileReads.mock.contexts.at(-1) as Editor<unknown>;
  instance.setSelections([
    { start: { line: 0, character: 1 }, end: { line: 2, character: 0 }, direction: "backward" },
  ]);
  await act(async () =>
    editor.dispatchEvent(new Event("pointerup", { bubbles: true, composed: true })),
  );
  expect(onSelectionChange).toHaveBeenCalledExactlyOnceWith({ startLine: 1, endLine: 2 });
  await act(async () =>
    editor.dispatchEvent(
      new KeyboardEvent("keyup", { key: "Shift", bubbles: true, composed: true }),
    ),
  );
  expect(onSelectionChange).toHaveBeenCalledTimes(2);
  expect(onSelectionChange).toHaveBeenLastCalledWith({ startLine: 1, endLine: 2 });
  const outside = document.createElement("button");
  document.body.append(outside);
  await act(async () =>
    outside.dispatchEvent(new Event("pointerdown", { bubbles: true, composed: true })),
  );
  expect(onSelectionChange).toHaveBeenCalledTimes(2);
  expect(instance.getState().selections).toBeUndefined();
  outside.remove();
  await act(async () =>
    editor.dispatchEvent(new KeyboardEvent("keyup", { key: "a", bubbles: true, composed: true })),
  );
  expect(onSelectionChange).toHaveBeenCalledTimes(2);
  instance.setSelections([
    { start: { line: 0, character: 1 }, end: { line: 2, character: 0 }, direction: "backward" },
  ]);
  await act(async () =>
    editor.dispatchEvent(new Event("pointerup", { bubbles: true, composed: true })),
  );
  expect(onSelectionChange).toHaveBeenCalledTimes(3);
  expect(onSelectionChange).toHaveBeenLastCalledWith({ startLine: 1, endLine: 2 });
  instance.setSelections([
    { start: { line: 0, character: 0 }, end: { line: 0, character: 0 }, direction: "none" },
  ]);
  await act(async () =>
    editor.dispatchEvent(new Event("pointerup", { bubbles: true, composed: true })),
  );
  expect(onSelectionChange).toHaveBeenCalledTimes(4);
  expect(onSelectionChange).toHaveBeenLastCalledWith(null);
  await act(async () =>
    editor.dispatchEvent(new Event("pointerup", { bubbles: true, composed: true })),
  );
  expect(onSelectionChange).toHaveBeenCalledTimes(4);
});

it("reveals a restored line in editable Files on an editor-less host", async () => {
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(100);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(2000);
  const contents = Array.from({ length: 100 }, (_, index) => `line ${index + 1}`).join("\n");
  await mountFiles(contents, false, 40);
  expect(container.textContent).toContain("Native code editor unavailable");
  const fallback = container.querySelector("pre");
  expect(fallback?.textContent).toBe(contents);
  expect(fallback?.scrollTop).toBeGreaterThan(0);
});
