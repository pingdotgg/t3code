import * as NodeAssert from "node:assert/strict";

import type { ChatAttachment } from "@t3tools/contracts";
import { describe, it } from "vite-plus/test";

import { toOpenCodeFileParts } from "./opencodeRuntime.ts";

function attachment(
  overrides: Partial<ChatAttachment> & Pick<ChatAttachment, "type" | "name">,
): ChatAttachment {
  return {
    id: "attachment_1",
    mimeType: "image/png",
    sizeBytes: 1024,
    ...overrides,
  } as ChatAttachment;
}

describe("toOpenCodeFileParts", () => {
  it("maps supported attachments to file URIs with names", () => {
    const parts = toOpenCodeFileParts({
      attachments: [
        attachment({ type: "image", name: "shot.png", mimeType: "image/png", sizeBytes: 512 }),
        attachment({
          type: "file",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 128,
        }),
        attachment({
          type: "file",
          name: "spec.pdf",
          mimeType: "application/pdf",
          sizeBytes: 4096,
        }),
      ],
      resolveAttachmentPath: (candidate) => `/attachments/${candidate.name}`,
    });

    NodeAssert.deepEqual(parts, [
      { uri: "file:///attachments/shot.png", name: "shot.png" },
      { uri: "file:///attachments/notes.txt", name: "notes.txt" },
      { uri: "file:///attachments/spec.pdf", name: "spec.pdf" },
    ]);
  });

  it("skips pasted-text folds, unsupported mimes, oversized files, and unresolvable paths", () => {
    const parts = toOpenCodeFileParts({
      attachments: [
        attachment({
          type: "file",
          name: "pasted.txt",
          mimeType: "text/plain",
          sizeBytes: 64,
          source: { _tag: "pasted-text" },
        }),
        attachment({ type: "file", name: "archive.zip", mimeType: "application/zip" }),
        attachment({ type: "image", name: "photo.bmp", mimeType: "image/bmp" }),
        attachment({
          type: "image",
          name: "huge.png",
          mimeType: "image/png",
          sizeBytes: 21 * 1024 * 1024,
        }),
        attachment({ type: "image", name: "missing.png", mimeType: "image/png" }),
      ],
      resolveAttachmentPath: (candidate) =>
        candidate.name === "missing.png" ? null : `/attachments/${candidate.name}`,
    });

    NodeAssert.deepEqual(parts, []);
  });

  it("returns no parts without attachments", () => {
    NodeAssert.deepEqual(
      toOpenCodeFileParts({ attachments: undefined, resolveAttachmentPath: () => null }),
      [],
    );
  });
});
