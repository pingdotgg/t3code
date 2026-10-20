import {
  CodeView,
  FileDiff,
  FileRenderer,
  getSharedHighlighter,
  type CodeViewItem,
  type CodeViewScrollTarget,
  type FileContents,
} from "@pierre/diffs";
import { useWorkerPool, type CodeViewProps } from "@pierre/diffs/react";
import { WorkerPoolManager, type WorkerRequest, type WorkerResponse } from "@pierre/diffs/worker";
import DiffsWorker from "@pierre/diffs/worker/worker.js?worker";
import { getDiffLineStat, getRenderablePatch } from "../../lib/diffRendering";
import {
  act,
  StrictMode,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  workers: [] as Worker[],
  terminations: 0,
  requests: [] as WorkerRequest[],
  pools: new Map<WorkerPoolManager, Promise<void>>(),
  renderPools: [] as (WorkerPoolManager | undefined)[],
  failWorkers: false,
  holdInitialization: false,
  heldResponses: [] as (() => void)[],
  onInitializationHeld: undefined as (() => void) | undefined,
}));

vi.mock(import("../../hooks/useTheme"), async (original) => ({
  ...(await original()),
  useRenderedAppearance: (() => "dark") as never,
}));

// Wraps Pierre's real worker so the suite can count workers, read requests and hold startup.
// Vite's `?worker` export is a factory that returns a plain Worker, so this patches the instance.
vi.mock("@pierre/diffs/worker/worker.js?worker", async (original) => {
  const actual = await original<{ default: new () => Worker }>();
  return {
    ...actual,
    default: function TestDiffsWorker() {
      if (testState.failWorkers) throw new Error("Worker creation failed");
      const worker = new actual.default();
      testState.workers.push(worker);
      const addEventListener = worker.addEventListener.bind(worker);
      const postMessage = worker.postMessage.bind(worker);
      const terminate = worker.terminate.bind(worker);
      worker.addEventListener = (type: string, listener: EventListenerOrEventListenerObject) => {
        if (type !== "message" || typeof listener !== "function") {
          addEventListener(type, listener);
          return;
        }
        addEventListener("message", (event) => {
          const data = (event as MessageEvent<WorkerResponse>).data;
          const deliver = () => listener(event);
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
      };
      worker.postMessage = (message: WorkerRequest) => {
        testState.requests.push(message);
        postMessage(message);
      };
      worker.terminate = () => {
        testState.terminations += 1;
        terminate();
      };
      return worker;
    },
  };
});

// Pierre's real viewer virtualizes into a shadow root; this stand-in renders each file through
// the same worker pool and keeps the highlighted HTML readable.
vi.mock(import("@pierre/diffs/react"), async (original) => ({
  ...(await original()),
  CodeView: ((props: CodeViewProps<undefined, undefined>) =>
    props.items?.map((item) =>
      item.type === "file" ? <FileOutput key={item.id} file={item.file} /> : null,
    )) as never,
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
      undefined,
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

const roots: Root[] = [];

function mount(element: ReactElement) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  return {
    root,
    render: (next: ReactElement) => act(async () => root.render(next)),
    initial: act(async () => root.render(element)),
  };
}

async function unmountAll() {
  for (const root of roots.splice(0)) await act(async () => root.unmount());
  document.body.replaceChildren();
}

const codeFile = (name: string) =>
  document.querySelector(`[data-code-file="${name}"]`)?.textContent ?? "";
const loadingViews = () => document.querySelectorAll('[role="status"]').length;

describe("code-view worker lifecycle", () => {
  beforeEach(() => {
    testState.workers = [];
    testState.terminations = 0;
    testState.requests = [];
    testState.pools.clear();
    testState.renderPools = [];
    testState.failWorkers = false;
    testState.holdInitialization = false;
    testState.heldResponses = [];
    testState.onInitializationHeld = undefined;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    // Pins the pool at two workers whatever machine runs the suite.
    Object.defineProperty(navigator, "hardwareConcurrency", { configurable: true, value: 2 });
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
    if (!vi.isFakeTimers()) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await unmountAll();
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    delete (navigator as { hardwareConcurrency?: number }).hardwareConcurrency;
  });

  it("starts on demand, keeps quick reopens warm, and expires the last closed pool", async () => {
    const view = mount(renderViews(0));
    await view.initial;
    const button = document.querySelector("button")!;
    expect(testState.workers).toHaveLength(0);
    expect(testState.pools.size).toBe(0);
    await act(async () => button.click());
    await view.render(renderViews(1));
    const pool = [...testState.pools.keys()][0]!;
    await act(async () => testState.pools.get(pool));
    expect(pool.isInitialized()).toBe(true);
    expect(testState.workers).toHaveLength(2);
    await vi.waitFor(() => expect(codeFile("notes.txt")).toContain("Plain text is ready."));
    expect(testState.requests.filter((request) => request.type === "file")).toHaveLength(0);

    await view.render(renderViews(2));
    await act(async () => pool.primeFileHighlightCache(files[1]!));
    expect(testState.pools.size).toBe(1);
    expect(testState.workers).toHaveLength(2);
    expect(new Set(testState.renderPools)).toEqual(new Set([pool]));
    expect(pool.getFileResultCache(files[1]!)).toBeDefined();
    await vi.waitFor(() => expect(codeFile("answer.ts")).toContain("answer"));

    // Worker startup uses real time. Only advance the clock once highlighting
    // has finished, so idle expiry cannot also expire a worker startup timer.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await view.render(renderViews(1));
    expect(pool.getStats().totalWorkers).toBe(2);
    expect(testState.terminations).toBe(0);
    await view.render(renderViews(0));
    await vi.advanceTimersByTimeAsync(29_999);
    expect(pool.getStats().totalWorkers).toBe(2);
    expect(testState.terminations).toBe(0);

    await view.render(renderViews(1));
    expect(testState.pools.size).toBe(1);
    expect(testState.workers).toHaveLength(2);
    expect(loadingViews()).toBe(0);
    expect(pool.getFileResultCache(files[1]!)).toBeDefined();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pool.getStats().totalWorkers).toBe(2);

    await view.render(renderViews(0));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(pool.getStats().totalWorkers).toBe(0);
    expect(testState.terminations).toBe(2);

    vi.useRealTimers();
    await view.render(renderViews(1));
    const reopenedPool = [...testState.pools.keys()][1]!;
    await act(async () => testState.pools.get(reopenedPool));
    expect(reopenedPool.isInitialized()).toBe(true);
    expect(testState.workers).toHaveLength(4);
    expect(document.querySelector("button")).toBe(button);
    expect(button.textContent).toBe("Edited draft");
    await vi.waitFor(() => expect(codeFile("notes.txt")).toContain("Plain text is ready."));
  });

  it("renders through Pierre's main-thread fallback when worker creation fails", async () => {
    testState.failWorkers = true;
    await mount(renderViews(1)).initial;
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
    await vi.waitFor(() => expect(codeFile("notes.txt")).toContain("Plain text is ready."));
  });

  it("keeps an initializing pool until its last view closes and ignores late responses", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    testState.holdInitialization = true;
    const held = new Promise<void>((resolve) => {
      testState.onInitializationHeld = resolve;
    });
    const view = mount(renderViews(2));
    await view.initial;
    const pool = [...testState.pools.keys()][0]!;
    const pending = testState.pools.get(pool)!;
    await held;
    expect(pool.isInitialized()).toBe(false);
    expect(testState.pools.size).toBe(1);
    expect(loadingViews()).toBe(2);
    expect(testState.renderPools).toHaveLength(0);

    await view.render(renderViews(1));
    expect(pool.getStats().totalWorkers).toBe(2);
    expect(testState.terminations).toBe(0);
    await view.render(renderViews(0));
    // Pierre gives up on a held startup after 10 seconds; the idle timer then tears the pool down.
    const timedOut = expect(pending).rejects.toThrow("worker initialization timed out");
    await vi.advanceTimersByTimeAsync(30_000);
    await timedOut;
    await act(async () => {
      for (const deliver of testState.heldResponses) deliver();
    });
    expect(pool.getStats().totalWorkers).toBe(0);
    expect(testState.workers).toHaveLength(2);
    expect(testState.terminations).toBe(2);
    expect(testState.renderPools).toHaveLength(0);
    expect(document.querySelectorAll("pre")).toHaveLength(0);
  });
});

describe("collapsed diff content", () => {
  let pool: WorkerPoolManager;
  let container: HTMLDivElement;
  let viewer: FileDiff<string> | CodeView<string> | undefined;

  const loadedDiff = () => {
    const parsed = getRenderablePatch(
      [
        "diff --git a/before.ts b/after.ts",
        "similarity index 50%",
        "rename from before.ts",
        "rename to after.ts",
        "--- a/before.ts",
        "+++ b/after.ts",
        "@@ -1,2 +1,2 @@",
        " const shared = 1;",
        "-const before = 2;",
        "+const after = 3;",
      ].join("\n"),
      "collapsed-content",
    );
    if (parsed?.kind !== "files" || !parsed.files[0]) throw new Error("Expected diff");
    return parsed.files[0];
  };
  const code = () =>
    [...container.querySelectorAll("diffs-container")]
      .flatMap((element) => [...(element.shadowRoot?.querySelectorAll("[data-line]") ?? [])])
      .map((line) => line.textContent)
      .join("\n");

  beforeEach(async () => {
    testState.requests = [];
    testState.failWorkers = false;
    testState.holdInitialization = false;
    pool = new WorkerPoolManager(
      { workerFactory: () => new DiffsWorker(), poolSize: 1 },
      { theme: "pierre-dark", langs: ["typescript"], preferredHighlighter: "shiki-wasm" },
    );
    await pool.initialize();
    container = document.createElement("div");
    container.style.cssText = "height: 400px; width: 800px; overflow: auto";
    document.body.append(container);
  });

  afterEach(() => {
    viewer?.cleanUp();
    viewer = undefined;
    pool.terminate();
    container.remove();
    vi.restoreAllMocks();
  });

  it("defers plain AST and highlight work across collapsed renders until expansion", async () => {
    const fileDiff = loadedDiff();
    const highlight = vi.spyOn(pool, "highlightDiffAST");
    const plainAST = vi.spyOn(pool, "getPlainDiffAST");
    const options = { theme: "pierre-dark", collapsed: true, disableErrorHandling: true } as const;
    const file = new FileDiff<string>(options, pool);
    viewer = file;
    file.render({ fileDiff, containerWrapper: container });
    file.render({ fileDiff, forceRender: true });
    expect.soft(highlight.mock.calls.length).toBe(0);
    expect.soft(plainAST.mock.calls.length).toBe(0);
    expect(code()).toBe("");
    expect(container.querySelector("diffs-container")?.shadowRoot?.textContent).toContain(
      "after.ts",
    );

    file.setOptions({ ...options, collapsed: false });
    file.render({ fileDiff, forceRender: true });
    expect(highlight).toHaveBeenCalled();
    await pool.primeDiffHighlightCache(fileDiff);
    await vi.waitFor(() => expect(code()).toContain("const after = 3;"));
    expect(code()).toContain("const before = 2;");
    expect(testState.requests.filter((request) => request.type === "diff")).toHaveLength(1);
  });

  it("finds newly loaded collapsed lines and unfolds the match with its annotation and header", async () => {
    const fileDiff = loadedDiff();
    const item: CodeViewItem<string> = {
      type: "diff",
      id: "renamed",
      fileDiff,
      collapsed: true,
      annotations: [{ side: "additions", lineNumber: 2, metadata: "Review this change" }],
    };
    const view = new CodeView<string>(
      {
        theme: "pierre-dark",
        disableErrorHandling: true,
        onRevealSearchMatch: (match) =>
          view.setItems([{ ...match, collapsed: false, version: (match.version ?? 0) + 1 }]),
        renderHeaderMetadata: (file) => {
          if (!("hunks" in file)) return;
          const metadata = document.createElement("span");
          const { additions, deletions } = getDiffLineStat([file]);
          metadata.textContent = "+" + additions + " / -" + deletions;
          return metadata;
        },
        renderAnnotation: (annotation) => {
          const note = document.createElement("span");
          note.textContent = annotation.metadata ?? "";
          return note;
        },
      },
      pool,
    );
    viewer = view;
    view.setup(container);
    view.openSearch();
    const search = container.querySelector("[data-diffs-search]")!.shadowRoot!;
    const input = search.querySelector<HTMLInputElement>("input[data-search]")!;
    input.value = "const after";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    view.setItems([item]);
    view.render(true);
    expect(code()).toBe("");
    expect(search.textContent).toContain("1 results");
    expect(container.textContent).toContain("+1 / -1");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    view.render(true);
    await vi.waitFor(() => expect(code()).toContain("const after = 3;"));
    expect(search.textContent).toContain("1 of 1");
    expect(container.textContent).toContain("Review this change");
    expect(container.textContent).toContain("+1 / -1");
    expect(container.querySelector("diffs-container")?.shadowRoot?.textContent).toContain(
      "after.ts",
    );

    await pool.primeDiffHighlightCache(fileDiff);
    view.render(true);
    const highlight = vi.spyOn(pool, "highlightDiffAST");
    const plainAST = vi.spyOn(pool, "getPlainDiffAST");
    const updatedDiff = { ...fileDiff, name: "updated.ts", cacheKey: "collapsed-update" };
    view.setItems([{ ...item, fileDiff: updatedDiff, version: 2 }]);
    view.render(true);
    expect(highlight).not.toHaveBeenCalled();
    expect(plainAST).not.toHaveBeenCalled();
    expect(code()).toBe("");
    expect(search.textContent).toContain("1 of 1");
    expect(container.querySelector("diffs-container")?.shadowRoot?.textContent).toContain(
      "updated.ts",
    );
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    view.render(true);
    await vi.waitFor(() => expect(code()).toContain("const after = 3;"));
    expect(container.textContent).toContain("Review this change");
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
  useImperativeHandle(
    viewerRef,
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
  // The reveal hook cancels pending clicks by scope identity, so a scope object
  // must only be replaced when one of its inputs changes.
  const [storedRevealScope, setRevealScope] = useState(() => ({
    scope,
    selectedRequest: { selectedFile, requestId },
  }));
  let revealScope = storedRevealScope;
  if (
    revealScope.scope !== scope ||
    revealScope.selectedRequest.selectedFile !== selectedFile ||
    revealScope.selectedRequest.requestId !== requestId
  ) {
    revealScope = {
      scope,
      selectedRequest:
        revealScope.selectedRequest.selectedFile === selectedFile &&
        revealScope.selectedRequest.requestId === requestId
          ? revealScope.selectedRequest
          : { selectedFile, requestId },
    };
    setRevealScope(revealScope);
  }
  const { selectedRequest } = revealScope;
  useEffect(() => {
    if (!selectedRequest.selectedFile || !viewer?.getInstance()) return;
    viewer.scrollTo({ type: "item", id: selectedRequest.selectedFile, align: "start" });
  }, [selectedRequest, viewer]);
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
  let view: ReturnType<typeof mount>;
  const reveal = () => act(async () => document.querySelector("button")!.click());

  beforeEach(() => {
    revealCalls.length = 0;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  });

  afterEach(async () => {
    await unmountAll();
    vi.unstubAllGlobals();
  });

  it("does not replay a handled tree click or scroll an old handle when a selected file remounts the view", async () => {
    view = mount(<RevealViews scope="first" visible selectedFile="external-a" />);
    await view.initial;
    await reveal();
    expect(revealCalls.at(-1)?.fileKey).toBe("tree-file");
    revealCalls.length = 0;

    await view.render(
      <RevealViews scope="second" visible selectedFile="external-b" requestId={1} />,
    );
    expect(revealCalls).toEqual([
      { scope: "second", fileKey: "external-b", mounted: true, collapsed: false },
    ]);
  });

  it("waits for a live viewer and applies each pending tree click only once", async () => {
    view = mount(<RevealViews scope="diff" visible={false} selectedFile="external" />);
    await view.initial;
    await reveal();
    expect(revealCalls).toEqual([]);

    await view.render(<RevealViews scope="diff" visible selectedFile="external" />);
    expect(revealCalls.map((call) => call.fileKey)).toEqual(["external", "tree-file"]);
    revealCalls.length = 0;
    await view.render(<RevealViews scope="diff" visible={false} selectedFile="external" />);
    await view.render(<RevealViews scope="diff" visible selectedFile="external" />);
    expect(revealCalls).toEqual([
      { scope: "diff", fileKey: "external", mounted: true, collapsed: false },
    ]);

    revealCalls.length = 0;
    // A click that lands in the same update that hides the viewer waits for it to return.
    await act(async () => {
      document.querySelector("button")!.click();
      view.root.render(<RevealViews scope="diff" visible={false} selectedFile="external" />);
    });
    expect(revealCalls).toEqual([]);
    await view.render(<RevealViews scope="diff" visible selectedFile="external" />);
    expect(revealCalls).toEqual([
      { scope: "diff", fileKey: "external", mounted: true, collapsed: false },
      { scope: "diff", fileKey: "tree-file", mounted: true, collapsed: false },
    ]);
  });

  it("cancels pending tree clicks when an external selection or diff scope changes", async () => {
    view = mount(<RevealViews scope="first" visible={false} selectedFile="external-a" />);
    await view.initial;
    await reveal();
    await view.render(
      <RevealViews scope="first" visible selectedFile="external-b" requestId={1} />,
    );
    expect(revealCalls.map((call) => call.fileKey)).toEqual(["external-b"]);
    revealCalls.length = 0;

    await view.render(<RevealViews scope="first" visible={false} />);
    await reveal();
    await view.render(<RevealViews scope="second" visible={false} />);
    await view.render(<RevealViews scope="first" visible />);
    expect(revealCalls).toEqual([]);
  });

  it("reveals after a collapsed file expands and honors another click on the same file", async () => {
    view = mount(<RevealViews scope="diff" visible />);
    await view.initial;
    await reveal();
    await reveal();
    expect(revealCalls).toEqual([
      { scope: "diff", fileKey: "tree-file", mounted: true, collapsed: false },
      { scope: "diff", fileKey: "tree-file", mounted: true, collapsed: false },
    ]);
  });
});
