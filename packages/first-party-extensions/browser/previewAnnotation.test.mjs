import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { copyJson } from "@t3tools/extension-sdk/contracts";

import {
  appendPreviewAnnotationPrompt,
  buildPreviewAnnotationPrompt,
  capturePreviewAnnotationScreenshot,
  extractTrailingPreviewAnnotation,
  PREVIEW_ANNOTATION_COMMENT_MAX_CHARS,
  PREVIEW_ANNOTATION_CONTEXT_ELEMENTS_MAX,
  PREVIEW_ANNOTATION_PROMPT_MAX_BYTES,
  PREVIEW_ANNOTATION_STYLE_CHANGES_MAX,
} from "./previewAnnotation.ts";

const annotation = {
  id: "annotation_1",
  pageUrl: "http://localhost:3000",
  pageTitle: "Example",
  comment: "Make these cards feel related.",
  elements: [],
  regions: [{ id: "region_1", rect: { x: 10, y: 20, width: 100, height: 80 } }],
  strokes: [
    {
      id: "stroke_1",
      color: "#7c3aed",
      width: 4,
      points: [
        { x: 10, y: 10 },
        { x: 20, y: 20 },
      ],
      bounds: { x: 6, y: 6, width: 18, height: 18 },
    },
  ],
  styleChanges: [
    {
      targetId: "element_1",
      selector: ".card",
      property: "border-radius",
      previousValue: "4px",
      value: "16px",
    },
  ],
  screenshot: {
    dataUrl: "data:image/png;base64,AA==",
    width: 100,
    height: 80,
    cropRect: { x: 10, y: 20, width: 100, height: 80 },
  },
  createdAt: "2026-06-11T00:00:00.000Z",
};

const elementAnnotation = {
  ...annotation,
  elements: [
    {
      id: "element_1",
      rect: { x: 1, y: 2, width: 3, height: 4 },
      element: {
        pageUrl: "http://localhost:3000/",
        pageTitle: "Example",
        tagName: "BUTTON",
        selector: ".card > button",
        htmlPreview: "<button>Save</button>",
        componentName: "SaveButton",
        source: {
          functionName: "App",
          fileName: "src/App.tsx",
          lineNumber: 42,
          columnNumber: 7,
        },
        stack: [],
        styles: "border-radius: 4px;",
        pickedAt: "2026-06-11T00:00:00.000Z",
      },
    },
  ],
};

NodeTest.describe("buildPreviewAnnotationPrompt", () => {
  NodeTest.it("describes regions, drawings, styles, and screenshot context", () => {
    const result = buildPreviewAnnotationPrompt(annotation);
    NodeAssert.match(result, /^<preview_annotation>\n/);
    NodeAssert.match(result, /\n<\/preview_annotation>$/);
    NodeAssert.ok(result.includes("Id: annotation_1"));
    NodeAssert.ok(result.includes("Page: Example"));
    NodeAssert.ok(result.includes("Make these cards feel related."));
    NodeAssert.ok(result.includes("1 marked region"));
    NodeAssert.ok(result.includes("1 drawing"));
    NodeAssert.ok(result.includes("- border-radius: 4px → 16px"));
    NodeAssert.ok(result.includes("attached screenshot"));
  });

  NodeTest.it("emits the element_context block for picked elements", () => {
    const result = buildPreviewAnnotationPrompt(elementAnnotation);
    NodeAssert.ok(result.includes("Targets: 1 selected element, 1 marked region, 1 drawing."));
    NodeAssert.ok(result.includes("<element_context>"));
    NodeAssert.ok(result.includes("- <SaveButton> (App.tsx:42):"));
    NodeAssert.ok(result.includes("selector: .card > button"));
    NodeAssert.ok(result.includes("source: src/App.tsx:42:7"));
    NodeAssert.ok(result.includes("<button>Save</button>"));
  });

  NodeTest.it("falls back to the page url, then a bare title", () => {
    NodeAssert.ok(
      buildPreviewAnnotationPrompt({ ...annotation, pageTitle: null }).includes(
        "Page: http://localhost:3000",
      ),
    );
    NodeAssert.ok(
      buildPreviewAnnotationPrompt({ ...annotation, pageTitle: null, pageUrl: " " }).includes(
        "Page: Preview",
      ),
    );
  });

  NodeTest.it("clamps an oversized comment and keeps the delimiters", () => {
    // Reviewer repro: a 1M-char comment must not produce a 1M-char prompt.
    const result = buildPreviewAnnotationPrompt({
      ...annotation,
      comment: "x".repeat(1_000_000),
    });
    NodeAssert.ok(result.startsWith("<preview_annotation>\n"));
    NodeAssert.ok(result.endsWith("\n</preview_annotation>"));
    const commentLine = result.split("\n").find((line) => line.startsWith("Comment: "));
    NodeAssert.ok(commentLine);
    NodeAssert.ok(commentLine.length <= PREVIEW_ANNOTATION_COMMENT_MAX_CHARS + "Comment: ".length);
    NodeAssert.ok(commentLine.endsWith("…"));
    NodeAssert.ok(result.length < 10_000);
  });

  NodeTest.it("caps style changes and clamps each field", () => {
    const styleChanges = Array.from(
      { length: PREVIEW_ANNOTATION_STYLE_CHANGES_MAX + 10 },
      (_, i) => ({
        targetId: `t${i}`,
        selector: ".card",
        property: `prop-${i}-${"p".repeat(500)}`,
        previousValue: "v".repeat(500),
        value: "n".repeat(500),
      }),
    );
    const result = buildPreviewAnnotationPrompt({ ...annotation, styleChanges });
    const changeLines = result.split("\n").filter((line) => line.startsWith("- "));
    NodeAssert.equal(changeLines.length, PREVIEW_ANNOTATION_STYLE_CHANGES_MAX);
    NodeAssert.ok(changeLines.every((line) => line.length < 900));
  });

  NodeTest.it("bounds picked elements and clamps long selector/source fields", () => {
    const huge = (element) => ({
      id: `e-${element}`,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      element: {
        ...elementAnnotation.elements[0].element,
        selector: `.x${"s".repeat(5000)}`,
        componentName: `Comp${"n".repeat(5000)}`,
        source: {
          functionName: `fn${"f".repeat(5000)}`,
          fileName: `src/${"d".repeat(5000)}.tsx`,
          lineNumber: 1,
          columnNumber: 1,
        },
      },
    });
    const elements = Array.from({ length: PREVIEW_ANNOTATION_CONTEXT_ELEMENTS_MAX + 8 }, (_, i) =>
      huge(i),
    );
    const result = buildPreviewAnnotationPrompt({ ...elementAnnotation, elements });
    NodeAssert.ok(
      result.includes(`Targets: ${elements.length} selected elements`),
      "the Targets line still reports the real count",
    );
    NodeAssert.ok(
      result.match(/^- </gm).length <= PREVIEW_ANNOTATION_CONTEXT_ELEMENTS_MAX,
      "context entries are capped",
    );
    NodeAssert.ok(!result.includes("s".repeat(2000)), "selector is clamped");
    NodeAssert.ok(!result.includes("d".repeat(2000)), "source fileName is clamped");
    NodeAssert.ok(!result.includes("f".repeat(2000)), "source functionName is clamped");
  });

  NodeTest.it("keeps the serialized prompt under the byte cap with delimiters intact", () => {
    const encoder = new TextEncoder();
    // 16 elements each carrying max-size html/styles — ~11 KB of context
    // apiece — cannot all fit under the serialized cap; extras drop whole.
    const fat = (i) => ({
      id: `fat-${i}`,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      element: {
        ...elementAnnotation.elements[0].element,
        htmlPreview: "界".repeat(4000),
        styles: "界".repeat(4000),
      },
    });
    const elements = Array.from({ length: PREVIEW_ANNOTATION_CONTEXT_ELEMENTS_MAX }, (_, i) =>
      fat(i),
    );
    const result = buildPreviewAnnotationPrompt({ ...elementAnnotation, elements });
    NodeAssert.ok(encoder.encode(result).length <= PREVIEW_ANNOTATION_PROMPT_MAX_BYTES);
    NodeAssert.ok(result.startsWith("<preview_annotation>\n"));
    NodeAssert.ok(result.endsWith("\n</preview_annotation>"));
    if (result.includes("<element_context>")) {
      NodeAssert.ok(result.includes("</element_context>"), "context block is never torn");
    }
  });

  NodeTest.it("bounds the JSON-serialized size — the unit the SDK envelope measures", () => {
    // The cap must account for JSON escaping — a NUL-heavy payload is ~6×
    // larger once serialized, and raw-byte measurement let copyJson reject the
    // prompt. Every escaped-glyph class must serialize under the cap and pass
    // the real SDK gate.
    const serializedBytes = (value) => new TextEncoder().encode(JSON.stringify(value)).length;
    const heavy = (ch) => ({
      ...annotation,
      id: ch.repeat(256),
      pageTitle: ch.repeat(2048),
      comment: ch.repeat(8000),
      styleChanges: Array.from({ length: PREVIEW_ANNOTATION_STYLE_CHANGES_MAX }, (_, i) => ({
        targetId: `t${i}`,
        selector: null,
        property: ch.repeat(256),
        previousValue: ch.repeat(256),
        value: ch.repeat(256),
      })),
      elements: [],
      regions: [],
      strokes: [],
      screenshot: null,
    });
    for (const ch of ['"', "\\", "\u0000", "界", "\n"]) {
      const result = buildPreviewAnnotationPrompt(heavy(ch));
      NodeAssert.ok(
        serializedBytes(result) <= PREVIEW_ANNOTATION_PROMPT_MAX_BYTES,
        `serialized size for ${JSON.stringify(ch)} fits the cap`,
      );
      NodeAssert.ok(result.startsWith("<preview_annotation>\n"));
      NodeAssert.ok(result.endsWith("\n</preview_annotation>"));
      NodeAssert.doesNotThrow(() => copyJson(result), "the real SDK envelope accepts it");
    }
  });

  NodeTest.it("keeps whole element_context blocks under the serialized cap", () => {
    // Escape-heavy contexts: quotes + control chars inflate serialization;
    // contexts must drop whole, never mid-block.
    const escaped = (i) => ({
      id: `esc-${i}`,
      rect: { x: 0, y: 0, width: 1, height: 1 },
      element: {
        ...elementAnnotation.elements[0].element,
        htmlPreview: '"\\\n'.repeat(1000),
        styles: '"\\\n'.repeat(1000),
      },
    });
    const elements = Array.from({ length: PREVIEW_ANNOTATION_CONTEXT_ELEMENTS_MAX }, (_, i) =>
      escaped(i),
    );
    const result = buildPreviewAnnotationPrompt({ ...elementAnnotation, elements });
    NodeAssert.ok(
      new TextEncoder().encode(JSON.stringify(result)).length <=
        PREVIEW_ANNOTATION_PROMPT_MAX_BYTES,
    );
    NodeAssert.doesNotThrow(() => copyJson(result));
    NodeAssert.ok(result.endsWith("\n</preview_annotation>"));
    if (result.includes("<element_context>")) {
      NodeAssert.ok(result.includes("</element_context>"), "context block is never torn");
    }
  });
});

NodeTest.describe("appendPreviewAnnotationPrompt", () => {
  NodeTest.it("appends to an existing composer prompt", () => {
    NodeAssert.ok(
      appendPreviewAnnotationPrompt("Fix this", annotation).startsWith(
        "Fix this\n\n<preview_annotation>",
      ),
    );
  });

  NodeTest.it("stands alone on an empty prompt", () => {
    NodeAssert.ok(
      appendPreviewAnnotationPrompt("   ", annotation).startsWith("<preview_annotation>"),
    );
  });
});

NodeTest.describe("extractTrailingPreviewAnnotation", () => {
  NodeTest.it("extracts annotation presentation from a sent prompt", () => {
    const result = extractTrailingPreviewAnnotation(
      appendPreviewAnnotationPrompt("Fix this", annotation),
    );
    NodeAssert.equal(result.promptText, "Fix this");
    NodeAssert.equal(result.annotation?.id, "annotation_1");
    NodeAssert.equal(result.annotation?.title, "Example");
    NodeAssert.equal(result.annotation?.targetSummary, "1 marked region, 1 drawing.");
    NodeAssert.equal(result.annotation?.hasScreenshot, true);
    NodeAssert.deepEqual(result.annotation?.styleChanges, ["border-radius: 4px → 16px"]);
  });

  NodeTest.it("extracts multiple trailing annotations one at a time", () => {
    const first = appendPreviewAnnotationPrompt("Fix this", annotation);
    const secondAnnotation = { ...annotation, id: "annotation_2", pageTitle: "Details" };
    const second = appendPreviewAnnotationPrompt(first, secondAnnotation);
    const extractedSecond = extractTrailingPreviewAnnotation(second);
    const extractedFirst = extractTrailingPreviewAnnotation(extractedSecond.promptText);
    NodeAssert.equal(extractedSecond.annotation?.id, "annotation_2");
    NodeAssert.equal(extractedFirst.annotation?.id, "annotation_1");
    NodeAssert.equal(extractedFirst.promptText, "Fix this");
  });

  NodeTest.it("returns the prompt untouched when no block trails", () => {
    NodeAssert.deepEqual(extractTrailingPreviewAnnotation("plain text"), {
      promptText: "plain text",
      annotation: null,
    });
  });
});

NodeTest.describe("capturePreviewAnnotationScreenshot", () => {
  NodeTest.it("returns the crop when the fetch resolves", async () => {
    const capture = await capturePreviewAnnotationScreenshot(annotation);
    NodeAssert.equal(capture.status, "captured");
    if (capture.status === "captured") {
      NodeAssert.equal(capture.file.name, "preview-annotation-annotation_1.png");
      NodeAssert.equal(capture.file.type, "image/png");
    }
  });

  NodeTest.it("reports none when the annotation carries no crop", async () => {
    const capture = await capturePreviewAnnotationScreenshot({ ...annotation, screenshot: null });
    NodeAssert.deepEqual(capture, { status: "none" });
  });

  NodeTest.it("fails instead of hanging when the crop never arrives", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = () => new Promise(() => {});
    try {
      const capture = await capturePreviewAnnotationScreenshot(annotation, 50);
      NodeAssert.deepEqual(capture, { status: "failed" });
    } finally {
      globalThis.fetch = original;
    }
  });

  NodeTest.it("fails when the crop fetch throws", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async () => {
      throw new Error("data url unreadable");
    };
    try {
      const capture = await capturePreviewAnnotationScreenshot(annotation);
      NodeAssert.deepEqual(capture, { status: "failed" });
    } finally {
      globalThis.fetch = original;
    }
  });
});
