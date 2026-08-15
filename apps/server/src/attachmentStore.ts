// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferImageExtension } from "./imageMime.ts";

const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})$`,
  "i",
);

/**
 * Segment used for attachments uploaded before their thread exists
 * (upload-on-attach). Files named `pending-<uuid>.<ext>` are re-scoped to the
 * thread at turn start and swept when stale.
 */
export const PENDING_ATTACHMENT_THREAD_SEGMENT = "pending";

export function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS)
    .replace(/[-_]+$/g, "");
  if (segment.length === 0) {
    return null;
  }
  // `pending` is reserved for not-yet-sent uploads; a thread that slugged to
  // it would have its attachments swept as orphans.
  if (segment === PENDING_ATTACHMENT_THREAD_SEGMENT) {
    return `${PENDING_ATTACHMENT_THREAD_SEGMENT}_thread`;
  }
  return segment;
}

export function createPendingAttachmentId(): string {
  return `${PENDING_ATTACHMENT_THREAD_SEGMENT}-${NodeCrypto.randomUUID()}`;
}

/** Extracts the trailing uuid from a `<segment>-<uuid>` attachment id. */
export function parseAttachmentUuid(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN);
  return match?.[2]?.toLowerCase() ?? null;
}

/**
 * Finds the on-disk file for an attachment uuid regardless of its current
 * segment (`pending-` before send, thread-scoped after). The uuid is the
 * stable identity: turn-start renames the file's segment but never the uuid,
 * which is what keeps send retries and signed asset URLs working across the
 * rename.
 */
export function findAttachmentPathByUuid(input: {
  readonly attachmentsDir: string;
  readonly uuid: string;
}): string | null {
  const uuid = input.uuid.toLowerCase();
  if (!new RegExp(`^${ATTACHMENT_ID_UUID_PATTERN}$`, "i").test(uuid)) {
    return null;
  }
  let entries: string[];
  try {
    entries = NodeFS.readdirSync(input.attachmentsDir);
  } catch {
    return null;
  }
  const suffixPattern = new RegExp(`-${uuid}\\.[a-z0-9]{1,8}$`, "i");
  for (const entry of entries) {
    if (!suffixPattern.test(entry)) {
      continue;
    }
    const resolved = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: entry,
    });
    if (resolved && NodeFS.existsSync(resolved)) {
      return resolved;
    }
  }
  return null;
}

export function createAttachmentId(threadId: string): string | null {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${NodeCrypto.randomUUID()}`;
}

export function parseThreadSegmentFromAttachmentId(attachmentId: string): string | null {
  const normalizedId = normalizeAttachmentRelativePath(attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  const match = normalizedId.match(ATTACHMENT_ID_PATTERN);
  if (!match) {
    return null;
  }
  return match[1]?.toLowerCase() ?? null;
}

export function attachmentRelativePath(attachment: ChatAttachment): string {
  switch (attachment.type) {
    case "image": {
      const extension = inferImageExtension({
        mimeType: attachment.mimeType,
        fileName: attachment.name,
      });
      return `${attachment.id}${extension}`;
    }
  }
}

export function resolveAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  return resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: attachmentRelativePath(input.attachment),
  });
}

export function resolveAttachmentPathById(input: {
  readonly attachmentsDir: string;
  readonly attachmentId: string;
}): string | null {
  // Resolution is by uuid, not by exact id: a signed asset URL minted for a
  // `pending-` id must keep working after turn start renames the file to its
  // thread segment (draft previews hold such URLs across a send).
  const uuid = parseAttachmentUuid(input.attachmentId);
  if (!uuid) {
    return null;
  }
  return findAttachmentPathByUuid({ attachmentsDir: input.attachmentsDir, uuid });
}

export type AttachmentClaimPlan =
  | {
      readonly ok: true;
      readonly finalId: string;
      readonly currentPath: string;
      readonly finalPath: string;
      /** True when a prior (possibly failed) send already renamed the file. */
      readonly alreadyScoped: boolean;
    }
  | { readonly ok: false; readonly reason: string };

/**
 * Plans the pending-to-thread re-scope for one referenced attachment at turn
 * start. Pure path logic; the caller performs the rename. The uuid is matched
 * against whatever segment the file currently has so retries after a partial
 * send are idempotent, and a file already claimed by a different thread is
 * refused rather than stolen.
 */
export function planAttachmentClaim(input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly attachmentId: string;
}): AttachmentClaimPlan {
  const uuid = parseAttachmentUuid(input.attachmentId);
  if (!uuid) {
    return { ok: false, reason: "invalid attachment id" };
  }
  const threadSegment = toSafeThreadAttachmentSegment(input.threadId);
  if (!threadSegment) {
    return { ok: false, reason: "invalid thread id" };
  }
  const currentPath = findAttachmentPathByUuid({ attachmentsDir: input.attachmentsDir, uuid });
  if (!currentPath) {
    return { ok: false, reason: "attachment not found (removed or expired)" };
  }
  const fileName = NodePath.basename(currentPath);
  const currentId = parseAttachmentIdFromRelativePath(fileName);
  const currentSegment = currentId ? parseThreadSegmentFromAttachmentId(currentId) : null;
  if (!currentSegment) {
    return { ok: false, reason: "attachment file name is malformed" };
  }
  const extension = NodePath.extname(fileName);
  const finalId = `${threadSegment}-${uuid}`;
  if (currentSegment === threadSegment) {
    return { ok: true, finalId, currentPath, finalPath: currentPath, alreadyScoped: true };
  }
  if (currentSegment !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
    return { ok: false, reason: "attachment belongs to another thread" };
  }
  const finalPath = resolveAttachmentRelativePath({
    attachmentsDir: input.attachmentsDir,
    relativePath: `${finalId}${extension}`,
  });
  if (!finalPath) {
    return { ok: false, reason: "failed to resolve attachment path" };
  }
  return { ok: true, finalId, currentPath, finalPath, alreadyScoped: false };
}

export const PENDING_ATTACHMENT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const PARTIAL_UPLOAD_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes never-sent uploads (`pending-*`) past their retention window and
 * half-written `*.part` files left by aborted uploads. Runs at server start;
 * chip removal deletes eagerly, this is the backstop.
 */
export function sweepStalePendingAttachments(input: {
  readonly attachmentsDir: string;
  readonly nowMs: number;
}): { readonly deleted: number } {
  let entries: string[];
  try {
    entries = NodeFS.readdirSync(input.attachmentsDir);
  } catch {
    return { deleted: 0 };
  }
  let deleted = 0;
  for (const entry of entries) {
    const isPartial = entry.endsWith(".part");
    const maxAgeMs = isPartial ? PARTIAL_UPLOAD_MAX_AGE_MS : PENDING_ATTACHMENT_MAX_AGE_MS;
    if (!isPartial) {
      const id = parseAttachmentIdFromRelativePath(entry);
      const segment = id ? parseThreadSegmentFromAttachmentId(id) : null;
      if (segment !== PENDING_ATTACHMENT_THREAD_SEGMENT) {
        continue;
      }
    }
    const resolved = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: entry,
    });
    if (!resolved) {
      continue;
    }
    try {
      const stats = NodeFS.statSync(resolved);
      if (input.nowMs - stats.mtimeMs > maxAgeMs) {
        NodeFS.unlinkSync(resolved);
        deleted += 1;
      }
    } catch {
      // Raced with a concurrent delete or an unreadable entry; skip it.
    }
  }
  return { deleted };
}

export function parseAttachmentIdFromRelativePath(relativePath: string): string | null {
  const normalized = normalizeAttachmentRelativePath(relativePath);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  const extensionIndex = normalized.lastIndexOf(".");
  if (extensionIndex <= 0) {
    return null;
  }
  const id = normalized.slice(0, extensionIndex);
  return id.length > 0 && !id.includes(".") ? id : null;
}
