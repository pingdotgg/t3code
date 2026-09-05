import type * as NodeWorkerThreads from "node:worker_threads";
import {
  FileRenderer,
  getSharedHighlighter,
  type CodeViewScrollTarget,
  type FileContents,
} from "@pierre/diffs";
import { useWorkerPool, type CodeViewProps } from "@pierre/diffs/react";
import { WorkerPoolManager, type WorkerRequest, type WorkerResponse } from "@pierre/diffs/worker";
import {
  act,
  StrictMode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Ref,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  codeViewClassName: null as string | null,
  codeViewOptions: null as Record<string, unknown> | null,
  workers: [] as NodeWorkerThreads.Worker[],
  terminations: [] as Promise<number>[],
  requests: [] as WorkerRequest[],
  pools: new Map<WorkerPoolManager, Promise<void>>(),
  renderPools: [] as (WorkerPoolManager | undefined)[],
  failWorkers: false,
  holdInitialization: false,
  heldResponses: [] as (() => void)[],
  onInitializationHeld: undefined as (() => void) | undefined,
}));

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));

vi.mock("@pierre/diffs/worker/worker.js?worker", async () => {
  const { Worker } = await import("node:worker_threads");
  const moduleUrl = import.meta.resolve("@pierre/diffs/worker/worker.js");

  // Adapt only the transport. Pierre's real worker loads its WASM and produces every response.
  return {
    default: class {
      worker: NodeWorkerThreads.Worker;

      constructor() {
        if (testState.failWorkers) throw new Error("Worker creation failed");
        this.worker = new Worker(
          `const { parentPort, workerData } = require("node:worker_threads");
           globalThis.self = {
             addEventListener(type, listener) {
               if (type === "message") parentPort.on("message", data => listener({ data }));
               if (type === "error") process.on("uncaughtException", listener);
             }
           };
           globalThis.postMessage = data => parentPort.postMessage(data);
           import(workerData.moduleUrl);`,
          { eval: true, workerData: { moduleUrl }, execArgv: [] },
        );
        testState.workers.push(this.worker);
      }

      addEventListener(
        type: "message" | "error",
        listener: (event: { data: WorkerResponse } | Error) => void,
      ) {
        if (type === "error") {
          this.worker.on("error", listener);
          return;
        }
        this.worker.on("message", (data: WorkerResponse) => {
          const deliver = () => listener({ data });
          if (
            testState.holdInitialization &&
            data.type === "success" &&
            data.requestType === "initialize"
          ) {
            testState.heldResponses.push(deliver);
            if (testState.heldResponses.length === 2) testState.onInitializationHeld?.();
          } else {
            deliver();
          }
        });
      }

      postMessage(message: WorkerRequest) {
        testState.requests.push(message);
        this.worker.postMessage(message, []);
      }

      terminate() {
        testState.terminations.push(this.worker.terminate());
      }
    },
  };
});

vi.mock("@pierre/diffs/react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pierre/diffs/react")>()),
  CodeView: (props: CodeViewProps) => {
    testState.codeViewClassName = props.className ?? null;
    testState.codeViewOptions = props.options ? { ...props.options } : null;
    return props.items?.map((item) =>
      item.type === "file" ? <FileOutput key={item.id} file={item.file} /> : null,
    );
  },
}));

import { StyledDiffCodeView } from "./StyledDiffCodeView";
import { useCodeViewFileReveal } from "./useCodeViewFileReveal";

function FileOutput({ file }: { file: FileContents }) {
  const pool = useWorkerPool();
  const [html, setHtml] = useState("");
  useEffect(() => {
    testState.renderPools.push(pool);
    const renderer = new FileRenderer(
      { theme: "pierre-dark", preferredHighlighter: "shiki-wasm" },
      render,
      pool,
    );
    function render() {
      const result = renderer.renderFile(file);
      if (result) setHtml(renderer.renderFullHTML(result));
    }
    render();
    return () => renderer.cleanUp();
  }, [file, pool]);
  return <pre data-code-file={file.name}>{html}</pre>;
}

const files = [
  { name: "notes.txt", contents: "Plain text is ready.\n", cacheKey: "plain-text" },
  { name: "answer.ts", contents: "const answer = 42;\n", cacheKey: "typescript" },
] satisfies FileContents[];

function Views({ count }: { count: number }) {
  const [draft, setDraft] = useState("Draft");
  return (
    <>
      <button onClick={() => setDraft("Edited draft")}>{draft}</button>
      {files.slice(0, count).map((file) => (
        <StyledDiffCodeView key={file.name} items={[{ type: "file", id: file.name, file }]} />
      ))}
    </>
  );
}

function renderViews(count: number) {
  return (
    <StrictMode>
      <Views count={count} />
    </StrictMode>
  );
}

describe("StyledDiffCodeView", () => {
  beforeEach(() => {
    testState.codeViewClassName = null;
    testState.codeViewOptions = null;
  });

  it("always pairs the shared diff styling with its virtualized geometry", () => {
    const loadDiffFiles = vi.fn(async () => ({
      oldFile: { name: "before.ts", contents: "before\n" },
      newFile: { name: "after.ts", contents: "after\n" },
    }));
    renderToStaticMarkup(
      <StyledDiffCodeView
        className="min-h-0"
        items={[]}
        options={{ theme: "pierre-dark", stickyHeaders: true, loadDiffFiles }}
      />,
    );

    expect(testState.codeViewClassName).toBe(
      "diff-render-surface [--code-background:var(--background)] outline-none min-h-0",
    );
    expect(testState.codeViewOptions).toMatchObject({
      theme: "pierre-dark",
      stickyHeaders: true,
      loadDiffFiles,
      itemMetrics: {
        diffHeaderHeight: 32,
        hunkSeparatorHeight: 24,
        paddingTop: 0,
        paddingBottom: 8,
      },
      layout: { paddingTop: 0, paddingBottom: 0, gap: 0 },
    });
    expect(testState.codeViewOptions?.unsafeCSS).toEqual(
      expect.stringContaining("[data-unmodified-lines]::before"),
    );
    expect(testState.codeViewOptions?.unsafeCSS).toEqual(
      expect.stringContaining(")[data-expand-index]\n  [data-unmodified-lines]"),
    );
  });
});

describe("code-view worker lifecycle", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    testState.workers = [];
    testState.terminations = [];
    testState.requests = [];
    testState.pools.clear();
    testState.renderPools = [];
    testState.failWorkers = false;
    testState.holdInitialization = false;
    testState.heldResponses = [];
    testState.onInitializationHeld = undefined;
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { hardwareConcurrency: 2 });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      setImmediate(() => callback(0)),
    );
    vi.stubGlobal("cancelAnimationFrame", clearImmediate);
    const initialize = WorkerPoolManager.prototype.initialize;
    vi.spyOn(WorkerPoolManager.prototype, "initialize").mockImplementation(function (
      this: WorkerPoolManager,
      ...args
    ) {
      const pending = initialize.apply(this, args);
      testState.pools.set(this, pending);
      return pending;
    });
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    await vi.runOnlyPendingTimersAsync();
    await Promise.all(testState.terminations);
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts on demand, keeps quick reopens warm, and expires the last closed pool", async () => {
    await act(async () => {
      renderer = create(renderViews(0));
    });
    const mounted = renderer!;
    const button = mounted.root.findByType("button");
    expect(testState.workers).toHaveLength(0);
    expect(testState.pools.size).toBe(0);
    await act(async () => {
      (button.props as { onClick(): void }).onClick();
      mounted.update(renderViews(1));
    });
    const pool = [...testState.pools.keys()][0]!;
    await act(async () => testState.pools.get(pool));
    expect(pool.isInitialized()).toBe(true);
    expect(testState.workers).toHaveLength(2);
    expect(mounted.root.findByProps({ "data-code-file": "notes.txt" }).children.join("")).toContain(
      "Plain text is ready.",
    );
    expect(testState.requests.filter((request) => request.type === "file")).toHaveLength(0);

    await act(async () => mounted.update(renderViews(2)));
    await act(async () => pool.primeFileHighlightCache(files[1]!));
    expect(testState.pools.size).toBe(1);
    expect(testState.workers).toHaveLength(2);
    expect(new Set(testState.renderPools)).toEqual(new Set([pool]));
    expect(pool.getFileResultCache(files[1]!)).toBeDefined();
    expect(mounted.root.findByProps({ "data-code-file": "answer.ts" }).children.join("")).toContain(
      "answer",
    );

    await act(async () => mounted.update(renderViews(1)));
    expect(pool.getStats().totalWorkers).toBe(2);
    expect(testState.terminations).toHaveLength(0);
    await act(async () => mounted.update(renderViews(0)));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pool.getStats().totalWorkers).toBe(2);
    expect(testState.terminations).toHaveLength(0);

    await act(async () => mounted.update(renderViews(1)));
    expect(testState.pools.size).toBe(1);
    expect(testState.workers).toHaveLength(2);
    expect(mounted.root.findAllByProps({ role: "status" })).toHaveLength(0);
    expect(pool.getFileResultCache(files[1]!)).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pool.getStats().totalWorkers).toBe(2);

    await act(async () => mounted.update(renderViews(0)));
    await vi.advanceTimersByTimeAsync(30_000);
    await Promise.all(testState.terminations);
    expect(pool.getStats().totalWorkers).toBe(0);
    expect(testState.terminations).toHaveLength(2);

    await act(async () => mounted.update(renderViews(1)));
    const reopenedPool = [...testState.pools.keys()][1]!;
    await act(async () => testState.pools.get(reopenedPool));
    expect(reopenedPool.isInitialized()).toBe(true);
    expect(testState.workers).toHaveLength(4);
    expect(mounted.root.findByType("button")).toBe(button);
    expect(button.children).toEqual(["Edited draft"]);
    expect(mounted.root.findByProps({ "data-code-file": "notes.txt" }).children.join("")).toContain(
      "Plain text is ready.",
    );
  });

  it("renders through Pierre's main-thread fallback when worker creation fails", async () => {
    testState.failWorkers = true;
    await act(async () => {
      renderer = create(renderViews(1));
    });
    const pool = [...testState.pools.keys()][0]!;
    await act(async () => {
      await expect(testState.pools.get(pool)).rejects.toMatchObject({ _tag: "DiffWorkerError" });
      await getSharedHighlighter({
        themes: ["pierre-dark"],
        langs: ["text"],
        preferredHighlighter: "shiki-wasm",
      });
    });
    expect(pool.isWorkingPool()).toBe(false);
    expect(testState.workers).toHaveLength(0);
    expect(
      renderer!.root.findByProps({ "data-code-file": "notes.txt" }).children.join(""),
    ).toContain("Plain text is ready.");
  });

  it("keeps an initializing pool until its last view closes and ignores late responses", async () => {
    testState.holdInitialization = true;
    const held = new Promise<void>((resolve) => {
      testState.onInitializationHeld = resolve;
    });
    await act(async () => {
      renderer = create(renderViews(2));
    });
    const pool = [...testState.pools.keys()][0]!;
    const pending = testState.pools.get(pool)!;
    await held;
    expect(pool.isInitialized()).toBe(false);
    expect(testState.pools.size).toBe(1);
    expect(renderer!.root.findAllByProps({ role: "status" })).toHaveLength(2);
    expect(testState.renderPools).toHaveLength(0);

    await act(async () => renderer!.update(renderViews(1)));
    expect(pool.getStats().totalWorkers).toBe(2);
    expect(testState.terminations).toHaveLength(0);
    await act(async () => renderer!.update(renderViews(0)));
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
    await Promise.all(testState.terminations);
    await act(async () => {
      for (const deliver of testState.heldResponses) deliver();
    });
    expect(pool.getStats().totalWorkers).toBe(0);
    expect(testState.workers).toHaveLength(2);
    expect(testState.terminations).toHaveLength(2);
    expect(testState.renderPools).toHaveLength(0);
    expect(renderer!.root.findAllByType("pre")).toHaveLength(0);
  });
});

type RevealHandle = NonNullable<Parameters<typeof useCodeViewFileReveal>[0]>;
const revealCalls: {
  scope: string;
  fileKey: string;
  mounted: boolean;
  collapsed: boolean | undefined;
}[] = [];

function RevealViewer({
  viewerRef,
  scope,
  collapsed,
}: {
  viewerRef: Ref<RevealHandle>;
  scope: string;
  collapsed: boolean;
}) {
  const instance = useRef<{ collapsed: boolean } | undefined>(undefined);
  useLayoutEffect(() => {
    instance.current = { collapsed };
    return () => {
      instance.current = undefined;
    };
  }, [collapsed]);
  const handle = useMemo(
    () => ({
      getInstance: () => instance.current,
      scrollTo: (target: CodeViewScrollTarget) => {
        if (target.type !== "item") return;
        revealCalls.push({
          scope,
          fileKey: target.id,
          mounted: instance.current !== undefined,
          collapsed: instance.current?.collapsed,
        });
      },
    }),
    [scope],
  );
  useImperativeHandle(viewerRef, () => handle, [handle]);
  return null;
}

function RevealViews({
  scope,
  visible,
  selectedFile = null,
  requestId = 0,
}: {
  scope: string;
  visible: boolean;
  selectedFile?: string | null;
  requestId?: number;
}) {
  const [viewer, setViewer] = useState<RevealHandle | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const selectedRequest = useMemo(() => ({ selectedFile, requestId }), [requestId, selectedFile]);
  useEffect(() => {
    if (!selectedRequest.selectedFile || !viewer?.getInstance()) return;
    viewer.scrollTo({ type: "item", id: selectedRequest.selectedFile, align: "start" });
  }, [selectedRequest, viewer]);
  const revealScope = useMemo(() => ({ scope, selectedRequest }), [scope, selectedRequest]);
  const requestReveal = useCodeViewFileReveal(viewer, revealScope);
  return (
    <>
      {visible && (
        <RevealViewer key={scope} viewerRef={setViewer} scope={scope} collapsed={collapsed} />
      )}
      <button
        onClick={() => {
          setCollapsed(false);
          requestReveal("tree-file");
        }}
      >
        Reveal file
      </button>
    </>
  );
}

describe("code-view file reveals", () => {
  let renderer: ReactTestRenderer | undefined;

  beforeEach(() => {
    revealCalls.length = 0;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it("does not replay a handled tree click or scroll an old handle when a selected file remounts the view", async () => {
    await act(async () => {
      renderer = create(<RevealViews scope="first" visible selectedFile="external-a" />);
    });
    await act(async () => {
      (renderer!.root.findByType("button").props as { onClick(): void }).onClick();
    });
    expect(revealCalls.at(-1)?.fileKey).toBe("tree-file");
    revealCalls.length = 0;

    await act(async () => {
      renderer!.update(
        <RevealViews scope="second" visible selectedFile="external-b" requestId={1} />,
      );
    });
    expect(revealCalls).toEqual([
      { scope: "second", fileKey: "external-b", mounted: true, collapsed: false },
    ]);
  });

  it("waits for a live viewer and applies each pending tree click only once", async () => {
    await act(async () => {
      renderer = create(<RevealViews scope="diff" visible={false} selectedFile="external" />);
    });
    await act(async () => {
      (renderer!.root.findByType("button").props as { onClick(): void }).onClick();
    });
    expect(revealCalls).toEqual([]);

    await act(async () => {
      renderer!.update(<RevealViews scope="diff" visible selectedFile="external" />);
    });
    expect(revealCalls.map((call) => call.fileKey)).toEqual(["external", "tree-file"]);
    revealCalls.length = 0;
    await act(async () => {
      renderer!.update(<RevealViews scope="diff" visible={false} selectedFile="external" />);
    });
    await act(async () => {
      renderer!.update(<RevealViews scope="diff" visible selectedFile="external" />);
    });
    expect(revealCalls).toEqual([
      { scope: "diff", fileKey: "external", mounted: true, collapsed: false },
    ]);

    revealCalls.length = 0;
    await act(async () => {
      (renderer!.root.findByType("button").props as { onClick(): void }).onClick();
      renderer!.update(<RevealViews scope="diff" visible={false} selectedFile="external" />);
    });
    expect(revealCalls).toEqual([]);
    await act(async () => {
      renderer!.update(<RevealViews scope="diff" visible selectedFile="external" />);
    });
    expect(revealCalls).toEqual([
      { scope: "diff", fileKey: "external", mounted: true, collapsed: false },
      { scope: "diff", fileKey: "tree-file", mounted: true, collapsed: false },
    ]);
  });

  it("cancels pending tree clicks when an external selection or diff scope changes", async () => {
    await act(async () => {
      renderer = create(<RevealViews scope="first" visible={false} selectedFile="external-a" />);
    });
    await act(async () => {
      (renderer!.root.findByType("button").props as { onClick(): void }).onClick();
    });
    await act(async () => {
      renderer!.update(
        <RevealViews scope="first" visible selectedFile="external-b" requestId={1} />,
      );
    });
    expect(revealCalls.map((call) => call.fileKey)).toEqual(["external-b"]);
    revealCalls.length = 0;

    await act(async () => renderer!.update(<RevealViews scope="first" visible={false} />));
    await act(async () => {
      (renderer!.root.findByType("button").props as { onClick(): void }).onClick();
    });
    await act(async () => renderer!.update(<RevealViews scope="second" visible={false} />));
    await act(async () => renderer!.update(<RevealViews scope="first" visible />));
    expect(revealCalls).toEqual([]);
  });

  it("reveals after a collapsed file expands and honors another click on the same file", async () => {
    await act(async () => {
      renderer = create(<RevealViews scope="diff" visible />);
    });
    const reveal = renderer!.root.findByType("button").props as { onClick(): void };
    await act(async () => reveal.onClick());
    await act(async () => reveal.onClick());
    expect(revealCalls).toEqual([
      { scope: "diff", fileKey: "tree-file", mounted: true, collapsed: false },
      { scope: "diff", fileKey: "tree-file", mounted: true, collapsed: false },
    ]);
  });
});
