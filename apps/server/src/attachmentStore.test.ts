// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  collectTextAttachmentRelativePaths,
  claimTextAttachment,
  createAttachmentId,
  createTextAttachmentPath,
  parseThreadSegmentFromAttachmentId,
  reconcileTextAttachments,
  releaseTextAttachment,
  resolveAttachmentPathById,
  TEXT_ATTACHMENT_DELETE_GRACE_MS,
  TEXT_ATTACHMENT_METADATA_FILE,
  TEXT_ATTACHMENT_PENDING_DIRECTORY,
  writeClaimedTextAttachment,
  textAttachmentDirectory,
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
    expect(parseThreadSegmentFromAttachmentId(attachmentId)).toBe("thread-foo");
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

  it("creates normalized text attachment paths under the environment attachment store", () => {
    const attachmentsDir = NodePath.join(NodeOS.tmpdir(), "t3code-attachments");
    const attachmentPath = createTextAttachmentPath({
      attachmentsDir,
      fileName: "../unsafe name.ts",
    });

    expect(NodePath.relative(attachmentsDir, attachmentPath)).toMatch(
      /^text[/\\][0-9a-f-]+[/\\]\.\.-unsafe-name\.ts$/,
    );
    expect(attachmentPath).not.toContain(`${NodePath.sep}..${NodePath.sep}`);
  });

  it("removes a written attachment when its initial claim fails", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-text-write-claim-"),
    );
    try {
      expect(() =>
        writeClaimedTextAttachment(
          {
            attachmentsDir,
            fileName: "context.md",
            contents: "context",
            draftOwnerId: "draft-owner",
          },
          () => false,
        ),
      ).toThrow(/initial text attachment claim/);
      expect(NodeFS.readdirSync(NodePath.join(attachmentsDir, "text"))).toEqual([]);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("bounds text attachment basenames and avoids Windows reserved names", () => {
    const attachmentsDir = NodePath.join(NodeOS.tmpdir(), "t3code-attachments");
    const reservedPath = createTextAttachmentPath({ attachmentsDir, fileName: "CON.ts" });
    const longPath = createTextAttachmentPath({
      attachmentsDir,
      fileName: `${"a".repeat(300)}.tsx`,
    });

    expect(NodePath.basename(reservedPath)).toBe("_CON.ts");
    expect(NodePath.basename(longPath)).toHaveLength(120);
    expect(NodePath.basename(longPath)).toMatch(/\.tsx$/);
  });

  it("validates and collects server-owned text attachment paths", () => {
    const attachmentsDir = NodePath.join(NodeOS.tmpdir(), "t3code-(attachments)");
    const attachmentPath = createTextAttachmentPath({ attachmentsDir, fileName: "notes.txt" });
    const encodedPath = encodeURI(attachmentPath).replaceAll("\\", "%5C");

    expect(textAttachmentDirectory({ attachmentsDir, path: attachmentPath })).toBe(
      NodePath.dirname(attachmentPath),
    );
    expect(
      collectTextAttachmentRelativePaths({
        attachmentsDir,
        text: `before[notes.txt](${encodedPath}),after`,
      }),
    ).toEqual(new Set([NodePath.relative(attachmentsDir, attachmentPath).replaceAll("\\", "/")]));
    expect(
      textAttachmentDirectory({ attachmentsDir, path: NodePath.join(attachmentsDir, "../nope") }),
    ).toBeNull();
  });

  it("persists draft claims across reconciliation and restart-style reloads", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-text-claims-"),
    );
    try {
      const attachmentPath = createTextAttachmentPath({ attachmentsDir, fileName: "draft.md" });
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, "draft");
      expect(
        claimTextAttachment({
          attachmentsDir,
          path: attachmentPath,
          draftOwnerId: "draft-owner",
        }),
      ).toBe(true);

      reconcileTextAttachments({
        attachmentsDir,
        retainedRelativePaths: new Set(),
        nowMs: TEXT_ATTACHMENT_DELETE_GRACE_MS * 10,
      });

      expect(NodeFS.existsSync(attachmentPath)).toBe(true);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("cancels pending deletion when a copied draft reclaims an attachment", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-text-reclaim-"),
    );
    try {
      const attachmentPath = createTextAttachmentPath({ attachmentsDir, fileName: "draft.md" });
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, "draft");
      claimTextAttachment({ attachmentsDir, path: attachmentPath, draftOwnerId: "original" });
      expect(
        releaseTextAttachment({
          attachmentsDir,
          path: attachmentPath,
          draftOwnerId: "original",
          nowMs: 1_000,
        }),
      ).toBe(true);
      expect(
        claimTextAttachment({ attachmentsDir, path: attachmentPath, draftOwnerId: "copy" }),
      ).toBe(true);

      reconcileTextAttachments({
        attachmentsDir,
        retainedRelativePaths: new Set(),
        nowMs: 1_000 + TEXT_ATTACHMENT_DELETE_GRACE_MS + 1,
      });

      expect(NodeFS.existsSync(attachmentPath)).toBe(true);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("deletes only expired unclaimed and unreferenced text attachments", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-text-expiry-"),
    );
    try {
      const attachmentPath = createTextAttachmentPath({ attachmentsDir, fileName: "orphan.md" });
      NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
      NodeFS.writeFileSync(attachmentPath, "orphan");

      reconcileTextAttachments({
        attachmentsDir,
        retainedRelativePaths: new Set(),
        nowMs: 1_000,
      });
      expect(NodeFS.existsSync(attachmentPath)).toBe(true);

      reconcileTextAttachments({
        attachmentsDir,
        retainedRelativePaths: new Set(),
        nowMs: 1_000 + TEXT_ATTACHMENT_DELETE_GRACE_MS + 1,
      });
      expect(NodeFS.existsSync(attachmentPath)).toBe(false);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });

  it("preserves malformed metadata during full reconciliation", () => {
    const attachmentsDir = NodeFS.mkdtempSync(
      NodePath.join(NodeOS.tmpdir(), "t3code-text-invalid-metadata-"),
    );
    try {
      const attachmentPath = createTextAttachmentPath({ attachmentsDir, fileName: "keep.md" });
      const directory = NodePath.dirname(attachmentPath);
      const metadataPath = NodePath.join(directory, TEXT_ATTACHMENT_METADATA_FILE);
      const pendingPath = NodePath.join(
        attachmentsDir,
        "text",
        TEXT_ATTACHMENT_PENDING_DIRECTORY,
        `${NodePath.basename(directory)}.json`,
      );
      NodeFS.mkdirSync(directory, { recursive: true });
      NodeFS.writeFileSync(attachmentPath, "keep");
      NodeFS.writeFileSync(metadataPath, "malformed");

      reconcileTextAttachments({
        attachmentsDir,
        retainedRelativePaths: new Set(),
        nowMs: Number.MAX_SAFE_INTEGER,
      });

      expect(NodeFS.existsSync(attachmentPath)).toBe(true);
      expect(NodeFS.readFileSync(metadataPath, "utf8")).toBe("malformed");
      expect(NodeFS.existsSync(pendingPath)).toBe(false);
    } finally {
      NodeFS.rmSync(attachmentsDir, { recursive: true, force: true });
    }
  });
});
