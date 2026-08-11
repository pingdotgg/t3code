// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { appendFileAttachmentPromptText } from "./attachmentPrompt.ts";

const attachmentsDir = NodePath.join(NodePath.sep, "tmp", "t3-attachment-prompt");

describe("attachmentPrompt", () => {
  it("appends a filesystem reference for non-image attachments", () => {
    const result = appendFileAttachmentPromptText({
      text: "Review this spreadsheet",
      attachmentsDir,
      attachments: [
        {
          type: "file",
          id: "thread-1-00000000-0000-4000-8000-000000000001",
          name: "report.csv",
          mimeType: "text/csv",
          sizeBytes: 2_048,
        },
      ],
    });

    expect(result).toContain("[Attached file:");
    expect(result).toContain("report.csv, text/csv, 2.0 KB");
    expect(result).toContain("Read it from disk when needed.");
  });

  it("leaves image-only prompts unchanged", () => {
    expect(
      appendFileAttachmentPromptText({
        text: "Look at this",
        attachmentsDir,
        attachments: [
          {
            type: "image",
            id: "thread-1-00000000-0000-4000-8000-000000000002",
            name: "screen.png",
            mimeType: "image/png",
            sizeBytes: 4,
          },
        ],
      }),
    ).toBe("Look at this");
  });
});
