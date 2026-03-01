import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createAttachmentId, resolveAttachmentPathById } from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const [threadSegment] = attachmentId.split("-", 1);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-attachment-store-"));
    try {
      const attachmentId = "thread-1-attachment";
      const attachmentsDir = path.join(stateDir, "attachments");
      fs.mkdirSync(attachmentsDir, { recursive: true });
      const pngPath = path.join(attachmentsDir, `${attachmentId}.png`);
      fs.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        stateDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3code-attachment-store-"));
    try {
      const resolved = resolveAttachmentPathById({
        stateDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      fs.rmSync(stateDir, { recursive: true, force: true });
    }
  });
});
