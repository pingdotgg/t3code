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
  buildMessageContext,
  composerContextImportLookupIds,
  isSameComposerContextPayload,
  previewAnnotationContextRecord,
  previewAnnotationFromRecord,
  pullRequestContextKindLabel,
  resolveUserMessageContext,
  selectedMessageContextFragment,
  reviewCommentContextRecord,
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

    const atLimit = build(32_000);
    expect(atLimit.diff).toHaveLength(32_000);
    const overLimit = build(32_001);
    expect(overLimit.diff.length).toBeLessThanOrEqual(32_000);
    expect(overLimit.diff.endsWith("… truncated …")).toBe(true);
    expect(() => decodeMessageContext({ version: 1, records: [atLimit] })).not.toThrow();
    expect(() => decodeMessageContext({ version: 1, records: [overLimit] })).not.toThrow();
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
    const imported = { ...canonical, contextId: "legacy_terminal_1" as ComposerContextId };

    expect(isSameComposerContextPayload(canonical, imported)).toBe(true);
    expect(isSameComposerContextPayload(canonical, { ...canonical, text: "B" })).toBe(false);
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

describe("pullRequestContextKindLabel", () => {
  const comment = (url: string, isDraft: boolean) => ({
    id: "pull-request-context:7",
    sectionId: "pull-request:7",
    sectionTitle: "PR #7",
    filePath: "PR #7",
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "Title",
    text: "",
    diff: "",
    pullRequest: {
      number: 7,
      title: "Title",
      url,
      headBranch: "feature",
      baseBranch: "main",
      state: "open" as const,
      isDraft,
    },
  });

  it("names the change request the way its host does", () => {
    expect(pullRequestContextKindLabel(comment("https://github.com/acme/app/pull/7", false))).toBe(
      "Open pull request",
    );
    expect(
      pullRequestContextKindLabel(comment("https://gitlab.com/acme/app/-/merge_requests/7", true)),
    ).toBe("Draft merge request");
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
});
