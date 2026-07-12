// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ChatAttachment } from "@t3tools/contracts";
import { markdownLinkDestinations } from "@t3tools/shared/markdownLinks";

import {
  normalizeAttachmentRelativePath,
  resolveAttachmentRelativePath,
} from "./attachmentPaths.ts";
import { inferImageExtension, SAFE_IMAGE_FILE_EXTENSIONS } from "./imageMime.ts";

const ATTACHMENT_FILENAME_EXTENSIONS = [...SAFE_IMAGE_FILE_EXTENSIONS, ".bin"];
const TEXT_ATTACHMENT_DIRECTORY = "text";
export const TEXT_ATTACHMENT_METADATA_FILE = ".t3-attachment.json";
export const TEXT_ATTACHMENT_PENDING_DIRECTORY = ".pending";
export const TEXT_ATTACHMENT_DELETE_GRACE_MS = 60_000;
const TEXT_ATTACHMENT_FILE_NAME_MAX_CHARS = 120;
const WINDOWS_RESERVED_FILE_NAME_PATTERN = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
const ATTACHMENT_ID_THREAD_SEGMENT_MAX_CHARS = 80;
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

export function createTextAttachmentPath(input: {
  readonly attachmentsDir: string;
  readonly fileName: string;
}): string {
  const sanitizedName = input.fileName.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/\.+$/, "");
  let safeName =
    sanitizedName.length > 0 && sanitizedName !== "." && sanitizedName !== ".."
      ? sanitizedName
      : "context.txt";
  if (WINDOWS_RESERVED_FILE_NAME_PATTERN.test(safeName)) {
    safeName = `_${safeName}`;
  }
  if (safeName.length > TEXT_ATTACHMENT_FILE_NAME_MAX_CHARS) {
    const extensionIndex = safeName.lastIndexOf(".");
    const extension = extensionIndex > 0 ? safeName.slice(extensionIndex).slice(0, 20) : "";
    safeName = `${safeName.slice(0, TEXT_ATTACHMENT_FILE_NAME_MAX_CHARS - extension.length)}${extension}`;
  }
  return NodePath.join(
    input.attachmentsDir,
    TEXT_ATTACHMENT_DIRECTORY,
    NodeCrypto.randomUUID(),
    safeName,
  );
}

export function textAttachmentRelativePath(input: {
  readonly attachmentsDir: string;
  readonly path: string;
}): string | null {
  const relativePath = NodePath.relative(
    NodePath.resolve(input.attachmentsDir),
    NodePath.resolve(input.path),
  ).replaceAll("\\", "/");
  return /^text\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[^/]+$/i.test(
    relativePath,
  )
    ? relativePath
    : null;
}

export function textAttachmentDirectory(input: {
  readonly attachmentsDir: string;
  readonly path: string;
}): string | null {
  const relativePath = textAttachmentRelativePath(input);
  return relativePath ? NodePath.join(input.attachmentsDir, NodePath.dirname(relativePath)) : null;
}

export function collectTextAttachmentRelativePaths(input: {
  readonly attachmentsDir: string;
  readonly text: string;
}): Set<string> {
  const paths = new Set<string>();
  for (const encodedPath of markdownLinkDestinations(input.text)) {
    let path = encodedPath;
    try {
      path = decodeURIComponent(encodedPath);
    } catch {
      continue;
    }
    const relativePath = textAttachmentRelativePath({
      attachmentsDir: input.attachmentsDir,
      path,
    });
    if (relativePath) paths.add(relativePath);
  }
  return paths;
}

interface TextAttachmentMetadata {
  readonly version: 1;
  readonly claims: ReadonlyArray<string>;
  readonly deleteAfter: number | null;
}

type TextAttachmentMetadataReadResult =
  | { readonly _tag: "Missing" }
  | { readonly _tag: "Invalid" }
  | { readonly _tag: "Valid"; readonly metadata: TextAttachmentMetadata };

const emptyTextAttachmentMetadata = (): TextAttachmentMetadata => ({
  version: 1,
  claims: [],
  deleteAfter: null,
});

function readTextAttachmentMetadata(directory: string): TextAttachmentMetadataReadResult {
  try {
    const parsed = JSON.parse(
      NodeFS.readFileSync(NodePath.join(directory, TEXT_ATTACHMENT_METADATA_FILE), "utf8"),
    ) as Partial<TextAttachmentMetadata>;
    if (parsed.version !== 1 || !Array.isArray(parsed.claims)) {
      return { _tag: "Invalid" };
    }
    if (
      parsed.claims.some((claim) => typeof claim !== "string") ||
      (parsed.deleteAfter !== null && typeof parsed.deleteAfter !== "number")
    ) {
      return { _tag: "Invalid" };
    }
    return {
      _tag: "Valid",
      metadata: {
        version: 1,
        claims: [...new Set(parsed.claims as ReadonlyArray<string>)],
        deleteAfter: parsed.deleteAfter ?? null,
      },
    };
  } catch (cause) {
    return typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT"
      ? { _tag: "Missing" }
      : { _tag: "Invalid" };
  }
}

function metadataForMutation(directory: string): TextAttachmentMetadata {
  const result = readTextAttachmentMetadata(directory);
  if (result._tag === "Invalid") {
    throw new Error("Text attachment metadata is unreadable or malformed.");
  }
  return result._tag === "Valid" ? result.metadata : emptyTextAttachmentMetadata();
}

function writeTextAttachmentMetadata(directory: string, metadata: TextAttachmentMetadata): void {
  const metadataPath = NodePath.join(directory, TEXT_ATTACHMENT_METADATA_FILE);
  const temporaryPath = `${metadataPath}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(temporaryPath, JSON.stringify(metadata));
  NodeFS.renameSync(temporaryPath, metadataPath);
}

function textAttachmentPendingPath(attachmentsDir: string, directory: string): string {
  return NodePath.join(
    attachmentsDir,
    TEXT_ATTACHMENT_DIRECTORY,
    TEXT_ATTACHMENT_PENDING_DIRECTORY,
    `${NodePath.basename(directory)}.json`,
  );
}

function removeTextAttachmentPendingMarker(attachmentsDir: string, directory: string): void {
  NodeFS.rmSync(textAttachmentPendingPath(attachmentsDir, directory), { force: true });
}

function writeTextAttachmentPendingMarker(
  attachmentsDir: string,
  directory: string,
  deleteAfter: number,
): void {
  const pendingPath = textAttachmentPendingPath(attachmentsDir, directory);
  NodeFS.mkdirSync(NodePath.dirname(pendingPath), { recursive: true });
  const temporaryPath = `${pendingPath}.${NodeCrypto.randomUUID()}.tmp`;
  NodeFS.writeFileSync(temporaryPath, JSON.stringify({ deleteAfter }));
  NodeFS.renameSync(temporaryPath, pendingPath);
}

export function claimTextAttachment(input: {
  readonly attachmentsDir: string;
  readonly path: string;
  readonly draftOwnerId: string;
}): boolean {
  const directory = textAttachmentDirectory(input);
  if (!directory || !NodeFS.existsSync(input.path)) return false;
  const metadata = metadataForMutation(directory);
  writeTextAttachmentMetadata(directory, {
    version: 1,
    claims: [...new Set([...metadata.claims, input.draftOwnerId])],
    deleteAfter: null,
  });
  removeTextAttachmentPendingMarker(input.attachmentsDir, directory);
  return true;
}

export function writeClaimedTextAttachment(
  input: {
    readonly attachmentsDir: string;
    readonly fileName: string;
    readonly contents: string;
    readonly draftOwnerId: string;
  },
  claim: typeof claimTextAttachment = claimTextAttachment,
): string {
  const attachmentPath = createTextAttachmentPath(input);
  const directory = NodePath.dirname(attachmentPath);
  try {
    NodeFS.mkdirSync(directory, { recursive: true });
    NodeFS.writeFileSync(attachmentPath, input.contents);
    if (
      !claim({
        attachmentsDir: input.attachmentsDir,
        path: attachmentPath,
        draftOwnerId: input.draftOwnerId,
      })
    ) {
      throw new Error("Failed to create the initial text attachment claim.");
    }
    return attachmentPath;
  } catch (cause) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
    throw cause;
  }
}

export function releaseTextAttachment(input: {
  readonly attachmentsDir: string;
  readonly path: string;
  readonly draftOwnerId: string;
  readonly nowMs: number;
}): boolean {
  const directory = textAttachmentDirectory(input);
  if (!directory || !NodeFS.existsSync(input.path)) return false;
  const metadata = metadataForMutation(directory);
  if (!metadata.claims.includes(input.draftOwnerId)) {
    if (metadata.deleteAfter === null) return false;
    writeTextAttachmentPendingMarker(input.attachmentsDir, directory, metadata.deleteAfter);
    return true;
  }
  const claims = metadata.claims.filter((claim) => claim !== input.draftOwnerId);
  writeTextAttachmentMetadata(directory, {
    version: 1,
    claims,
    deleteAfter: claims.length === 0 ? input.nowMs + TEXT_ATTACHMENT_DELETE_GRACE_MS : null,
  });
  if (claims.length === 0) {
    writeTextAttachmentPendingMarker(
      input.attachmentsDir,
      directory,
      input.nowMs + TEXT_ATTACHMENT_DELETE_GRACE_MS,
    );
  } else {
    removeTextAttachmentPendingMarker(input.attachmentsDir, directory);
  }
  return true;
}

export function reconcileTextAttachments(input: {
  readonly attachmentsDir: string;
  readonly retainedRelativePaths: ReadonlySet<string>;
  readonly nowMs: number;
}): { readonly pending: number; readonly removed: number } {
  const textRoot = NodePath.join(input.attachmentsDir, TEXT_ATTACHMENT_DIRECTORY);
  let pending = 0;
  let removed = 0;
  let entries: ReadonlyArray<string>;
  try {
    entries = NodeFS.readdirSync(textRoot);
  } catch {
    return { pending, removed };
  }
  const retainedDirectories = new Set(
    [...input.retainedRelativePaths].map((relativePath) => NodePath.dirname(relativePath)),
  );
  const nowMs = input.nowMs;
  for (const entry of entries) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry)) {
      continue;
    }
    const directory = NodePath.join(textRoot, entry);
    let stat: NodeFS.Stats;
    try {
      stat = NodeFS.statSync(directory);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    const metadataResult = readTextAttachmentMetadata(directory);
    if (metadataResult._tag === "Invalid") continue;
    const metadata =
      metadataResult._tag === "Valid" ? metadataResult.metadata : emptyTextAttachmentMetadata();
    const relativeDirectory = `${TEXT_ATTACHMENT_DIRECTORY}/${entry}`;
    if (retainedDirectories.has(relativeDirectory) || metadata.claims.length > 0) {
      if (metadata.deleteAfter !== null) {
        writeTextAttachmentMetadata(directory, { ...metadata, deleteAfter: null });
      }
      removeTextAttachmentPendingMarker(input.attachmentsDir, directory);
      continue;
    }
    if (metadata.deleteAfter === null) {
      writeTextAttachmentMetadata(directory, {
        ...metadata,
        deleteAfter: nowMs + TEXT_ATTACHMENT_DELETE_GRACE_MS,
      });
      writeTextAttachmentPendingMarker(
        input.attachmentsDir,
        directory,
        nowMs + TEXT_ATTACHMENT_DELETE_GRACE_MS,
      );
      pending += 1;
      continue;
    }
    if (metadata.deleteAfter > nowMs) {
      writeTextAttachmentPendingMarker(input.attachmentsDir, directory, metadata.deleteAfter);
      pending += 1;
      continue;
    }
    NodeFS.rmSync(directory, { recursive: true, force: true });
    removeTextAttachmentPendingMarker(input.attachmentsDir, directory);
    removed += 1;
  }
  return { pending, removed };
}
