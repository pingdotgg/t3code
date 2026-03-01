import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

import type { ChatAttachment } from "@t3tools/contracts";

import {
  ATTACHMENTS_ROUTE_PREFIX,
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

const ATTACHMENT_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"];
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;

function toSafeThreadAttachmentSegment(threadId: string): string | null {
  const segment = threadId
    .trim()
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
  const threadSegment = toSafeThreadAttachmentSegment(threadId);
  if (!threadSegment) {
    return null;
  }
  return `${threadSegment}-${randomUUID()}`;
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
  readonly stateDir: string;
  readonly attachment: ChatAttachment;
}): string | null {
  return resolveAttachmentRelativePath({
    stateDir: input.stateDir,
    relativePath: attachmentRelativePath(input.attachment),
  });
}

export function attachmentRoutePath(attachment: ChatAttachment): string {
  return `${ATTACHMENTS_ROUTE_PREFIX}/${encodeURIComponent(attachment.id)}`;
}

export function resolveAttachmentPathById(input: {
  readonly stateDir: string;
  readonly attachmentId: string;
}): string | null {
  const normalizedId = normalizeAttachmentRelativePath(input.attachmentId);
  if (!normalizedId || normalizedId.includes("/") || normalizedId.includes(".")) {
    return null;
  }
  for (const extension of ATTACHMENT_FILENAME_EXTENSIONS) {
    const maybePath = resolveAttachmentRelativePath({
      stateDir: input.stateDir,
      relativePath: `${normalizedId}${extension}`,
    });
    if (maybePath && existsSync(maybePath)) {
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
