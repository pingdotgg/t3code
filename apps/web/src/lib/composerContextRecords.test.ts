import {
  type ComposerContextId,
  EnvironmentId,
  MessageId,
  OrchestrationMessageContext,
  ThreadId,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { upgradeLegacyContextMessage } from "@t3tools/shared/composerContextLegacy";

import {
  formatInlineContextReference,
  removeInlineContextReference,
} from "./composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import {
  asKnownContextRecord,
  attachmentContextRecord,
  buildMessageContext,
  composerContextImportLookupIds,
  isPullRequestSummaryContext,
  isSameComposerContextPayload,
  pullRequestContextDisplayState,
  pullRequestContextKindLabel,
  previewAnnotationContextLabel,
  previewAnnotationContextRecord,
  previewAnnotationFromRecord,
  resolveUserMessageContext,
  selectedMessageContextFragment,
  reviewCommentContextLabel,
  reviewCommentContextRecord,
  reviewCommentFromRecord,
  terminalContextRecord,
  terminalContextReference,
  terminalContextDraftFromRecord,
  uploadedAttachmentContextRecord,
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
  it("copies only ready or persisted server-side attachment IDs", () => {
    const environmentId = EnvironmentId.make("env");
    const image = {
      type: "image" as const,
      id: "local-image",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 1,
      file: new File(["x"], "shot.png"),
      previewUrl: "blob:shot",
    };
    expect(uploadedAttachmentContextRecord(image, undefined)).toBeNull();
    expect(
      uploadedAttachmentContextRecord(image, { status: "uploading", environmentId, progress: 0.5 }),
    ).toBeNull();
    expect(
      uploadedAttachmentContextRecord(image, {
        status: "failed",
        environmentId,
        reason: "offline",
        attachmentId: "unfinished",
      }),
    ).toBeNull();
    expect(
      uploadedAttachmentContextRecord(image, {
        status: "ready",
        environmentId,
        attachmentId: "uploaded-image",
      }),
    ).toMatchObject({ attachmentId: "uploaded-image", contextId: "image_local-image" });
    const file = {
      type: "file" as const,
      id: "local-file",
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      file: null,
    };
    expect(uploadedAttachmentContextRecord(file, undefined)).toBeNull();
    expect(
      uploadedAttachmentContextRecord(
        { ...file, uploadedAttachmentId: "persisted-file", uploadEnvironmentId: environmentId },
        undefined,
      ),
    ).toMatchObject({ attachmentId: "persisted-file", contextId: "file_local-file" });
  });
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
  it.each(["x", "terminal_x"])(
    "preserves canonical terminal IDs across repeated imports: %s",
    (id) => {
      const threadId = ThreadId.make("t1");
      const record = terminalContextRecord({
        id,
        threadId,
        terminalId: "default",
        terminalLabel: "Terminal",
        lineStart: 1,
        lineEnd: 1,
        text: "output",
        createdAt: "2026-01-01T00:00:00.000Z",
      });
      const restored = terminalContextRecord(terminalContextDraftFromRecord(record, threadId));
      expect(restored).toEqual(record);
      expect(terminalContextRecord(terminalContextDraftFromRecord(restored, threadId))).toEqual(
        record,
      );
    },
  );

  it.each(["x", "review-comment_x"])("preserves canonical review IDs across imports: %s", (id) => {
    const record = reviewCommentContextRecord({
      id,
      sectionId: "s",
      sectionTitle: "Review",
      filePath: "a.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "L1",
      text: "Review",
      diff: "",
    });
    expect(reviewCommentContextRecord(reviewCommentFromRecord(record))).toEqual(record);
  });

  it.each(["x", "preview-annotation_x"])(
    "preserves canonical annotation IDs across imports: %s",
    (id) => {
      const record = previewAnnotationContextRecord({ ...annotation, id });
      expect(previewAnnotationContextRecord(previewAnnotationFromRecord(record)).contextId).toBe(
        record.contextId,
      );
    },
  );
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
    expect(decodeMessageContext(context).records.map((record) => record.contextId)).toEqual([
      "image_x",
      "image_image_x",
    ]);
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
    expect(decodeMessageContext(context).records).toHaveLength(5);
    const preview = context.records.find((record) => record.kind === "preview-annotation");
    const image = context.records.find((record) => record.kind === "image");
    expect(preview).toMatchObject({ screenshotContextId: image!.contextId });
    expect(image).toMatchObject({ attachmentId: "uploaded-image" });
  });

  it("restores multiple edits on one target without parsing display strings", () => {
    const styleChanges = [
      ...annotation.styleChanges,
      {
        targetId: "el_1",
        selector: "#pay",
        property: "content",
        previousValue: "a → b",
        value: "first\nsecond → third",
      },
    ];
    const restored = previewAnnotationFromRecord(
      previewAnnotationContextRecord({ ...annotation, styleChanges }),
    );
    expect(restored.styleChanges).toEqual(styleChanges);
    expect(restored.elements[0]?.id).toBe("el_1");
  });
  it.each([
    ["+181", "a.ts L181"],
    ["+181 to +183", "a.ts L181 to L183"],
    ["-63", "a.ts L63 (before)"],
    ["L4", "a.ts L4"],
  ])("presents review range %s consistently as %s", (rangeLabel, expected) => {
    expect(
      reviewCommentContextLabel({
        id: "review-1",
        sectionId: "file:src/a.ts",
        sectionTitle: "File comment",
        filePath: "src/a.ts",
        startIndex: 0,
        endIndex: 0,
        rangeLabel,
        text: "",
        diff: "",
      }),
    ).toBe(expected);
  });

  it("distinguishes a PR summary from a comment on its diff", () => {
    const summary = {
      id: "review-1",
      sectionId: "pull-request:42",
      sectionTitle: "PR #42",
      filePath: "PR #42",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "Improve context chips",
      text: "Pull request details",
      diff: "",
      pullRequest: {
        number: 42,
        title: "Improve context chips",
        url: "https://github.com/pingdotgg/t3code/pull/42",
        headBranch: "feat/context-chips",
        baseBranch: "main",
        state: "open" as const,
        isDraft: false,
      },
    };

    expect(isPullRequestSummaryContext(summary)).toBe(true);
    expect(reviewCommentContextLabel(summary)).toBe("#42");
    expect(pullRequestContextDisplayState(summary)).toBe("open");
    expect(pullRequestContextKindLabel(summary)).toBe("Open pull request");
    expect(
      pullRequestContextDisplayState({
        ...summary,
        pullRequest: { ...summary.pullRequest, isDraft: true },
      }),
    ).toBe("draft");
    expect(
      isPullRequestSummaryContext({
        ...summary,
        pullRequest: undefined,
        filePath: "src/a.ts",
        rangeLabel: "+12",
        diff: "+const answer = 42;",
      }),
    ).toBe(false);
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

  it("keeps a region-only annotation's target summary and screenshot across a round trip", () => {
    const regionOnly: PreviewAnnotationPayload = {
      ...annotation,
      elements: [],
      styleChanges: [],
      regions: [{ id: "rg_1", rect: { x: 1, y: 2, width: 3, height: 4 } }],
    };
    const record = previewAnnotationContextRecord(regionOnly, { screenshotContextId: "ann_1" });
    expect(record.targetSummary).toBe("1 marked region");
    expect(record.screenshotContextId).toBe("image_ann_1");

    // Re-encoding what a paste rebuilt must not empty the summary or drop the screenshot.
    const reencoded = previewAnnotationContextRecord(previewAnnotationFromRecord(record), {
      screenshotContextId: "ann_1",
    });
    expect(reencoded.targetSummary).toBe("1 marked region");
    expect(reencoded.screenshotContextId).toBe("image_ann_1");
  });

  it("treats colliding ids with different payloads as distinct records", () => {
    const base = terminalContextRecord({
      id: "term-1",
      threadId: ThreadId.make("t"),
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 1,
      lineEnd: 2,
      text: "A",
    });
    expect(isSameComposerContextPayload(base, { ...base })).toBe(true);
    // Labels are display text, never identity.
    expect(isSameComposerContextPayload(base, { ...base, label: "different" })).toBe(true);
    expect(isSameComposerContextPayload(base, { ...base, text: "B" })).toBe(false);
  });

  it("finds the destination collision for different legacy terminal messages", () => {
    const legacy = (text: string) =>
      asKnownContextRecord(
        upgradeLegacyContextMessage(
          `Inspect this\n\n<terminal_context>\n- Terminal 1 line 1:\n  1 | ${text}\n</terminal_context>`,
        ).records[0],
      )!;
    const first = legacy("A");
    const second = legacy("B");
    if (first.kind !== "terminal" || second.kind !== "terminal") {
      throw new Error("Expected legacy terminal records");
    }
    const destinationId = terminalContextReference(
      terminalContextDraftFromRecord(first, ThreadId.make("t")),
    ).contextId;

    expect(destinationId).toBe("terminal_legacy_terminal_1");
    expect(composerContextImportLookupIds(second)[0]).toBe(destinationId);
    expect(isSameComposerContextPayload(first, second)).toBe(false);
  });

  it("treats an imported legacy id and its canonical reconstruction as the same excerpt", () => {
    const draft = {
      id: "term-1",
      threadId: ThreadId.make("t"),
      createdAt: "2026-01-01T00:00:00.000Z",
      terminalId: "default",
      terminalLabel: "Terminal 1",
      lineStart: 1,
      lineEnd: 2,
      text: "A",
    };
    const canonical = terminalContextRecord(draft);
    // An import carries the id it was sent with; the draft rebuilds the folded
    // canonical form. Same payload either way, so no duplicate entry may form.
    const imported = { ...canonical, contextId: "legacy_terminal_1" as ComposerContextId };

    expect(isSameComposerContextPayload(canonical, imported)).toBe(true);
    expect(isSameComposerContextPayload(canonical, { ...canonical, text: "B" })).toBe(false);
  });

  it("compares nested annotation element and source payloads", () => {
    const base = previewAnnotationContextRecord(annotation);
    expect(isSameComposerContextPayload(base, { ...base, label: "Different display label" })).toBe(
      true,
    );
    expect(
      isSameComposerContextPayload(base, {
        ...base,
        elements: base.elements?.map((element) => ({
          ...element,
          htmlPreview: '<button id="pay">Changed</button>',
        })),
      }),
    ).toBe(false);
    expect(
      isSameComposerContextPayload(base, {
        ...base,
        elements: base.elements?.map((element) => ({
          ...element,
          source: {
            functionName: "Checkout",
            fileName: "src/Checkout.tsx",
            lineNumber: 20,
            columnNumber: 4,
          },
        })),
      }),
    ).toBe(false);
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
    expect(record.contextId).toMatch(/^review-comment_pull-request-finding-42-[0-9a-f]{16}$/);
    expect(
      resolveUserMessageContext({
        text: `[b.ts L1](t3-context://v1/review-comment/${record.contextId})`,
        context: { version: 1, records: [record] },
      }).recordsById.has(record.contextId),
    ).toBe(true);
  });
});

describe("selectedMessageContextFragment", () => {
  const terminal = terminalContextRecord({
    id: "term-1",
    threadId: ThreadId.make("t"),
    createdAt: "2026-01-01T00:00:00.000Z",
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 1,
    lineEnd: 1,
    text: "A",
  });
  const review = reviewCommentContextRecord({
    id: "rc-1",
    sectionId: "s",
    sectionTitle: "t",
    filePath: "a/b.ts",
    startIndex: 3,
    endIndex: 3,
    rangeLabel: "L4",
    text: "",
    diff: "",
  });
  const input = {
    records: [terminal, review],
    environmentId: EnvironmentId.make("env"),
    threadId: ThreadId.make("t"),
    messageId: MessageId.make("msg-1"),
  };

  it("carries only records for chips inside the selection", () => {
    const fragment = selectedMessageContextFragment({
      ...input,
      markdown: `see [b.ts L4](t3-context://v1/review-comment/${review.contextId})`,
    });

    expect(fragment).toContain(review.contextId);
    expect(fragment).not.toContain(terminal.contextId);
  });

  it("returns null when no selected chip has backing records", () => {
    expect(selectedMessageContextFragment({ ...input, markdown: "just prose" })).toBeNull();
    expect(
      selectedMessageContextFragment({
        ...input,
        records: [],
        markdown: `[b.ts L4](t3-context://v1/review-comment/${review.contextId})`,
      }),
    ).toBeNull();
  });
});
