import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import * as OpenCodeRuntime from "./OpenCodeRuntime.ts";

describe("toOpenCodeFileParts", () => {
  const attachment = (mimeType: string, sizeBytes = 12) => ({
    type: "file" as const,
    id: "thread-1-00000000-0000-4000-8000-000000000001-bin",
    name: "attachment",
    mimeType,
    sizeBytes,
  });

  it("sends supported images, text, and PDFs natively and skips what models reject", () => {
    const parts = OpenCodeRuntime.toOpenCodeFileParts({
      attachments: [
        attachment("application/pdf"),
        attachment("text/plain"),
        attachment("image/png"),
        // ZIP file parts fail Anthropic before turn start; send only the prompt's path line.
        attachment("application/zip"),
        // OpenCode inlines only text/plain; other text MIME parts fail Anthropic/OpenAI.
        attachment("text/html"),
        attachment("text/markdown"),
        attachment("application/octet-stream"),

        attachment("image/bmp"),
        attachment("image/svg+xml"),

        attachment("application/pdf", 21 * 1024 * 1024),
      ],
      resolveAttachmentPath: () => "/tmp/attachment",
    });

    NodeAssert.deepEqual(
      parts.map((part) => part.mime),
      ["application/pdf", "text/plain", "image/png"],
    );
  });

  it("keeps folded clipboard text on the lazy path fallback", () => {
    const parts = OpenCodeRuntime.toOpenCodeFileParts({
      attachments: [
        {
          ...attachment("text/plain"),
          source: { _tag: "pasted-text" as const },
        },
      ],
      resolveAttachmentPath: () => "/tmp/pasted-text.txt",
    });

    NodeAssert.deepEqual(parts, []);
  });
});
