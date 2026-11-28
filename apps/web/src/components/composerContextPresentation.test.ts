import { ChatAttachmentId, ComposerContextId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { composerFileNeedsReattach } from "~/composerDraftStore";
import {
  attachmentContextRecord,
  buildMessageContext,
  isSameComposerContextPayload,
} from "~/lib/composerContextRecords";
import {
  composerContextRecordsFromDraft,
  uploadedContextRecordFromDraft,
} from "./composerContextPresentation";

describe("composerContextRecordsFromDraft", () => {
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

  it("resolves existing queued attachments under their original wire context ids", () => {
    const environmentId = EnvironmentId.make("env-1");
    const imageContextId = ComposerContextId.make("image_local-shot");
    const fileContextId = ComposerContextId.make("file_local-notes");
    const imageId = ChatAttachmentId.make("server-shot");
    const fileId = ChatAttachmentId.make("server-notes");
    const source = {
      kind: "snap-shot" as const,
      capturedAt: "2026-11-22T14:00:00.000Z",
      appName: "Safari",
      windowTitle: "Example",
    };
    const imageAttachment = {
      type: "image" as const,
      id: imageId,
      name: "image.png",
      mimeType: "image/png",
      sizeBytes: 67,
      source,
    };
    const draftRecords = composerContextRecordsFromDraft({
      terminalContexts: [],
      environmentId,
      existingAttachments: [
        {
          attachment: imageAttachment,
          url: "http://127.0.0.1/assets/server-shot",
          contextIds: [imageContextId],
        },
        {
          attachment: {
            type: "file",
            id: fileId,
            name: "notes.txt",
            mimeType: "text/plain",
            sizeBytes: 12,
          },
          url: null,
          contextIds: [fileContextId],
        },
      ],
    });

    const imageEntry = draftRecords.get(imageContextId);
    expect(imageEntry).toMatchObject({
      kind: "image",
      record: {
        id: imageId,
        name: "image.png",
        previewUrl: "http://127.0.0.1/assets/server-shot",
        source,
      },
    });
    const uploadedImageRecord = uploadedContextRecordFromDraft(imageEntry!);
    expect(uploadedImageRecord).toMatchObject({
      kind: "image",
      contextId: imageContextId,
      attachmentId: imageId,
      source,
    });
    expect(
      isSameComposerContextPayload(
        uploadedImageRecord!,
        attachmentContextRecord({
          attachment: imageAttachment,
          attachmentId: imageId,
          contextId: imageContextId,
        }),
      ),
    ).toBe(true);

    const fileEntry = draftRecords.get(fileContextId);
    expect(fileEntry?.kind).toBe("file");
    if (fileEntry?.kind === "file") {
      expect(composerFileNeedsReattach(fileEntry.record)).toBe(false);
      expect(fileEntry.record.uploadEnvironmentId).toBe(environmentId);
    }
    expect(uploadedContextRecordFromDraft(fileEntry!)).toMatchObject({
      kind: "file",
      contextId: fileContextId,
      attachmentId: fileId,
    });
  });
});
