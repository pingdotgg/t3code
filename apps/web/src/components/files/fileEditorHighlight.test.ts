import {
  FileRenderer,
  getSharedHighlighter,
  type BaseCodeOptions,
  type DiffsHighlighter,
  type FileContents,
  type HighlightedToken,
  type RenderRange,
} from "@pierre/diffs";
import { TextDocument } from "@pierre/diffs/editor";
import { WorkerPoolManager, type WorkerRequest, type WorkerResponse } from "@pierre/diffs/worker";
import * as NodeWorkerThreads from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type DocumentChange = NonNullable<ReturnType<TextDocument<unknown>["applyEdits"]>>;
interface Tokenizer {
  readonly themeType: "light" | "dark";
  tokenize(change: DocumentChange, range: RenderRange): Map<number, HighlightedToken[]>;
  cleanUp(): void;
}

// This dependency-internal tokenizer is the one used by Editor.#rerender.
const tokenizerUrl = new URL("./editor/tokenizer.js", import.meta.resolve("@pierre/diffs"));
const { EditorTokenizer } = (await import(/* @vite-ignore */ tokenizerUrl.href)) as {
  EditorTokenizer: new (options: {
    codeOptions: BaseCodeOptions;
    highlighter: DiffsHighlighter;
    textDocument: TextDocument<unknown>;
    setStyle: (style: string) => void;
    onDeferTokenize: (lines: Map<number, HighlightedToken[]>, theme: "light" | "dark") => void;
  }) => Tokenizer;
};

const workerModule = import.meta.resolve("@pierre/diffs/worker/worker.js");
const source = Array.from(
  { length: 7_000 },
  (_, index) =>
    `export const section${index} = <p>Long wrapped source line ${index} for the file editor.</p>;`,
).join("\n");
const options = {
  theme: "pierre-dark",
  themeType: "dark",
  preferredHighlighter: "shiki-wasm",
  useTokenTransformer: true,
  overflow: "wrap",
  disableFileHeader: true,
} as const;
const range: RenderRange = {
  startingLine: 6_950,
  totalLines: 150,
  bufferBefore: 0,
  bufferAfter: 0,
};

interface HeldResponse {
  data: WorkerResponse;
  deliver: () => void;
}
let responses: HeldResponse[];
let responseWaiters: ((response: HeldResponse) => void)[];
let terminationPromises: Promise<number>[];
let pool: WorkerPoolManager;
let renderer: FileRenderer;
let tokenizer: Tokenizer;
let file: FileContents;
let document: TextDocument<unknown>;
const animationFrames = new Set<ReturnType<typeof setImmediate>>();

function nextResponse(): Promise<HeldResponse> {
  const response = responses.shift();
  return response
    ? Promise.resolve(response)
    : new Promise((resolve) => responseWaiters.push(resolve));
}

class WorkerTransport {
  private readonly worker = new NodeWorkerThreads.Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     globalThis.self = {
       addEventListener(type, listener) {
         if (type === "message") parentPort.on("message", data => listener({ data }));
         if (type === "error") process.on("uncaughtException", listener);
       }
     };
     globalThis.postMessage = data => parentPort.postMessage(data);
     import(workerData.moduleUrl);`,
    { eval: true, workerData: { moduleUrl: workerModule }, execArgv: [] },
  );

  addEventListener(
    type: "message" | "error",
    listener: (event: { data: WorkerResponse } | Error) => void,
  ) {
    if (type === "error") {
      this.worker.on("error", listener);
      return;
    }
    this.worker.on("message", (data: WorkerResponse) => {
      const response = { data, deliver: () => listener({ data }) };
      if (data.type !== "success" || data.requestType !== "file") {
        response.deliver();
        return;
      }
      const waiter = responseWaiters.shift();
      if (waiter) waiter(response);
      else responses.push(response);
    });
  }

  postMessage(message: WorkerRequest) {
    this.worker.postMessage(message, []);
  }

  terminate() {
    terminationPromises.push(this.worker.terminate());
  }
}

function applyChange(change: DocumentChange) {
  // Keep the installed editor's non-DOM order, including the existing contents patch.
  renderer.updateRenderCache(tokenizer.tokenize(change, range), tokenizer.themeType);
  file.contents = document.getText();
  if (change.lineDelta !== 0) renderer.applyDocumentChange(document);
}

function append(text: string) {
  const position = document.positionAt(document.getText().length);
  const change = document.applyEdits([
    { range: { start: position, end: position }, newText: text },
  ]);
  expect(change).toBeDefined();
  applyChange(change!);
}

function undo() {
  const change = document.undo()?.[0];
  expect(change).toBeDefined();
  applyChange(change!);
}

function renderContents() {
  const result = renderer.renderFile(file, range);
  expect(result?.totalLines).toBe(document.lineCount);
  return renderer.renderFullHTML(result!);
}

beforeEach(async () => {
  responses = [];
  responseWaiters = [];
  terminationPromises = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const frame = setImmediate(() => {
      animationFrames.delete(frame);
      callback(0);
    });
    animationFrames.add(frame);
    return frame;
  });
  vi.stubGlobal("cancelAnimationFrame", (frame: ReturnType<typeof setImmediate>) => {
    animationFrames.delete(frame);
    clearImmediate(frame);
  });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
  pool = new WorkerPoolManager(
    // Adapt browser transport only; Pierre's real worker produces each response.
    { workerFactory: () => new WorkerTransport() as unknown as globalThis.Worker, poolSize: 1 },
    options,
  );
  await pool.initialize(["tsx"]);
  const highlighter = await getSharedHighlighter({
    themes: ["pierre-dark"],
    langs: ["tsx"],
    preferredHighlighter: "shiki-wasm",
  });
  file = { name: "wrapped.tsx", contents: source, cacheKey: "editable-file" };
  document = new TextDocument(file.name, source, "tsx");
  renderer = new FileRenderer(options, () => {}, pool);
  tokenizer = new EditorTokenizer({
    codeOptions: options,
    highlighter,
    textDocument: document,
    setStyle: () => {},
    onDeferTokenize: (lines, theme) => renderer.updateRenderCache(lines, theme),
  });
  renderContents();
});

async function cleanUpFixture() {
  tokenizer?.cleanUp();
  renderer?.cleanUp();
  pool?.terminate();
  await Promise.all(terminationPromises);
  // Pool termination can queue a final broadcast after its workers have exited.
  for (const frame of animationFrames) clearImmediate(frame);
  animationFrames.clear();
  vi.unstubAllGlobals();
}

afterEach(cleanUpFixture);

describe("editable file highlighting", () => {
  it("cleans up an already terminated worker pool", async () => {
    (await nextResponse()).deliver();
    expect(pool.getStats().totalWorkers).toBe(1);
    pool.terminate();
    await Promise.all(terminationPromises);
    expect(pool.getStats().totalWorkers).toBe(0);

    const animationFrame = globalThis.requestAnimationFrame;
    const cancelFrame = globalThis.cancelAnimationFrame;
    const window = globalThis.window;
    try {
      await cleanUpFixture();
      // Deliver the real Immediate queue after cleanup has removed the browser globals.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      vi.stubGlobal("requestAnimationFrame", animationFrame);
      vi.stubGlobal("cancelAnimationFrame", cancelFrame);
      vi.stubGlobal("window", window);
    }
  });

  it("still accepts an asynchronous highlight when the file has not changed", async () => {
    expect(renderContents()).not.toContain('style="color:');
    (await nextResponse()).deliver();
    expect(renderContents()).toContain('style="color:');
    expect(pool.getFileResultCache(file)).toBeDefined();
  });

  it.each([1, 60])(
    "ignores a dispatched highlight after %i Enter edits and highlights the new version",
    async (count) => {
      const oldResponse = await nextResponse();
      for (let index = 0; index < count; index += 1) append("\n");
      append("export const EDITED_MARKER = 1;");
      oldResponse.deliver();
      expect(renderContents()).toContain("EDITED_MARKER");
      const currentResponse = await nextResponse();
      currentResponse.deliver();
      expect(renderContents()).toContain("EDITED_MARKER");
      const firstLines = renderer.renderFile(file, { ...range, startingLine: 0, totalLines: 20 });
      expect(renderer.renderFullHTML(firstLines!)).toContain('style="color:');
      expect(document.lineCount).toBe(7_000 + count);
    },
  );

  it("does not replace a same-line edit with stale tokens", async () => {
    const oldResponse = await nextResponse();
    append(" EDITED_MARKER");
    oldResponse.deliver();
    expect(renderContents()).toContain("EDITED_MARKER");
    expect(document.lineCount).toBe(7_000);
    (await nextResponse()).deliver();
    expect(renderContents()).toContain("EDITED_MARKER");
  });

  it("keeps undo edits after an older highlight arrives", async () => {
    const oldResponse = await nextResponse();
    append("\nexport const RETAINED_MARKER = 1;");
    append("\nexport const UNDONE_MARKER = 2;");
    undo();
    oldResponse.deliver();
    const html = renderContents();
    expect(html).toContain("RETAINED_MARKER");
    expect(html).not.toContain("UNDONE_MARKER");
    (await nextResponse()).deliver();
    expect(renderContents()).toContain("RETAINED_MARKER");
    undo();
    expect(document.getText()).toBe(source);
    expect(renderContents()).not.toContain("RETAINED_MARKER");
    const redone = document.redo()?.[0];
    expect(redone).toBeDefined();
    applyChange(redone!);
    expect(renderContents()).toContain("RETAINED_MARKER");
  });

  it("evicts the pre-edit shared cache without losing already-highlighted lines", async () => {
    (await nextResponse()).deliver();
    expect(pool.getFileResultCache(file)).toBeDefined();
    append("\nexport const EDITED_MARKER = 1;");
    expect(pool.getFileResultCache(file)).toBeUndefined();
    expect(renderContents()).toContain("EDITED_MARKER");
    const firstLines = renderer.renderFile(file, { ...range, startingLine: 0, totalLines: 20 });
    expect(renderer.renderFullHTML(firstLines!)).toContain('style="color:');
  });

  it("reopens the edited file with the same cache key while an old response is pending", async () => {
    const oldResponse = await nextResponse();
    append("\nexport const REOPENED_MARKER = 1;");
    renderer.cleanUp();
    renderer = new FileRenderer(options, () => {}, pool);
    file = { ...file };
    expect(renderContents()).toContain("REOPENED_MARKER");
    oldResponse.deliver();
    (await nextResponse()).deliver();
    expect(renderContents()).toContain("REOPENED_MARKER");
    expect(renderContents()).toContain('style="color:');
  });
});
