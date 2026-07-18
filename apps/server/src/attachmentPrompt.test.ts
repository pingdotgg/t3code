// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { appendFileAttachmentPromptText } from "./attachmentPrompt.ts";

const attachmentsDir = NodePath.join(NodePath.sep, "tmp", "t3-attachment-prompt");

describe("attachmentPrompt", () => {
  it("appends a prompt line for file attachments", () => {
    const result = appendFileAttachmentPromptText({
      text: "hello",
      attachmentsDir,
      attachments: [
        {
          type: "file",
          id: "thread-1-00000000-0000-4000-8000-000000000001",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 2048,
        },
      ],
    });
    const attachmentPath = NodePath.join(
      attachmentsDir,
      "thread-1-00000000-0000-4000-8000-000000000001.txt",
    );
    expect(result).toBe(
      `hello\n\n[Attached file: ${attachmentPath} (notes.txt, text/plain, 2.0 KB). Read it from disk when needed.]`,
    );
  });

  it("returns text unchanged when only image attachments are present", () => {
    expect(
      appendFileAttachmentPromptText({
        text: "hello",
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
    ).toBe("hello");
  });

  it("returns only the prompt lines when the text is empty", () => {
    const result = appendFileAttachmentPromptText({
      text: "",
      attachmentsDir,
      attachments: [
        {
          type: "file",
          id: "thread-1-00000000-0000-4000-8000-000000000003",
          name: "data.csv",
          mimeType: "text/csv",
          sizeBytes: 12,
        },
      ],
    });
    const attachmentPath = NodePath.join(
      attachmentsDir,
      "thread-1-00000000-0000-4000-8000-000000000003.csv",
    );
    expect(result).toBe(
      `[Attached file: ${attachmentPath} (data.csv, text/csv, 12 B). Read it from disk when needed.]`,
    );
  });

  it("strips control characters, brackets, and parentheses from attachment names", () => {
    const result = appendFileAttachmentPromptText({
      text: "hello",
      attachmentsDir,
      attachments: [
        {
          type: "file",
          id: "thread-1-00000000-0000-4000-8000-000000000004",
          name: "a(b)\u0001[c].txt",
          mimeType: "text/plain",
          sizeBytes: 5,
        },
      ],
    });
    const attachmentPath = NodePath.join(
      attachmentsDir,
      "thread-1-00000000-0000-4000-8000-000000000004.txt",
    );
    expect(result).toBe(
      `hello\n\n[Attached file: ${attachmentPath} (a b c .txt, text/plain, 5 B). Read it from disk when needed.]`,
    );
  });
});
