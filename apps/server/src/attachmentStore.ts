// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

import type { ChatAttachment } from "@t3tools/contracts";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

const ATTACHMENT_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
const ATTACHMENT_ID_THREAD_HASH_CHARS = 64;
const ATTACHMENT_ID_THREAD_SEGMENT_PATTERN = "[a-z0-9_]+(?:-[a-z0-9_]+)*";
const ATTACHMENT_ID_UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const ATTACHMENT_ID_PATTERN = new RegExp(
  `^(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN})-(${ATTACHMENT_ID_UUID_PATTERN})$`,
  "i",
);

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
  return segment;
}

export function createAttachmentId(threadId: string): string | null {
  const threadSegment = toOwnedThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${NodeCrypto.randomUUID()}`;
}

export function toOwnedThreadAttachmentSegment(threadId: string): string | null {
  const safeSegment = toSafeThreadAttachmentSegment(threadId);
  if (!safeSegment) {
    return null;
  }
  const hash = NodeCrypto.createHash("sha256")
    .update(threadId)
    .digest("hex")
    .slice(0, ATTACHMENT_ID_THREAD_HASH_CHARS);
  const slugMaxChars = ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS - ATTACHMENT_ID_THREAD_HASH_CHARS - 1;
  const slug = safeSegment.slice(0, slugMaxChars).replace(/[-_]+$/g, "");
  return `${slug}-${hash}`;
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

export function attachmentIdBelongsToThread(attachmentId: string, threadId: string): boolean {
  const attachmentThreadSegment = parseThreadSegmentFromAttachmentId(attachmentId);
  if (!attachmentThreadSegment) {
    return false;
  }
  return attachmentThreadSegment === toOwnedThreadAttachmentSegment(threadId);
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
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  for (const extension of ATTACHMENT_FILENAME_EXTENSIONS) {
    const maybePath = resolveAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      relativePath: `${normalizedId}${extension}`,
    });
    if (maybePath && NodeFS.existsSync(maybePath)) {
      return maybePath;
    }
  }
  return null;
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

export function parseAttachmentIdFromRootEntry(entry: string): string | null {
  const normalized = normalizeAttachmentRelativePath(entry);
  if (!normalized || normalized.includes("/")) {
    return null;
  }
  const fileAttachmentId = parseAttachmentIdFromRelativePath(normalized);
  if (fileAttachmentId) {
    return fileAttachmentId;
  }
  return parseThreadSegmentFromAttachmentId(normalized) ? normalized : null;
}

const TEXT_ATTACHMENT_PATH_PATTERN = new RegExp(
  `(?:^|/|%5c)(${ATTACHMENT_ID_THREAD_SEGMENT_PATTERN}-${ATTACHMENT_ID_UUID_PATTERN})(?:/|%5c)([^\\s)]+)`,
  "gi",
);

export function collectTextAttachmentRelativePaths(
  threadId: string,
  text: string,
): ReadonlyArray<string> {
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return [];
  }

  const relativePaths = new Set<string>();
  for (const match of text.matchAll(TEXT_ATTACHMENT_PATH_PATTERN)) {
    const encodedRelativePath = match[0];
    let decodedRelativePath = encodedRelativePath;
    try {
      decodedRelativePath = decodeURIComponent(encodedRelativePath);
    } catch {
      continue;
    }
    const normalized = normalizeAttachmentRelativePath(decodedRelativePath);
    if (!normalized || normalized.split("/").length !== 2) {
      continue;
    }
    const attachmentId = normalized.slice(0, normalized.indexOf("/"));
    if (!attachmentIdBelongsToThread(attachmentId, threadId)) {
      continue;
    }
    relativePaths.add(normalized);
  }
  return [...relativePaths];
}
