// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  ChatAttachmentId,
  type ChatAttachment,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  attachmentRelativePath,
  createDeterministicAttachmentId,
  resolveAttachmentPathById,
} from "../attachmentStore.ts";

export type HermesHistoryMediaKind = "image" | "audio" | "video" | "file";

export interface HermesHistoryMediaReference {
  readonly kind: HermesHistoryMediaKind;
  readonly path: string;
}

export interface ParsedHermesHistoryText {
  readonly text: string;
  readonly media: ReadonlyArray<HermesHistoryMediaReference>;
}

const MEDIA_REFERENCE_LINE =
  /^\[(Image attached at|User sent an image|User sent audio|User sent a video|User sent a file):\s*(.+)\]$/i;
const HERMES_MEDIA_DELIVERY_EXTENSIONS = [
  "jpeg",
  "docx",
  "webp",
  "tiff",
  "flac",
  "pptx",
  "xlsx",
  "html",
  "yaml",
  "epub",
  "opus",
  "json",
  "webm",
  "m4a",
  "odt",
  "rtf",
  "txt",
  "csv",
  "xml",
  "yml",
  "ppt",
  "odp",
  "key",
  "tar",
  "tgz",
  "bz2",
  "apk",
  "ipa",
  "png",
  "jpg",
  "gif",
  "bmp",
  "svg",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "mp3",
  "wav",
  "ogg",
  "pdf",
  "doc",
  "md",
  "xls",
  "ods",
  "tsv",
  "zip",
  "htm",
  "gz",
  "xz",
  "7z",
  "rar",
] as const;
const HERMES_MEDIA_DELIVERY_EXTENSION_PATTERN = HERMES_MEDIA_DELIVERY_EXTENSIONS.join("|");
const HERMES_MEDIA_TAG = new RegExp(
  [
    String.raw`["']?MEDIA:\s*(?<path>`,
    String.raw`\x60[^\x60\n]+\x60`,
    String.raw`|"[^"\n]+"|'[^'\n]+'|(?:~\/|\/|[A-Za-z]:[/\\])\S+(?:[^\S\n]+(?!["']?MEDIA:)\S+)*?\.(?:${HERMES_MEDIA_DELIVERY_EXTENSION_PATTERN}))(?=[\s\x60"',;:)\]}]|$)["']?`,
  ].join(""),
  "giu",
);
const HERMES_MEDIA_FALLBACK_TAG =
  /["']?MEDIA:\s*(?<path>(?:~\/|\/|[A-Za-z]:[/\\])[^\s\n`"']+)["']?/giu;
const REDUNDANT_IMAGE_PLACEHOLDER_LINE = /^\[(?:image|screenshot)\]$/i;
const TRANSPORT_SENDER_PREFIX = /^\[([^\]\r\n]{1,80})\](?:[ \t]+|\r?\n)/;
const RESERVED_TRANSPORT_LABELS = new Set([
  "attachment",
  "image",
  "important",
  "info",
  "note",
  "reply",
  "replying to",
  "screenshot",
  "system",
  "todo",
  "warning",
]);

function expandHomePrefix(path: string): string {
  return path === "~"
    ? NodeOS.homedir()
    : path.startsWith(`~${NodePath.sep}`)
      ? NodePath.join(NodeOS.homedir(), path.slice(2))
      : path;
}

function mediaKind(label: string): HermesHistoryMediaKind {
  const normalized = label.toLowerCase();
  if (normalized.includes("image")) return "image";
  if (normalized.includes("audio")) return "audio";
  if (normalized.includes("video")) return "video";
  return "file";
}

function mediaKindForPath(path: string): HermesHistoryMediaKind {
  const extension = NodePath.extname(path).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tiff"].includes(extension)) {
    return "image";
  }
  if ([".mp4", ".mov", ".avi", ".mkv", ".webm"].includes(extension)) return "video";
  if ([".mp3", ".wav", ".ogg", ".opus", ".m4a", ".flac"].includes(extension)) return "audio";
  return "file";
}

function normalizedMediaTagPath(raw: string): string {
  let path = raw.trim();
  if (
    path.length >= 2 &&
    path[0] === path[path.length - 1] &&
    (path[0] === "`" || path[0] === '"' || path[0] === "'")
  ) {
    path = path.slice(1, -1).trim();
  }
  return path.replace(/^[`"']+/u, "").replace(/[`"',.;:)}\]]+$/u, "");
}

function protectedMediaSpans(text: string): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  for (const match of text.matchAll(/```[^\n]*\n[\s\S]*?```/gu)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  for (const match of text.matchAll(/`[^`\n]+`/gu)) {
    const prefix = text.slice(Math.max(0, match.index - 20), match.index);
    if (!/MEDIA:\s*$/iu.test(prefix)) {
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  for (const match of text.matchAll(/^>.*$/gmu)) {
    spans.push([match.index, match.index + match[0].length]);
  }
  // Hermes deliberately ignores MEDIA references embedded in serialized tool
  // result values so replaying stored JSON cannot re-deliver an old local file.
  for (const match of text.matchAll(/(?<=:|,|\{|\[)\s*"((?:[^"\\\n]|\\.)*)"/gu)) {
    const body = match[1];
    if (body?.match(/MEDIA:\s*(?:~\/|\/|[A-Za-z]:[/\\])/u)) {
      spans.push([match.index, match.index + match[0].length]);
    }
  }
  return spans;
}

function isProtectedSpan(
  start: number,
  end: number,
  spans: ReadonlyArray<readonly [number, number]>,
): boolean {
  return spans.some(
    ([protectedStart, protectedEnd]) => start < protectedEnd && end > protectedStart,
  );
}

function extractAssistantMedia(text: string): ParsedHermesHistoryText {
  if (!text.includes("MEDIA:")) {
    return {
      text: text.replaceAll("[[audio_as_voice]]", "").replaceAll("[[as_document]]", "").trim(),
      media: [],
    };
  }
  const media: HermesHistoryMediaReference[] = [];
  const removalSpans: Array<readonly [number, number]> = [];
  const protectedSpans = protectedMediaSpans(text);
  for (const match of text.matchAll(HERMES_MEDIA_TAG)) {
    const path = normalizedMediaTagPath(match.groups?.path ?? "");
    const start = match.index;
    const end = start + match[0].length;
    if (!path || isProtectedSpan(start, end, protectedSpans)) continue;
    media.push({ kind: mediaKindForPath(path), path });
    removalSpans.push([start, end]);
  }
  // Upstream also accepts extension-less and unknown-extension files after
  // filesystem validation. Capturing the conservative, no-whitespace form
  // here prevents a partially streamed local path from flashing in the UI;
  // persistence remains the authority on whether it is safe and supported.
  for (const match of text.matchAll(HERMES_MEDIA_FALLBACK_TAG)) {
    const path = normalizedMediaTagPath(match.groups?.path ?? "");
    const start = match.index;
    const end = start + match[0].length;
    if (
      !path ||
      isProtectedSpan(start, end, protectedSpans) ||
      isProtectedSpan(start, end, removalSpans)
    ) {
      continue;
    }
    media.push({ kind: mediaKindForPath(path), path });
    removalSpans.push([start, end]);
  }

  let visible = text;
  for (const [start, end] of removalSpans.toSorted((left, right) => right[0] - left[0])) {
    visible = `${visible.slice(0, start)}${visible.slice(end)}`;
  }
  visible = visible
    .replaceAll("[[audio_as_voice]]", "")
    .replaceAll("[[as_document]]", "")
    .replace(/[ \t]+\n/gu, "\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trim();
  return { text: visible, media };
}

function stripTransportSenderPrefix(text: string): string {
  const match = TRANSPORT_SENDER_PREFIX.exec(text);
  const label = match?.[1]?.trim();
  if (
    match === null ||
    label === undefined ||
    (!/\p{L}/u.test(label) && !label.includes("|")) ||
    /[:'"{}\r\n]/u.test(label) ||
    RESERVED_TRANSPORT_LABELS.has(label.toLowerCase()) ||
    (match[0].endsWith("\n") && !label.includes("|"))
  ) {
    return text;
  }
  return text.slice(match[0].length);
}

/**
 * Parses display artifacts emitted by Hermes transports plus its outbound
 * MEDIA protocol. Protected examples remain prose, while real assistant/tool
 * directives and native-image persistence lines become attachment references.
 */
export function parseHermesHistoryText(input: {
  readonly role: "user" | "assistant" | "tool" | "system";
  readonly text: string;
}): ParsedHermesHistoryText {
  if (input.role === "assistant" || input.role === "tool") {
    return extractAssistantMedia(input.text);
  }
  if (input.role !== "user") return { text: input.text, media: [] };

  const media: HermesHistoryMediaReference[] = [];
  let sawScreenshotPlaceholder = false;
  const visibleLines: string[] = [];
  for (const line of input.text.split(/\r?\n/u)) {
    const match = MEDIA_REFERENCE_LINE.exec(line.trim());
    if (match?.[1] !== undefined && match[2] !== undefined) {
      media.push({ kind: mediaKind(match[1]), path: match[2].trim() });
      continue;
    }
    if (REDUNDANT_IMAGE_PLACEHOLDER_LINE.test(line.trim())) {
      sawScreenshotPlaceholder = true;
      continue;
    }
    visibleLines.push(line);
  }

  let text = stripTransportSenderPrefix(visibleLines.join("\n")).trim();
  if (sawScreenshotPlaceholder && media.length === 0) {
    text = [text, "[Image unavailable]"].filter(Boolean).join("\n\n");
  }
  return { text, media };
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  const relative = NodePath.relative(root, candidate);
  if (relative === "") return true;
  return (
    !relative.startsWith(`..${NodePath.sep}`) && relative !== ".." && !NodePath.isAbsolute(relative)
  );
}

function detectSupportedMedia(bytes: Uint8Array): {
  readonly type: ChatAttachment["type"];
  readonly mimeType: string;
} | null {
  const ascii = (start: number, end: number) =>
    Buffer.from(bytes.subarray(start, end)).toString("ascii");
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    ascii(1, 4) === "PNG" &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { type: "image", mimeType: "image/png" };
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { type: "image", mimeType: "image/jpeg" };
  }
  if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") {
    return { type: "image", mimeType: "image/gif" };
  }
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return { type: "image", mimeType: "image/webp" };
  }
  if (ascii(0, 2) === "BM") return { type: "image", mimeType: "image/bmp" };
  if (ascii(0, 4) === "II*\0" || ascii(0, 4) === "MM\0*") {
    return { type: "image", mimeType: "image/tiff" };
  }
  if (ascii(0, 5) === "%PDF-") return { type: "pdf", mimeType: "application/pdf" };
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (/^(?:M4A |M4B |M4P )$/u.test(brand)) {
      return { type: "file", mimeType: "audio/mp4" };
    }
    return {
      type: "video",
      mimeType: brand === "qt  " ? "video/quicktime" : "video/mp4",
    };
  }
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf) {
    return { type: "video", mimeType: "video/webm" };
  }
  if (ascii(0, 4) === "OggS") return { type: "file", mimeType: "audio/ogg" };
  if (ascii(0, 4) === "fLaC") return { type: "file", mimeType: "audio/flac" };
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") {
    return { type: "file", mimeType: "audio/wav" };
  }
  if (
    ascii(0, 3) === "ID3" ||
    (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0)
  ) {
    return { type: "file", mimeType: "audio/mpeg" };
  }
  return null;
}

const GENERIC_FILE_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".7z": "application/x-7z-compressed",
  ".apk": "application/vnd.android.package-archive",
  ".bz2": "application/x-bzip2",
  ".csv": "text/csv",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".epub": "application/epub+zip",
  ".flac": "audio/flac",
  ".gz": "application/gzip",
  ".html": "text/html",
  ".htm": "text/html",
  ".ipa": "application/octet-stream",
  ".json": "application/json",
  ".key": "application/octet-stream",
  ".m4a": "audio/mp4",
  ".md": "text/markdown",
  ".odp": "application/vnd.oasis.opendocument.presentation",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".odt": "application/vnd.oasis.opendocument.text",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rar": "application/vnd.rar",
  ".rtf": "application/rtf",
  ".svg": "image/svg+xml",
  ".tar": "application/x-tar",
  ".tgz": "application/gzip",
  ".tsv": "text/tab-separated-values",
  ".txt": "text/plain",
  ".xls": "application/vnd.ms-excel",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xml": "application/xml",
  ".xz": "application/x-xz",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".zip": "application/zip",
};

function supportedGenericFile(path: string): {
  readonly type: ChatAttachment["type"];
  readonly mimeType: string;
} | null {
  const mimeType = GENERIC_FILE_MIME_BY_EXTENSION[NodePath.extname(path).toLowerCase()];
  return mimeType === undefined ? null : { type: "file", mimeType };
}

function safeAttachmentName(path: string, mimeType: string): string {
  const fallback =
    mimeType === "image/png"
      ? "image.png"
      : mimeType === "image/jpeg"
        ? "image.jpg"
        : mimeType === "image/webp"
          ? "image.webp"
          : mimeType === "application/pdf"
            ? "document.pdf"
            : "attachment";
  const name = Array.from(NodePath.basename(path), (character) => {
    const code = character.charCodeAt(0);
    return code <= 0x1f || code === 0x7f ? "_" : character;
  })
    .join("")
    .trim();
  return (name || fallback).slice(0, 255);
}

export function hermesHistoryMediaRoots(input: {
  readonly hermesHome?: string | undefined;
  readonly profileKey: string;
  readonly extraRoots?: ReadonlyArray<string> | undefined;
}): ReadonlyArray<string> {
  const defaultHome = NodePath.join(NodeOS.homedir(), ".hermes");
  const configuredHome = NodePath.resolve(
    expandHomePrefix(input.hermesHome?.trim() || defaultHome),
  );
  const homes = new Set([configuredHome]);
  if (/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(input.profileKey) && input.profileKey !== "default") {
    homes.add(NodePath.join(configuredHome, "profiles", input.profileKey));
  }
  const roots = [...homes].flatMap((home) => [
    NodePath.join(home, "cache", "images"),
    NodePath.join(home, "cache", "audio"),
    NodePath.join(home, "cache", "videos"),
    NodePath.join(home, "cache", "video"),
    NodePath.join(home, "cache", "documents"),
    NodePath.join(home, "cache", "screenshots"),
    NodePath.join(home, "cache", "vision"),
    NodePath.join(home, "image_cache"),
    NodePath.join(home, "audio_cache"),
    NodePath.join(home, "video_cache"),
    NodePath.join(home, "document_cache"),
    NodePath.join(home, "browser_screenshots"),
    NodePath.join(home, "temp_video_files"),
    NodePath.join(home, "temp_vision_images"),
  ]);
  // HERMES_MEDIA_ALLOW_DIRS is an explicit, provider-instance-scoped operator
  // extension point. Deliberately do not trust general user output locations
  // or the entire Hermes home/cache tree.
  for (const root of input.extraRoots ?? []) {
    const expanded = expandHomePrefix(root);
    if (NodePath.isAbsolute(expanded)) roots.push(NodePath.resolve(expanded));
  }
  return [...new Set(roots)];
}

export const persistHermesHistoryMedia = Effect.fn("persistHermesHistoryMedia")(function* (input: {
  readonly sourcePath: string;
  readonly expectedKind: HermesHistoryMediaKind;
  readonly approvedRoots: ReadonlyArray<string>;
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly stableKey: string;
}): Effect.fn.Return<ChatAttachment | null> {
  if (input.sourcePath.includes("\0")) return null;

  return yield* Effect.tryPromise({
    try: async () => {
      const expandedSourcePath = expandHomePrefix(input.sourcePath);
      if (!NodePath.isAbsolute(expandedSourcePath)) return null;
      const resolvedSourcePath = NodePath.resolve(expandedSourcePath);
      const configuredRoots = input.approvedRoots.map((root) => NodePath.resolve(root));
      if (!configuredRoots.some((root) => isPathInsideRoot(root, resolvedSourcePath))) return null;
      const rawId = createDeterministicAttachmentId(
        input.threadId,
        `${input.stableKey}:${resolvedSourcePath}`,
      );
      if (rawId === null) return null;

      const attachmentFromBytes = (
        bytes: Uint8Array,
        sourceName: string,
      ): ChatAttachment | null => {
        const detected = detectSupportedMedia(bytes) ?? supportedGenericFile(sourceName);
        if (
          detected === null ||
          (input.expectedKind === "image" && detected.type !== "image") ||
          (input.expectedKind === "video" && detected.type !== "video") ||
          (input.expectedKind === "audio" && !detected.mimeType.startsWith("audio/"))
        ) {
          return null;
        }
        const maxBytes =
          detected.type === "image"
            ? PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
            : PROVIDER_SEND_TURN_MAX_FILE_BYTES;
        if (bytes.byteLength > maxBytes) return null;
        return {
          type: detected.type,
          id: ChatAttachmentId.make(rawId),
          name: safeAttachmentName(sourceName, detected.mimeType),
          mimeType: detected.mimeType,
          sizeBytes: bytes.byteLength,
        };
      };

      // Hermes prunes transport caches. Once T3 has safely imported a file,
      // keep using that durable copy even if the original cache entry is gone.
      const existingPath = resolveAttachmentPathById({
        attachmentsDir: input.attachmentsDir,
        attachmentId: rawId,
      });
      if (existingPath !== null) {
        const existingStat = await NodeFS.promises.stat(existingPath);
        if (existingStat.isFile() && existingStat.size <= PROVIDER_SEND_TURN_MAX_FILE_BYTES) {
          const existingAttachment = attachmentFromBytes(
            await NodeFS.promises.readFile(existingPath),
            input.sourcePath,
          );
          if (existingAttachment !== null) return existingAttachment;
        }
      }

      const canonicalRoots = (
        await Promise.all(
          configuredRoots.map((root) => NodeFS.promises.realpath(root).catch(() => null)),
        )
      ).filter((root): root is string => root !== null);
      const canonicalSource = await NodeFS.promises.realpath(resolvedSourcePath);
      if (!canonicalRoots.some((root) => isPathInsideRoot(root, canonicalSource))) return null;

      const before = await NodeFS.promises.stat(canonicalSource);
      if (!before.isFile() || before.size > PROVIDER_SEND_TURN_MAX_FILE_BYTES) return null;
      const handle = await NodeFS.promises.open(
        canonicalSource,
        NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
      );
      let bytes: Uint8Array;
      try {
        const opened = await handle.stat();
        if (
          !opened.isFile() ||
          opened.dev !== before.dev ||
          opened.ino !== before.ino ||
          opened.size !== before.size
        ) {
          return null;
        }
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }

      const attachment = attachmentFromBytes(bytes, canonicalSource);
      if (attachment === null) return null;
      await NodeFS.promises.mkdir(input.attachmentsDir, { recursive: true });
      await NodeFS.promises.writeFile(
        NodePath.join(input.attachmentsDir, attachmentRelativePath(attachment)),
        bytes,
      );
      return attachment;
    },
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null));
});

export const normalizeHermesHistoryMessage = Effect.fn("normalizeHermesHistoryMessage")(
  function* (input: {
    readonly role: "user" | "assistant" | "tool" | "system";
    readonly text: string;
    readonly resolveMedia: (
      media: HermesHistoryMediaReference,
      index: number,
    ) => Effect.Effect<ChatAttachment | null>;
  }) {
    const parsed = parseHermesHistoryText({ role: input.role, text: input.text });
    const resolved = yield* Effect.forEach(
      parsed.media.map((media, index) => ({ media, index })),
      ({ media, index }) => input.resolveMedia(media, index),
      { concurrency: 2 },
    );
    const attachments = resolved.filter(
      (attachment): attachment is ChatAttachment => attachment !== null,
    );
    const missingKinds = parsed.media
      .filter((_, index) => resolved[index] === null)
      .map((media) => media.kind);
    const placeholders = [...new Set(missingKinds)].map((kind) =>
      kind === "image"
        ? "[Image unavailable]"
        : `[${kind[0]!.toUpperCase()}${kind.slice(1)} unavailable]`,
    );
    return {
      text: [parsed.text, ...placeholders].filter(Boolean).join("\n\n"),
      attachments,
    };
  },
);
