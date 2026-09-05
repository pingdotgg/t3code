import {
  FileRenderer,
  disposeHighlighter,
  getSharedHighlighter,
  type BaseCodeOptions,
  type DiffsHighlighter,
  type FileContents,
  type HighlightedToken,
} from "@pierre/diffs";
import { TextDocument } from "@pierre/diffs/editor";
import { WorkerPoolManager, type WorkerRequest, type WorkerResponse } from "@pierre/diffs/worker";
import * as NodeWorkerThreads from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

type DocumentChange = NonNullable<ReturnType<TextDocument<unknown>["applyEdits"]>>;
interface Tokenizer {
  tokenize(change: DocumentChange): Map<number, HighlightedToken[]>;
  cleanUp(): void;
}

const tokenizerUrl = new URL("./editor/tokenizer.js", import.meta.resolve("@pierre/diffs"));
const { EditorTokenizer } = (await import(/* @vite-ignore */ tokenizerUrl.href)) as {
  EditorTokenizer: new (options: {
    codeOptions: BaseCodeOptions;
    highlighter: DiffsHighlighter;
    textDocument: TextDocument<unknown>;
    setStyle: (style: string) => void;
    onDeferTokenize: () => void;
  }) => Tokenizer;
};

const workerModule = import.meta.resolve("@pierre/diffs/worker/worker.js");
const options = {
  theme: "pierre-dark",
  themeType: "dark",
  preferredHighlighter: "shiki-wasm",
  useTokenTransformer: true,
} as const;
const source = "export const View = () => <div>Ready</div>;";
let pool: WorkerPoolManager;
let renderer: FileRenderer;
let terminationPromises: Promise<number>[];

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
    if (type === "error") this.worker.on("error", listener);
    else this.worker.on("message", (data: WorkerResponse) => listener({ data }));
  }

  postMessage(message: WorkerRequest) {
    this.worker.postMessage(message, []);
  }

  terminate() {
    terminationPromises.push(this.worker.terminate());
  }
}

function firstEnter(highlighter: DiffsHighlighter, file: FileContents, language: string) {
  const document = new TextDocument(file.name, file.contents, language);
  const tokenizer = new EditorTokenizer({
    codeOptions: options,
    highlighter,
    textDocument: document,
    setStyle: () => {},
    onDeferTokenize: () => {},
  });
  try {
    const end = document.positionAt(file.contents.length);
    const change = document.applyEdits([{ range: { start: end, end }, newText: "\n" }]);
    expect(change).toBeDefined();
    // This is the synchronous first edit, before the tokenizer's debounced prebuild.
    const dirtyLines = tokenizer.tokenize(change!);
    expect([...dirtyLines.keys()]).toEqual([0, 1]);
    expect(document.getText()).toBe(`${file.contents}\n`);
  } finally {
    tokenizer.cleanUp();
  }
}

beforeEach(async () => {
  terminationPromises = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setImmediate(() => callback(0)),
  );
  vi.stubGlobal("cancelAnimationFrame", clearImmediate);
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
  await disposeHighlighter();
  pool = new WorkerPoolManager(
    // Adapt transport only. The installed Pierre worker resolves and highlights the file.
    { workerFactory: () => new WorkerTransport() as unknown as globalThis.Worker, poolSize: 1 },
    options,
  );
  await pool.initialize();
  renderer = new FileRenderer(options, undefined, pool);
});

afterEach(async () => {
  renderer?.cleanUp();
  pool?.terminate();
  await Promise.all(terminationPromises);
  await disposeHighlighter();
  vi.unstubAllGlobals();
});

describe("editable file language readiness", () => {
  it.each(["hydrate", "renderFile"] as const)(
    "%s prepares the inferred language before the first edit of a worker-highlighted file",
    async (method) => {
      const file = { name: "cold.tsx", contents: source, cacheKey: "cold-tsx" };
      await pool.primeFileHighlightCache(file);
      expect(pool.getFileResultCache(file)).toBeDefined();
      const mainHighlighter = await getSharedHighlighter({
        themes: ["pierre-dark"],
        langs: ["text"],
      });
      expect(mainHighlighter.getLoadedLanguages()).not.toContain("tsx");
      renderer[method](file);
      // Read-only worker rendering must not load editor grammars on the main thread.
      expect(mainHighlighter.getLoadedLanguages()).not.toContain("tsx");
      const highlighter = await renderer.initializeHighlighter();
      firstEnter(highlighter, file, "tsx");
    },
  );

  it.each(["hydrate", "renderFile"] as const)(
    "%s respects an explicit language when the filename suggests plain text",
    async (method) => {
      const file: FileContents = {
        name: "source.txt",
        lang: "tsx",
        contents: source,
        cacheKey: "explicit-tsx",
      };
      await pool.primeFileHighlightCache(file);
      renderer[method](file);
      firstEnter(await renderer.initializeHighlighter(), file, "tsx");
    },
  );

  it("loads a newly opened language after reusing a worker-backed renderer", async () => {
    const previousFile: FileContents = {
      name: "previous.ts",
      contents: "export const value = 1;",
      cacheKey: "previous-ts",
    };
    await getSharedHighlighter({ themes: ["pierre-dark"], langs: ["typescript"] });
    renderer.renderFile(previousFile);
    firstEnter(await renderer.initializeHighlighter(), previousFile, "typescript");
    const nextFile = { name: "next.tsx", contents: source, cacheKey: "next-tsx" };
    renderer.renderFile(nextFile);
    firstEnter(await renderer.initializeHighlighter(), nextFile, "tsx");
  });

  it("prepares a hydrated non-worker file even when its theme was already loaded", async () => {
    renderer.cleanUp();
    renderer = new FileRenderer(options);
    const file = { name: "local.tsx", contents: source, cacheKey: "local-tsx" };
    renderer.hydrate(file);
    firstEnter(await renderer.initializeHighlighter(), file, "tsx");
  });

  it("keeps plain text editable without loading an unrelated grammar", async () => {
    const file = { name: "notes.txt", contents: "Plain text", cacheKey: "plain-text" };
    renderer.renderFile(file);
    const highlighter = await renderer.initializeHighlighter();
    firstEnter(highlighter, file, "text");
    expect(highlighter.getLoadedLanguages()).not.toContain("tsx");
  });
});
