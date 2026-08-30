import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AttachmentMcpDiscardUploadInput,
  AttachmentMcpPrepareUploadInput,
} from "./attachmentMcp.ts";

const decodePrepare = Schema.decodeUnknownSync(AttachmentMcpPrepareUploadInput);

describe("attachment MCP contracts", () => {
  it("keeps upload and discard tool schemas rooted at objects", () => {
    expect(Schema.toJsonSchemaDocument(AttachmentMcpPrepareUploadInput).schema.type).toBe("object");
    expect(Schema.toJsonSchemaDocument(AttachmentMcpDiscardUploadInput).schema.type).toBe("object");
  });

  it("accepts bounded image and file uploads", () => {
    expect(
      decodePrepare({ name: "screen.png", mimeType: "image/png", sizeBytes: 4 }),
    ).toMatchObject({ mimeType: "image/png", sizeBytes: 4 });
    expect(
      decodePrepare({
        type: "file",
        name: "report.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4,
      }),
    ).toMatchObject({ type: "file", mimeType: "application/pdf" });
  });

  it("rejects unsupported image types and image-sized payloads above the image limit", () => {
    expect(() =>
      decodePrepare({ name: "vector.svg", mimeType: "image/svg+xml", sizeBytes: 4 }),
    ).toThrow();
    expect(() =>
      decodePrepare({ name: "large.png", mimeType: "image/png", sizeBytes: 10 * 1024 * 1024 + 1 }),
    ).toThrow();
  });
});
