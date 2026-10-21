import {
  getSharedHighlighter,
  VirtualizedFile,
  Virtualizer,
  type FileContents,
} from "@pierre/diffs";
import { Editor, TextDocument } from "@pierre/diffs/edit";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const renderingManagerUrl = new URL(
  "./managers/UniversalRenderingManager.js",
  import.meta.resolve("@pierre/diffs"),
);
const { clearRenderQueue } = (await import(/* @vite-ignore */ renderingManagerUrl.href)) as {
  clearRenderQueue(): void;
};

class MeasuredElement {
  static geometryReads = 0;
  children: MeasuredElement[] = [];
  dataset: Record<string, string> = {};
  nextElementSibling: MeasuredElement | null = null;
  shadowRoot: MeasuredElement | null = null;
  width = 283;

  constructor(readonly height = 0) {}

  attachShadow() {
    this.shadowRoot ??= new MeasuredElement();
    return this.shadowRoot;
  }

  appendChild(child: MeasuredElement) {
    this.children.push(child);
    return child;
  }

  getBoundingClientRect() {
    MeasuredElement.geometryReads += 1;
    return { top: 0, height: this.height, width: this.width };
  }
}

class MeasuredCodeElement extends MeasuredElement {
  readonly tagName = "CODE";

  get firstElementChild() {
    return this.children[0] ?? null;
  }
}

const observers: RecordedResizeObserver[] = [];
const animationFrames = new Map<number, FrameRequestCallback>();
let nextFrameId = 0;

class RecordedResizeObserver {
  readonly targets = new Set<Element>();

  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }

  deliver(target: HTMLElement) {
    const rect = target.getBoundingClientRect();
    const size = { inlineSize: rect.width, blockSize: rect.height };
    this.callback(
      [
        {
          target,
          contentRect: rect,
          contentBoxSize: [size],
          borderBoxSize: [size],
          devicePixelContentBoxSize: [size],
        },
      ],
      this as unknown as ResizeObserver,
    );
  }
}

function measuredElement(element: MeasuredElement): HTMLElement {
  return element as unknown as HTMLElement;
}

class LayoutVirtualizer extends Virtualizer {
  override getOffsetInScrollContainer(_element: HTMLElement) {
    return 0;
  }
}

class MeasuredFile extends VirtualizedFile {
  override top = 0;
  override onRender = () => false;

  override __attachEditor(editor: Parameters<VirtualizedFile["__attachEditor"]>[0]) {
    this.editor = editor;
    return () => {
      this.editor = undefined;
    };
  }

  async initialize(file: FileContents) {
    this.updateCodeViewLayout(file, 0);
    // Document changes require the session an attached editor installs.
    (this as unknown as { installEditSession(file: FileContents): void }).installEditSession(file);
    await this.fileRenderer.initializeHighlighter();
    expect(
      this.fileRenderer.renderFile(file, {
        startingLine: 5950,
        totalLines: 51,
        bufferBefore: 0,
        bufferAfter: 0,
      }),
    ).toBeDefined();
    this.fileContainer = measuredElement(new MeasuredElement());
  }

  measure(
    rows: ReadonlyArray<readonly [lineIndex: number, height: number]>,
    contentWidth = 226.25,
  ) {
    const content = new MeasuredElement();
    content.width = contentWidth;
    content.children = rows.map(([lineIndex, height]) => {
      const row = new MeasuredElement(height);
      row.dataset.lineIndex = String(lineIndex);
      return row;
    });
    const code = new MeasuredCodeElement();
    code.width = contentWidth + 56.75;
    code.children = [new MeasuredElement(), content];
    this.code = measuredElement(code);
    this.reconcileHeights();
  }

  resizeContent(contentWidth: number, codeWidth = contentWidth + 56.75) {
    const code = this.code;
    const content = code?.children[1];
    if (!(code instanceof MeasuredElement) || !(content instanceof MeasuredElement)) {
      throw new Error("Expected measured code and content");
    }
    code.width = codeWidth;
    content.width = contentWidth;
  }

  observeLayout() {
    const pre = new MeasuredElement();
    if (!(this.code instanceof MeasuredElement)) throw new Error("Expected measured code");
    pre.children = [this.code];
    this.resizeManager.setup(measuredElement(pre) as HTMLPreElement, {
      disableAnnotations: true,
      columnVariables: "measure",
    });
    const code = this.code;
    const observer = observers.find((candidate) => candidate.targets.has(code));
    if (observer === undefined) throw new Error("The real resize manager did not observe code");
    return () => observer.deliver(code);
  }

  dispose() {
    this.fileContainer = undefined;
    this.code = undefined;
    this.cleanUp();
  }
}

const instances: MeasuredFile[] = [];
const editors: Editor<"file", undefined, undefined>[] = [];

beforeAll(async () => {
  await getSharedHighlighter({
    themes: ["pierre-dark"],
    langs: ["text"],
    preferredHighlighter: "shiki-wasm",
  });
});

beforeEach(() => {
  observers.length = 0;
  animationFrames.clear();
  MeasuredElement.geometryReads = 0;
  vi.stubGlobal("HTMLElement", MeasuredElement);
  vi.stubGlobal("Document", MeasuredElement);
  vi.stubGlobal("ResizeObserver", RecordedResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    animationFrames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => animationFrames.delete(id));
});

afterEach(() => {
  for (const editor of editors.splice(0)) editor.cleanUp();
  for (const instance of instances.splice(0)) instance.dispose();
  clearRenderQueue();
  animationFrames.clear();
  vi.unstubAllGlobals();
});

async function makeFixture(
  overflow: "wrap" | "scroll" = "wrap",
  lineCount = 6001,
  contentWidth = 226.25,
) {
  const contents = Array.from({ length: lineCount }, (_, index) => `line ${index}`).join("\n");
  const file: FileContents = {
    name: "wrapped.txt",
    contents,
    cacheKey: `wrapped:${overflow}`,
    lang: "text",
  };
  const document = new TextDocument<"file", undefined>(file.name, contents, "text");
  const instance = new MeasuredFile(
    {
      overflow,
      disableFileHeader: true,
      theme: "pierre-dark",
      preferredHighlighter: "shiki-wasm",
      useTokenTransformer: true,
      controlledSelection: true,
    },
    new LayoutVirtualizer(),
  );
  instances.push(instance);
  await instance.initialize(file);
  instance.measure(
    [
      [0, 80],
      [120, 60],
      [4999, 100],
      [5000, 80],
      [5999, 100],
      [6000, 60],
    ],
    contentWidth,
  );
  const apply = (change: { startLine: number } | undefined, passStartLine = true) => {
    if (change === undefined) throw new Error("Expected a document change");
    file.contents = document.getText();
    instance.applyDocumentChange(
      document,
      undefined,
      false,
      passStartLine ? change.startLine : undefined,
    );
  };
  const append = () => {
    const position = document.positionAt(document.getText().length);
    apply(document.applyEdits([{ range: { start: position, end: position }, newText: "\n" }]));
  };
  return { instance, document, file, apply, append };
}

describe("wrapped editor document changes", () => {
  it("preserves the position above an EOF insertion across layout checkpoints", async () => {
    const { instance, document, append } = await makeFixture();
    const previousLastLine = document.lineCount;
    const before = instance.getLinePosition(previousLastLine);
    expect(before).toEqual({ top: 120328, height: 60 });
    const viewport = { top: before!.top - 100, bottom: before!.top + 80 };
    expect(instance.getAdvancedStickySpecs(viewport)).toEqual({ topOffset: 118240, height: 2096 });

    append();

    expect(document.lineCount).toBe(previousLastLine + 1);
    expect(instance.getLinePosition(previousLastLine)).toEqual({ top: before!.top, height: 20 });
    expect(instance.getLinePosition(document.lineCount)).toEqual({ top: 120348, height: 20 });
    expect(instance.getVirtualizedHeight()).toBe(120376);
    expect(instance.getAdvancedStickySpecs(viewport)).toEqual({ topOffset: 118240, height: 2096 });
  });

  it("invalidates changed and shifted rows after an insertion in the middle", async () => {
    const { instance, document, apply } = await makeFixture();
    const before = instance.getLinePosition(5001);
    const position = { line: 5000, character: 2 };
    apply(document.applyEdits([{ range: { start: position, end: position }, newText: "\n" }]));

    expect(instance.getLinePosition(5001)).toEqual({ top: before!.top, height: 20 });
    expect(instance.getLineHeight(4999)).toBe(100);
    expect(instance.getLineHeight(5000)).toBe(20);
    expect(instance.getLineHeight(5999)).toBe(20);
    expect(instance.getLinePosition(document.lineCount)).toEqual({ top: 120208, height: 20 });
  });

  it("keeps preceding measurements when a deletion crosses a checkpoint", async () => {
    const { instance, document, apply } = await makeFixture();
    const before = instance.getLinePosition(5000);
    apply(
      document.applyEdits([
        {
          range: { start: { line: 4999, character: 2 }, end: { line: 5001, character: 2 } },
          newText: "",
        },
      ]),
    );

    expect(document.lineCount).toBe(5999);
    expect(instance.getLinePosition(5000)).toEqual({ top: before!.top, height: 20 });
    expect(instance.getLineHeight(120)).toBe(60);
    expect(instance.getLineHeight(4999)).toBe(20);
    expect(instance.getLineHeight(6000)).toBe(20);
    expect(instance.getLinePosition(document.lineCount)).toEqual({ top: 120068, height: 20 });
  });

  it("uses the earliest changed line for edits at multiple selections", async () => {
    const { instance, document, apply } = await makeFixture();
    const before = instance.getLinePosition(121);
    apply(
      document.applyEdits(
        [120, 5000].map((line) => ({
          range: { start: { line, character: 2 }, end: { line, character: 2 } },
          newText: "\n",
        })),
      ),
    );

    expect(document.lineCount).toBe(6003);
    expect(instance.getLinePosition(121)).toEqual({ top: before!.top, height: 20 });
    expect(instance.getLineHeight(0)).toBe(80);
    expect(instance.getLineHeight(120)).toBe(20);
    expect(instance.getLineHeight(4999)).toBe(20);
  });

  it("retains the unchanged prefix through repeated Enter, undo and redo", async () => {
    const { instance, document, apply, append } = await makeFixture();
    const before = instance.getLinePosition(6001);
    for (let count = 0; count < 60; count += 1) append();
    expect(document.lineCount).toBe(6061);
    expect(instance.getLinePosition(6001)?.top).toBe(before!.top);
    apply(document.undo()?.[0]);
    expect(instance.getLinePosition(6001)?.top).toBe(before!.top);
    apply(document.redo()?.[0]);
    expect(document.lineCount).toBe(6061);
    expect(instance.getLinePosition(6001)?.top).toBe(before!.top);
  });

  // regression: #10018 retaining wrapped row heights must not shift rows in an unwrapped layout
  it("keeps unwrapped positions unchanged", async () => {
    const { instance, append } = await makeFixture("scroll");
    const before = instance.getLinePosition(6001);
    append();
    expect(instance.getLinePosition(6001)).toEqual(before);
    expect(instance.getLinePosition(6002)).toEqual({ top: 120028, height: 20 });
  });

  it("fully invalidates measurements when the first changed line is unknown", async () => {
    const { instance, document, apply } = await makeFixture();
    const position = document.positionAt(document.getText().length);
    apply(
      document.applyEdits([{ range: { start: position, end: position }, newText: "\n" }]),
      false,
    );
    expect(instance.getLinePosition(6001)).toEqual({ top: 120008, height: 20 });
    expect(instance.getLineHeight(0)).toBe(20);
  });

  it("still discards all measured rows after a metric change", async () => {
    const { instance, file, append } = await makeFixture();
    append();
    instance.setMetrics({ hunkLineCount: 50, lineHeight: 24, diffHeaderHeight: 44, spacing: 8 });
    instance.updateCodeViewLayout(file, 0);
    expect(instance.getLinePosition(6001)).toEqual({ top: 144008, height: 24 });
  });

  it("still discards all measured rows when annotations change", async () => {
    const { instance, file, append } = await makeFixture();
    append();
    instance.setLineAnnotations([{ lineNumber: 10, metadata: undefined }]);
    instance.updateCodeViewLayout(file, 0);
    expect(instance.getLinePosition(6001)).toEqual({ top: 120008, height: 20 });
  });
});
