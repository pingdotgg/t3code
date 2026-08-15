// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  attachmentIdBelongsToThread,
  collectTextAttachmentRelativePaths,
  createAttachmentId,
  parseAttachmentIdFromRootEntry,
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
  toOwnedThreadAttachmentSegment,
} from "./attachmentStore.ts";

describe("attachmentStore", () => {
  it("sanitizes thread ids when creating attachment ids", () => {
    const attachmentId = createAttachmentId("thread.folder/unsafe space");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }

    const threadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
    expect(threadSegment).toBeTruthy();
    expect(threadSegment).toMatch(/^[a-z0-9_-]+$/i);
    expect(threadSegment).not.toContain(".");
    expect(threadSegment).not.toContain("%");
    expect(threadSegment).not.toContain("/");
  });

  it("parses exact thread segments from attachment ids without prefix collisions", () => {
    const fooId = "foo-00000000-0000-4000-8000-000000000001";
    const fooBarId = "foo-bar-00000000-0000-4000-8000-000000000002";

    expect(parseThreadSegmentFromAttachmentId(fooId)).toBe("foo");
    expect(parseThreadSegmentFromAttachmentId(fooBarId)).toBe("foo-bar");
  });

  it("normalizes created thread segments to lowercase", () => {
    const attachmentId = createAttachmentId("Thread.Foo");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toMatch(/^thread-foo-[0-9a-f]{64}$/);
  });

  it("uses distinct ownership segments for thread ids with the same safe slug", () => {
    const slashSegment = toOwnedThreadAttachmentSegment("thread/a");
    const dashSegment = toOwnedThreadAttachmentSegment("thread-a");

    expect(slashSegment).toMatch(/^thread-a-[0-9a-f]{64}$/);
    expect(dashSegment).toMatch(/^thread-a-[0-9a-f]{64}$/);
    expect(slashSegment).not.toBe(dashSegment);
    const slashAttachmentId = createAttachmentId("thread/a");
    expect(slashAttachmentId).toBeTruthy();
    if (slashAttachmentId) {
      expect(attachmentIdBelongsToThread(slashAttachmentId, "thread/a")).toBe(true);
      expect(attachmentIdBelongsToThread(slashAttachmentId, "thread-a")).toBe(false);
    }
  });

  it("parses both flat image files and text attachment directories", () => {
    const attachmentId = "thread-1-00000000-0000-4000-8000-000000000001";

    expect(parseAttachmentIdFromRootEntry(`${attachmentId}.png`)).toBe(attachmentId);
    expect(parseAttachmentIdFromRootEntry(attachmentId)).toBe(attachmentId);
    expect(parseAttachmentIdFromRootEntry("unrelated-directory")).toBeNull();
  });

  it("collects generated text attachment paths for the matching thread", () => {
    const attachmentId = createAttachmentId("thread.1");
    const otherAttachmentId = createAttachmentId("thread.10");
    expect(attachmentId).toBeTruthy();
    expect(otherAttachmentId).toBeTruthy();
    if (!attachmentId || !otherAttachmentId) {
      return;
    }
    const text = [
      `[My%20Notes.md](/tmp/attachments/${attachmentId}/My%20Notes.md)`,
      `[Other.md](/tmp/attachments/${otherAttachmentId}/Other.md)`,
    ].join(" ");

    expect(collectTextAttachmentRelativePaths("thread.1", text)).toEqual([
      `${attachmentId}/My Notes.md`,
    ]);
  });

  it("collects encoded Windows text attachment paths", () => {
    const attachmentId = createAttachmentId("thread.1");
    expect(attachmentId).toBeTruthy();
    if (!attachmentId) {
      return;
    }
    const text = `[Notes.md](C:%5Ctmp%5Cattachments%5C${attachmentId}%5CNotes.md)`;

    expect(collectTextAttachmentRelativePaths("thread.1", text)).toEqual([
      `${attachmentId}/Notes.md`,
    ]);
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const attachmentId = "thread-1-attachment";
      const pngPath = NodePath.join(attachmentsDir, `${attachmentId}.png`);
      NodeFS.writeFileSync(pngPath, Buffer.from("hello"));

      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId,
      });
      expect(resolved).toBe(pngPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("returns null when no attachment file exists for the id", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"),
    );
    try {
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: "thread-1-missing",
      });
      expect(resolved).toBeNull();
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
