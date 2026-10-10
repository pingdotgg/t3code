import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildMessageContext } from "~/lib/composerContextRecords";
import {
  composerContextRecordsFromDraft,
  uploadedContextRecordFromDraft,
} from "./composerContextPresentation";

describe("composerContextRecordsFromDraft", () => {
  it("pairs a picked element with its crop, which the draft keeps as an image", () => {
    const annotation = {
      id: "pick-1",
      pageUrl: "http://localhost:3000/",
      pageTitle: "Example",
      comment: "",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      // The draft stores annotations without their data URL.
      screenshot: {
        dataUrl: "",
        width: 10,
        height: 10,
        cropRect: { x: 0, y: 0, width: 10, height: 10 },
      },
      createdAt: "2026-10-08T00:00:00.000Z",
    };
    const crop = {
      type: "image" as const,
      id: "pick-1",
      name: "preview-annotation-pick-1.png",
      mimeType: "image/png",
      sizeBytes: 1,
      previewUrl: "blob:crop",
      file: new File(["x"], "preview-annotation-pick-1.png"),
    };

    expect(
      composerContextRecordsFromDraft({
        terminalContexts: [],
        previewAnnotations: [annotation],
        images: [crop],
      }).get("preview-annotation_pick-1"),
    ).toMatchObject({ kind: "preview-annotation", screenshot: { previewUrl: "blob:crop" } });
  });

  it("recovers the uploaded record when clipboard data points at an attachment already in the draft", () => {
    const file = {
      type: "file" as const,
      id: "file-1",
      name: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 4,
      file: new File(["test"], "file.txt"),
      uploadedAttachmentId: "attachment-1",
    };
    const draftRecord = composerContextRecordsFromDraft({
      terminalContexts: [],
      files: [file],
    }).get("file_file-1");

    expect(draftRecord && uploadedContextRecordFromDraft(draftRecord)).toMatchObject({
      kind: "file",
      contextId: "file_file-1",
      attachmentId: "attachment-1",
    });
  });

  it("resolves each wire reference to its own backing draft even when producer ids collide", () => {
    const id = "same.id:1";
    const terminal = {
      id,
      threadId: ThreadId.make("t1"),
      terminalId: "default",
      terminalLabel: "Terminal",
      lineStart: 1,
      lineEnd: 1,
      text: "output",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    const image = {
      type: "image" as const,
      id,
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 1,
      file: new File(["x"], "shot.png"),
      previewUrl: "blob:shot",
    };
    const file = {
      type: "file" as const,
      id,
      name: "file.txt",
      mimeType: "text/plain",
      sizeBytes: 1,
      file: null,
    };
    const draftRecords = composerContextRecordsFromDraft({
      terminalContexts: [terminal],
      images: [image],
      files: [file],
    });
    const message = buildMessageContext({
      terminalContexts: [terminal],
      reviewComments: [],
      previewAnnotations: [],
      attachments: [
        { attachment: image, attachmentId: "uploaded-image" },
        { attachment: file, attachmentId: "uploaded-file" },
      ],
    })!;
    expect(draftRecords.size).toBe(3);
    for (const record of message.records) {
      expect(draftRecords.get(record.contextId)?.kind).toBe(record.kind);
    }
  });
});
