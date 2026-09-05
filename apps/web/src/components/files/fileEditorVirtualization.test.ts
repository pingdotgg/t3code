import {
  getSharedHighlighter,
  VirtualizedFile,
  Virtualizer,
  type FileContents,
} from "@pierre/diffs";
import { Editor, TextDocument } from "@pierre/diffs/editor";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Layout measurements are controlled here. The real reconciler, document and
// renderer calculate positions. This does not simulate native CSS wrapping.
class MeasuredElement {
  children: MeasuredElement[] = [];
  dataset: Record<string, string> = {};
  nextElementSibling: MeasuredElement | null = null;

  constructor(readonly height = 0) {}

  getBoundingClientRect() {
    return { top: 0, height: this.height };
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

  override attachEditor(editor: Parameters<VirtualizedFile["attachEditor"]>[0]) {
    this.editor = editor;
    return () => {
      this.editor = undefined;
    };
  }

  async initialize(file: FileContents) {
    this.prepareCodeViewItem(file, 0);
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

  measure(rows: ReadonlyArray<readonly [lineIndex: number, height: number]>) {
    const content = new MeasuredElement();
    content.children = rows.map(([lineIndex, height]) => {
      const row = new MeasuredElement(height);
      row.dataset.lineIndex = String(lineIndex);
      return row;
    });
    const code = new MeasuredElement();
    code.children = [new MeasuredElement(), content];
    this.code = measuredElement(code);
    this.reconcileHeights();
  }

  dispose() {
    this.fileContainer = undefined;
    this.code = undefined;
    this.cleanUp();
  }
}

const instances: MeasuredFile[] = [];
const editors: Editor<undefined>[] = [];

beforeAll(async () => {
  await getSharedHighlighter({
    themes: ["pierre-dark"],
    langs: ["text"],
    preferredHighlighter: "shiki-wasm",
  });
});

beforeEach(() => {
  vi.stubGlobal("HTMLElement", MeasuredElement);
});

afterEach(() => {
  for (const editor of editors.splice(0)) editor.cleanUp();
  for (const instance of instances.splice(0)) instance.dispose();
  vi.unstubAllGlobals();
});

async function makeFixture(overflow: "wrap" | "scroll" = "wrap", lineCount = 6001) {
  const contents = Array.from({ length: lineCount }, (_, index) => `line ${index}`).join("\n");
  const file: FileContents = {
    name: "wrapped.txt",
    contents,
    cacheKey: `wrapped:${overflow}`,
    lang: "text",
  };
  const document = new TextDocument(file.name, contents, "text");
  const instance = new MeasuredFile(
    {
      overflow,
      disableFileHeader: true,
      theme: "pierre-dark",
      preferredHighlighter: "shiki-wasm",
    },
    new LayoutVirtualizer(),
  );
  instances.push(instance);
  await instance.initialize(file);
  instance.measure([
    [0, 80],
    [120, 60],
    [4999, 100],
    [5000, 80],
    [5999, 100],
    [6000, 60],
  ]);
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
    expect(instance.getAdvancedStickySpecs(viewport)).toEqual({ topOffset: 118240, height: 2156 });

    append();

    expect(document.lineCount).toBe(previousLastLine + 1);
    expect(instance.getLinePosition(previousLastLine)).toEqual({ top: before!.top, height: 20 });
    expect(instance.getLinePosition(document.lineCount)).toEqual({ top: 120348, height: 20 });
    expect(instance.getVirtualizedHeight()).toBe(120376);
    expect(instance.getAdvancedStickySpecs(viewport)).toEqual({ topOffset: 118240, height: 2136 });
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
    instance.prepareCodeViewItem(file, 0);
    expect(instance.getLinePosition(6001)).toEqual({ top: 144008, height: 24 });
  });

  it("still discards all measured rows when annotations change", async () => {
    const { instance, file, append } = await makeFixture();
    append();
    instance.setLineAnnotations([{ lineNumber: 10, metadata: undefined }]);
    instance.prepareCodeViewItem(file, 0);
    expect(instance.getLinePosition(6001)).toEqual({ top: 120008, height: 20 });
  });
});

// Supply inert DOM transport so public Editor edits execute its real tokenizer
// and layout handoff. No native wrapping, observer delivery or scrolling is modeled.
class EditorElement extends MeasuredElement {
  style: Record<string, string> = {};
  parentElement: EditorElement | null = null;

  appendChild(child: EditorElement) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  prepend(child: EditorElement) {
    child.parentElement = this;
    this.children.unshift(child);
  }

  replaceChildren(...children: (EditorElement | string)[]) {
    this.children = [];
    for (const child of children) if (typeof child !== "string") this.appendChild(child);
  }

  setAttribute() {}
  removeAttribute() {}
  addEventListener() {}
  removeEventListener() {}
  after() {}

  remove() {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    }
  }

  set innerHTML(value: string) {
    expect(value.startsWith("<svg")).toBe(true);
    this.replaceChildren(new EditorElement());
  }

  get firstElementChild() {
    return this.children[0] ?? null;
  }

  querySelectorAll(selector: string) {
    expect(selector).toBe("[data-code]");
    return this.children.filter((child) => "code" in child.dataset);
  }

  querySelector(selector: string) {
    expect(selector).toBe("[data-deletions]");
    return null;
  }

  getContext() {
    return { measureText: (text: string) => ({ width: text.length * 8 }) };
  }
}

async function makeEditorFixture(lineCount: number) {
  const { instance, file } = await makeFixture("wrap", lineCount);
  vi.stubGlobal("SVGSVGElement", EditorElement);
  vi.stubGlobal("Document", EditorElement);
  vi.stubGlobal(
    "document",
    Object.assign(new EditorElement(), { createElement: () => new EditorElement() }),
  );
  vi.stubGlobal("window", { matchMedia: () => ({ matches: true }) });
  vi.stubGlobal("requestAnimationFrame", () => 1);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal("getComputedStyle", () => ({
    paddingTop: "0px",
    fontSize: "13px",
    fontFamily: "monospace",
    tabSize: "2",
    lineHeight: "20px",
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  instance.setOptions({
    ...instance.options,
    useTokenTransformer: true,
    controlledSelection: true,
    themeType: "dark",
  });
  const content = new EditorElement();
  content.dataset.content = "";
  const gutter = new EditorElement();
  gutter.dataset.gutter = "";
  const code = new EditorElement();
  code.dataset.code = "";
  code.appendChild(gutter);
  code.appendChild(content);
  const shadow = new EditorElement();
  shadow.appendChild(code);
  const host = Object.assign(new EditorElement(), { shadowRoot: shadow });
  const highlighter = await getSharedHighlighter({
    themes: ["pierre-dark"],
    langs: ["text"],
    preferredHighlighter: "shiki-wasm",
  });
  const editor = new Editor<undefined>();
  editors.push(editor);
  editor.edit(instance);
  editor.__syncRenderView(highlighter, measuredElement(host), file, undefined, {
    startingLine: 0,
    totalLines: 1,
    bufferBefore: 0,
    bufferAfter: 0,
  });
  const append = (count: number) => {
    const lines = editor.getText().split("\n");
    const end = { line: lines.length - 1, character: lines.at(-1)!.length };
    editor.applyEdits([{ range: { start: end, end }, newText: "\n".repeat(count) }]);
  };
  const remove = (count: number) => {
    const lines = editor.getText().split("\n");
    const startLine = lines.length - count - 1;
    editor.applyEdits([
      {
        range: {
          start: { line: startLine, character: lines[startLine]!.length },
          end: { line: lines.length - 1, character: lines.at(-1)!.length },
        },
        newText: "",
      },
    ]);
  };
  return { instance, editor, append, remove };
}

describe("editor gutter-width changes", () => {
  it.each([
    [9999, 1],
    [9998, 3],
  ])(
    "clears prefix measurements when %i lines grow by %i across a digit boundary",
    async (lines, count) => {
      const { instance, editor, append } = await makeEditorFixture(lines);
      expect(instance.getLineHeight(0)).toBe(80);
      append(count);
      expect(editor.getText().split("\n")).toHaveLength(lines + count);
      expect(instance.getLineHeight(0)).toBe(20);
      expect(instance.getLineHeight(5000)).toBe(20);
    },
  );

  it.each([
    [10000, 1],
    [10002, 4],
  ])(
    "clears prefix measurements when %i lines shrink by %i across a digit boundary",
    async (lines, count) => {
      const { instance, editor, remove } = await makeEditorFixture(lines);
      remove(count);
      expect(editor.getText().split("\n")).toHaveLength(lines - count);
      expect(instance.getLineHeight(0)).toBe(20);
      expect(instance.getLineHeight(5000)).toBe(20);
    },
  );

  it("clears newly measured prefixes on undo and redo across a digit boundary", async () => {
    const { instance, editor, append } = await makeEditorFixture(9999);
    append(1);
    instance.measure([[0, 100]]);
    editor.undo();
    expect(editor.getText().split("\n")).toHaveLength(9999);
    expect(instance.getLineHeight(0)).toBe(20);
    instance.measure([[0, 80]]);
    editor.redo();
    expect(editor.getText().split("\n")).toHaveLength(10000);
    expect(instance.getLineHeight(0)).toBe(20);
  });

  it.each([
    [9998, 1],
    [10000, 2],
  ])(
    "retains prefix measurements when %i lines grow by %i without changing digit width",
    async (lines, count) => {
      const { instance, editor, append } = await makeEditorFixture(lines);
      append(count);
      expect(editor.getText().split("\n")).toHaveLength(lines + count);
      expect(instance.getLineHeight(0)).toBe(80);
      expect(instance.getLineHeight(5000)).toBe(80);
      editor.undo();
      expect(instance.getLineHeight(0)).toBe(80);
      editor.redo();
      expect(instance.getLineHeight(0)).toBe(80);
    },
  );
});
