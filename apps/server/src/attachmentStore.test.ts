// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  createAttachmentId,
  createPendingAttachmentId,
  parseThreadSegmentFromAttachmentId,
  planAttachmentClaim,
  resolveAttachmentPathById,
  sweepStalePendingAttachments,
  toSafeThreadAttachmentSegment,
  PENDING_ATTACHMENT_MAX_AGE_MS,
} from "./attachmentStore.ts";

function makeTempAttachmentsDir(): string {
  return NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-attachment-store-"));
}

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
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
  });

  it("resolves attachment path by id using the extension that exists on disk", () => {
    const attachmentsDir = makeTempAttachmentsDir();
    try {
      const attachmentId = "thread-1-00000000-0000-4000-8000-00000000000a";
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

  it("resolves a pending id to the renamed thread-scoped file after claim", () => {
    const attachmentsDir = makeTempAttachmentsDir();
    try {
      const uuid = "00000000-0000-4000-8000-00000000000b";
      const scopedPath = NodePath.join(attachmentsDir, `thread-9-${uuid}.png`);
      NodeFS.writeFileSync(scopedPath, Buffer.from("pixels"));

      // Old signed asset URLs carry the pending id; they must keep resolving.
      const resolved = resolveAttachmentPathById({
        attachmentsDir,
        attachmentId: `pending-${uuid}`,
      });
      expect(resolved).toBe(scopedPath);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("reserves the pending segment for uploads", () => {
    expect(toSafeThreadAttachmentSegment("pending")).toBe("pending_thread");
    const pendingId = createPendingAttachmentId();
    expect(parseThreadSegmentFromAttachmentId(pendingId)).toBe("pending");
  });

  describe("planAttachmentClaim", () => {
    const uuid = "00000000-0000-4000-8000-00000000000c";

    it("plans a rename for a pending attachment", () => {
      const attachmentsDir = makeTempAttachmentsDir();
      try {
        const pendingPath = NodePath.join(attachmentsDir, `pending-${uuid}.webp`);
        NodeFS.writeFileSync(pendingPath, Buffer.from("pixels"));

        const claimPlan = planAttachmentClaim({
          attachmentsDir,
          threadId: "Thread.Foo",
          attachmentId: `pending-${uuid}`,
        });
        expect(claimPlan).toEqual({
          ok: true,
          finalId: `thread-foo-${uuid}`,
          currentPath: pendingPath,
          finalPath: NodePath.join(attachmentsDir, `thread-foo-${uuid}.webp`),
          alreadyScoped: false,
        });
      } finally {
        NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
      }
    });

    it("is idempotent when a retry references an already-renamed file", () => {
      const attachmentsDir = makeTempAttachmentsDir();
      try {
        const scopedPath = NodePath.join(attachmentsDir, `thread-foo-${uuid}.webp`);
        NodeFS.writeFileSync(scopedPath, Buffer.from("pixels"));

        const claimPlan = planAttachmentClaim({
          attachmentsDir,
          threadId: "Thread.Foo",
          attachmentId: `pending-${uuid}`,
        });
        expect(claimPlan).toMatchObject({ ok: true, alreadyScoped: true });
      } finally {
        NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
      }
    });

    it("refuses an attachment claimed by another thread", () => {
      const attachmentsDir = makeTempAttachmentsDir();
      try {
        NodeFS.writeFileSync(
          NodePath.join(attachmentsDir, `other-thread-${uuid}.png`),
          Buffer.from("pixels"),
        );

        const claimPlan = planAttachmentClaim({
          attachmentsDir,
          threadId: "Thread.Foo",
          attachmentId: `pending-${uuid}`,
        });
        expect(claimPlan).toMatchObject({ ok: false });
      } finally {
        NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
      }
    });

    it("reports a missing attachment", () => {
      const attachmentsDir = makeTempAttachmentsDir();
      try {
        const claimPlan = planAttachmentClaim({
          attachmentsDir,
          threadId: "Thread.Foo",
          attachmentId: `pending-${uuid}`,
        });
        expect(claimPlan).toMatchObject({ ok: false });
      } finally {
        NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
      }
    });
  });

  describe("sweepStalePendingAttachments", () => {
    it("deletes stale pending and partial files, keeps fresh and scoped ones", () => {
      const attachmentsDir = makeTempAttachmentsDir();
      try {
        const stalePending = NodePath.join(
          attachmentsDir,
          "pending-00000000-0000-4000-8000-000000000001.png",
        );
        const freshPending = NodePath.join(
          attachmentsDir,
          "pending-00000000-0000-4000-8000-000000000002.png",
        );
        const scoped = NodePath.join(
          attachmentsDir,
          "thread-1-00000000-0000-4000-8000-000000000003.png",
        );
        const stalePart = NodePath.join(
          attachmentsDir,
          "pending-00000000-0000-4000-8000-000000000004.png.part",
        );
        // Fixed epoch so the test never touches the real clock: files are
        // stamped relative to `nowMs` below, not to wall time.
        const nowMs = 1_800_000_000_000;
        const freshMs = nowMs - 60_000;
        const staleMs = nowMs - PENDING_ATTACHMENT_MAX_AGE_MS - 60_000;
        for (const filePath of [stalePending, freshPending, scoped, stalePart]) {
          NodeFS.writeFileSync(filePath, Buffer.from("x"));
        }
        NodeFS.utimesSync(freshPending, freshMs / 1000, freshMs / 1000);
        NodeFS.utimesSync(stalePending, staleMs / 1000, staleMs / 1000);
        NodeFS.utimesSync(scoped, staleMs / 1000, staleMs / 1000);
        NodeFS.utimesSync(stalePart, staleMs / 1000, staleMs / 1000);

        const swept = sweepStalePendingAttachments({
          attachmentsDir,
          nowMs,
        });
        expect(swept.deleted).toBe(2);
        expect(NodeFS.existsSync(stalePending)).toBe(false);
        expect(NodeFS.existsSync(stalePart)).toBe(false);
        expect(NodeFS.existsSync(freshPending)).toBe(true);
        expect(NodeFS.existsSync(scoped)).toBe(true);
      } finally {
        NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
      }
    });
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
