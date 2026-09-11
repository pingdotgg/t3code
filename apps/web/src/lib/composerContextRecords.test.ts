import {
  OrchestrationMessageContext,
  ThreadId,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  formatInlineContextReference,
  removeInlineContextReference,
} from "./composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import {
  attachmentContextRecord,
  buildMessageContext,
  previewAnnotationContextLabel,
  previewAnnotationContextRecord,
  resolveUserMessageContext,
  reviewCommentContextRecord,
  terminalContextRecord,
  terminalContextReference,
} from "./composerContextRecords";

const decodeMessageContext = Schema.decodeUnknownSync(OrchestrationMessageContext);

const annotation: PreviewAnnotationPayload = {
  id: "ann_1",
  pageUrl: "http://localhost:3000/checkout",
  pageTitle: "Checkout",
  comment: "  Make this   bigger ",
  elements: [
    {
      id: "el_1",
      rect: { x: 0, y: 0, width: 10, height: 10 },
      element: {
        pageUrl: "http://localhost:3000/checkout",
        pageTitle: "Checkout",
        tagName: "BUTTON",
        selector: "#pay",
        htmlPreview: '<button id="pay">Pay</button>',
        componentName: "Button",
        source: null,
        stack: [],
        styles: "color: red;",
        pickedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  ],
  regions: [],
  strokes: [],
  styleChanges: [
    { targetId: "el_1", selector: "#pay", property: "font-size", previousValue: "", value: "20px" },
  ],
  screenshot: null,
  createdAt: "2026-01-01T00:00:00.000Z",
};

describe("composerContextRecords", () => {
  it("does not bind an annotation screenshot to a same-ID file", () => {
    const context = buildMessageContext({
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: [annotation],
      attachments: [
        {
          attachment: {
            type: "file",
            id: annotation.id,
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
            file: null,
          },
          attachmentId: "uploaded-file",
        },
      ],
    })!;
    expect(context.records.map((record) => record.kind)).toEqual(["preview-annotation", "file"]);
    expect(context.records[0]).not.toHaveProperty("screenshotContextId");
  });
  it("builds distinct records for producer IDs that differ by a kind prefix", () => {
    const context = buildMessageContext({
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: [],
      attachments: ["x", "image_x"].map((id) => ({
        attachment: {
          type: "image" as const,
          id,
          name: `${id}.png`,
          mimeType: "image/png",
          sizeBytes: 1,
          file: new File(["x"], `${id}.png`, { type: "image/png" }),
          previewUrl: `blob:${id}`,
        },
        attachmentId: `uploaded-${id}`,
      })),
    })!;
    expect(
      Schema.decodeUnknownSync(OrchestrationMessageContext)(context).records.map(
        (record) => record.contextId,
      ),
    ).toEqual(["image_x", "image_image_x"]);
  });
  it("scopes colliding producer ids and links the annotation to its screenshot record", () => {
    const id = "same.id:1";
    const context = buildMessageContext({
      terminalContexts: [
        {
          id,
          threadId: ThreadId.make("t1"),
          terminalId: "default",
          terminalLabel: "Terminal",
          lineStart: 1,
          lineEnd: 1,
          text: "output",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      reviewComments: [
        {
          id,
          sectionId: "s",
          sectionTitle: "Review",
          filePath: "file.ts",
          startIndex: 0,
          endIndex: 0,
          rangeLabel: "L1",
          text: "Review",
          diff: "",
        },
      ],
      previewAnnotations: [{ ...annotation, id }],
      attachments: [
        {
          attachment: {
            type: "image",
            id,
            name: "shot.png",
            mimeType: "image/png",
            sizeBytes: 1,
            file: new File(["x"], "shot.png"),
            previewUrl: "blob:shot",
          },
          attachmentId: "uploaded-image",
        },
        {
          attachment: {
            type: "file",
            id,
            name: "file.txt",
            mimeType: "text/plain",
            sizeBytes: 1,
            file: null,
          },
          attachmentId: "uploaded-file",
        },
      ],
    })!;
    expect(Schema.decodeUnknownSync(OrchestrationMessageContext)(context).records).toHaveLength(5);
    const preview = context.records.find((record) => record.kind === "preview-annotation");
    const image = context.records.find((record) => record.kind === "image");
    expect(preview).toMatchObject({ screenshotContextId: image!.contextId });
    expect(image).toMatchObject({ attachmentId: "uploaded-image" });
  });

  it("builds a preview annotation record with element details and readable style changes", () => {
    expect(previewAnnotationContextLabel(annotation)).toBe("Make this bigger");
    expect(previewAnnotationContextRecord(annotation, { screenshotContextId: "ann_1" })).toEqual({
      version: 1,
      contextId: "preview-annotation_ann_1",
      kind: "preview-annotation",
      label: "Make this bigger",
      annotationId: "ann_1",
      pageUrl: "http://localhost:3000/checkout",
      pageTitle: "Checkout",
      comment: "Make this   bigger",
      targetSummary: "1 selected element",
      styleChanges: ["font-size: (unset) → 20px"],
      styleChangeDetails: annotation.styleChanges,
      elementIds: ["el_1"],
      screenshotContextId: "image_ann_1",
      elements: [
        {
          pageUrl: "http://localhost:3000/checkout",
          pageTitle: "Checkout",
          tagName: "button",
          selector: "#pay",
          htmlPreview: '<button id="pay">Pay</button>',
          componentName: "Button",
          source: null,
          styles: "color: red;",
        },
      ],
    });
  });

  it("removes an expired terminal chip by its kind-scoped id, not the producer id", () => {
    const context = {
      id: "term-1",
      threadId: ThreadId.make("t"),
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 3,
      lineEnd: 4,
      text: "boom",
    };
    const reference = terminalContextReference(context);
    expect(reference.contextId).toBe("terminal_term-1");

    const prompt = `prose ${formatInlineContextReference(reference)} tail`;
    // The send path drops expired excerpts; the raw producer id matches nothing and would
    // leave the chip behind.
    expect(removeInlineContextReference(prompt, context.id).prompt).toBe(prompt);
    expect(removeInlineContextReference(prompt, reference.contextId).prompt).toBe("prose tail");
  });

  it("clamps an oversized review selection so the record still encodes", () => {
    const build = (diffLength: number) =>
      reviewCommentContextRecord({
        id: "rc-big",
        sectionId: "file:a/b.ts",
        sectionTitle: "File comment",
        filePath: "a/b.ts",
        startIndex: 0,
        endIndex: 1,
        rangeLabel: "L1",
        text: "Why?",
        diff: "d".repeat(diffLength),
      });

    // At the limit the diff is untouched; one character over it is clamped, and both encode.
    const atLimit = build(32_000);
    expect(atLimit.diff).toHaveLength(32_000);
    const overLimit = build(32_001);
    expect(overLimit.diff.length).toBeLessThanOrEqual(32_000);
    expect(overLimit.diff.endsWith("… truncated …")).toBe(true);
    expect(() => decodeMessageContext({ version: 1, records: [atLimit] })).not.toThrow();
    expect(() => decodeMessageContext({ version: 1, records: [overLimit] })).not.toThrow();
  });

  it("builds terminal and review records and a message context in draft order", () => {
    const terminal = terminalContextRecord({
      id: "term-1",
      threadId: ThreadId.make("t"),
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 3,
      lineEnd: 4,
      text: "\nboom\n",
    });
    expect(terminal).toMatchObject({
      kind: "terminal",
      label: "Terminal 1 lines 3-4",
      text: "boom",
    });
    const review = reviewCommentContextRecord({
      id: "rc-1",
      sectionId: "file:a/b.ts",
      sectionTitle: "File comment",
      filePath: "a/b.ts",
      startIndex: 3,
      endIndex: 3,
      rangeLabel: "L4",
      text: "Why?",
      diff: "const x = 1;",
      fenceLanguage: "ts",
    });
    expect(review).toMatchObject({ kind: "review-comment", label: "b.ts L4", fenceLanguage: "ts" });
    const context = buildMessageContext({
      terminalContexts: [],
      reviewComments: [
        {
          id: "rc-1",
          sectionId: "s",
          sectionTitle: "t",
          filePath: "a/b.ts",
          startIndex: 0,
          endIndex: 0,
          rangeLabel: "L1",
          text: "",
          diff: "",
        },
      ],
      previewAnnotations: [annotation],
    });
    expect(context?.records.map((record) => record.contextId)).toEqual([
      "review-comment_rc-1",
      "preview-annotation_ann_1",
    ]);
    expect(
      buildMessageContext({ terminalContexts: [], reviewComments: [], previewAnnotations: [] }),
    ).toBeUndefined();
  });

  it("resolves structured context directly and upgrades legacy text otherwise", () => {
    const structured = resolveUserMessageContext({
      text: "hi [b.ts L4](t3-context://v1/review-comment/rc-1)",
      context: {
        version: 1,
        records: [
          reviewCommentContextRecord({
            id: "rc-1",
            sectionId: "s",
            sectionTitle: "t",
            filePath: "a/b.ts",
            startIndex: 3,
            endIndex: 3,
            rangeLabel: "L4",
            text: "",
            diff: "",
          }),
        ],
      },
    });
    expect(structured.recordsById.get("review-comment_rc-1")?.kind).toBe("review-comment");
    const legacy = resolveUserMessageContext({
      text: "hi\n\n<terminal_context>\n- T line 1:\n  1 | x\n</terminal_context>",
    });
    expect(legacy.text).toBe("hi\n\n[T line 1](t3-context://v1/terminal/legacy_terminal_1)");
    expect(legacy.recordsById.get("legacy_terminal_1")?.kind).toBe("terminal");
  });
});

describe("attachment context records", () => {
  it("binds image and file records to the given attachment id", () => {
    const image = attachmentContextRecord({
      attachment: {
        type: "image",
        id: "img-1",
        name: "shot.png",
        mimeType: "image/png",
        sizeBytes: 10,
        previewUrl: "blob:x",
        file: new File(["x"], "shot.png", { type: "image/png" }),
      },
      attachmentId: "pending-abc",
    });
    expect(image).toEqual({
      version: 1,
      contextId: "image_img-1",
      kind: "image",
      label: "shot.png",
      attachmentId: "pending-abc",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 10,
    });
    const file = attachmentContextRecord({
      attachment: {
        type: "file",
        id: "file-1",
        name: "notes.txt",
        mimeType: "text/plain",
        sizeBytes: 3,
        file: null,
        uploadedAttachmentId: "pending-def",
      },
      attachmentId: "pending-def",
    });
    expect(file).toMatchObject({
      kind: "file",
      contextId: "file_file-1",
      attachmentId: "pending-def",
    });
    const context = buildMessageContext({
      terminalContexts: [],
      reviewComments: [],
      previewAnnotations: [],
      attachments: [
        {
          attachment: {
            type: "file",
            id: "file-1",
            name: "n",
            mimeType: "text/plain",
            sizeBytes: 1,
            file: null,
          },
          attachmentId: "file-1",
        },
      ],
    });
    expect(context?.records.map((record) => record.kind)).toEqual(["file"]);
  });
});

describe("producer ids that do not fit the grammar", () => {
  it("folds review comment ids and keeps the raw id in the draft shape", () => {
    const record = reviewCommentContextRecord({
      id: "pull-request-finding:42",
      sectionId: "s",
      sectionTitle: "t",
      filePath: "a/b.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "L1",
      text: "",
      diff: "",
    });
    expect(record.contextId).toMatch(/^review-comment_pull-request-finding-42-[0-9a-f]{8}$/);
    expect(
      resolveUserMessageContext({
        text: `[b.ts L1](t3-context://v1/review-comment/${record.contextId})`,
        context: { version: 1, records: [record] },
      }).recordsById.has(record.contextId),
    ).toBe(true);
  });
});
