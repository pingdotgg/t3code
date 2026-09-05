import {
  getSharedHighlighter,
  VirtualizedFile,
  Virtualizer,
  type FileContents,
} from "@pierre/diffs";
import { TextDocument } from "@pierre/diffs/editor";
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
  for (const instance of instances.splice(0)) instance.dispose();
  vi.unstubAllGlobals();
});

async function makeFixture(overflow: "wrap" | "scroll" = "wrap") {
  const contents = Array.from({ length: 6001 }, (_, index) => `line ${index}`).join("\n");
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
