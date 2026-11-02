import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { FilePreviewItem } from "../components/FilePreviewModal.types";
import type { DraftComposerAttachment } from "./composerImages";
import { composerImageGallery } from "./composerImageGallery";
import { messageImageGallery } from "../features/threads/messageImageGallery";
import { filePreviewGallery, filePreviewKey } from "./filePreviewGallery";

vi.mock("./uuid", () => ({}));

describe("image preview groups", () => {
  it.each([false, true])(
    "keeps one entry per image through upload and delivery (file: %s)",
    (fileBacked) => {
      const environmentId = EnvironmentId.make("test");
      const context = { environmentId, threadId: ThreadId.make("thread"), workspaceRoot: null };
      const attachments: DraftComposerAttachment[] = ["a", "b"].map((id) => ({
        id,
        type: "image",
        name: `${id}.png`,
        mimeType: "image/png",
        sizeBytes: 3,
        previewUri: `data:image/png;base64,${id}`,
        ...(fileBacked ? { fileUri: `file:///documents/${id}.png` } : {}),
      }));
      const delivered = (id: string) =>
        messageImageGallery(
          {
            text: "",
            attachments: [
              {
                type: "image",
                id: `uploaded-${id}`,
                name: `${id}.png`,
                mimeType: "image/png",
                sizeBytes: 3,
              },
            ],
          },
          context,
        )[0]!;
      const local = composerImageGallery(attachments, environmentId);
      const uploading = composerImageGallery(
        [{ ...attachments[0]!, uploadedAttachmentId: "uploaded-a" }, attachments[1]!],
        environmentId,
      );
      const uploaded = composerImageGallery(
        attachments.map((attachment) => ({
          ...attachment,
          uploadedAttachmentId: `uploaded-${attachment.id}`,
        })),
        environmentId,
      );
      for (const [selected, gallery] of [
        [local[0]!, local],
        [delivered("a"), uploading],
        [uploading[1]!, uploading],
        [delivered("a"), uploaded],
        [delivered("a"), [...uploaded, delivered("a"), delivered("b")]],
        [delivered("a"), [delivered("a"), delivered("b")]],
      ] as const) {
        const result = filePreviewGallery(selected, gallery);
        expect(result).toHaveLength(2);
        expect(result.map(filePreviewKey)).toEqual([...new Set(gallery.map(filePreviewKey))]);
      }
      expect(composerImageGallery(attachments)).toEqual(local);
    },
  );

  it("matches remote originals despite metadata and property order differences", () => {
    const environmentId = EnvironmentId.make("test");
    const a: FilePreviewItem = {
      kind: "image",
      environmentId,
      resource: { _tag: "attachment", attachmentId: "a", fileName: "old.png" },
    };
    const b: FilePreviewItem = {
      kind: "image",
      environmentId,
      resource: {
        attachmentId: "a",
        _tag: "attachment",
        fileName: "new.png",
        mimeType: "image/png",
      },
    };
    expect(filePreviewKey(a)).toBe(filePreviewKey(b));
    expect(filePreviewGallery(b, [a])).toEqual([b]);
  });
});
