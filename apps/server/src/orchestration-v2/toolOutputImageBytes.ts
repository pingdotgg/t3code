// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import {
  MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH,
  readToolOutputImage,
  toolOutputImageBlocks,
} from "@t3tools/shared/toolOutput";

import { chatAttachmentStableKey, createDeterministicAttachmentId } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { inferImageExtension } from "../imageMime.ts";

const IMAGE_MIME_KEYS = ["mimeType", "mime_type", "media_type", "type"] as const;
const IMAGE_BODY_KEYS = new Set(["data", "blob", "base64"]);
const MAX_DEPTH = 32;
const MIN_BODY_LENGTH = 64;
const BASE64_BODY = /^[A-Za-z0-9+/_-]+={0,2}$/;

type UnknownRecord = Record<string, unknown>;

function hasImageMime(record: UnknownRecord): boolean {
  return IMAGE_MIME_KEYS.some((key) => {
    const mime = record[key];
    return typeof mime === "string" && mime.toLowerCase().startsWith("image/");
  });
}

function isImageBody(record: UnknownRecord, key: string | undefined): boolean {
  if (record.type === "image" || key === "image") return true;
  if (!hasImageMime(record)) return false;
  return (
    record.type === undefined ||
    record.type === "base64" ||
    (typeof record.type === "string" && record.type.toLowerCase().startsWith("image/"))
  );
}

function isBase64Body(value: unknown): value is string {
  return typeof value === "string" && value.length >= MIN_BODY_LENGTH && BASE64_BODY.test(value);
}

function base64DecodedLength(encoded: string): number {
  let length = encoded.length;
  while (length > 0 && encoded.charCodeAt(length - 1) === 0x3d) {
    length -= 1;
  }
  return Math.floor((length * 3) / 4);
}

interface StripContext {
  readonly output: unknown;
  served: ReadonlyArray<unknown> | undefined;
}

function isServed(context: StripContext, record: UnknownRecord): boolean {
  context.served ??= toolOutputImageBlocks(context.output);
  if (!context.served.includes(record)) return false;
  const data = readToolOutputImage(record)?.data;
  return data === undefined || data.length <= MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH;
}

function strip(
  value: unknown,
  key: string | undefined,
  context: StripContext,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH || typeof value !== "object" || value === null) {
    return value;
  }
  if (Array.isArray(value)) {
    let next: Array<unknown> | undefined;
    for (let index = 0; index < value.length; index += 1) {
      const entry = value[index];
      const stripped = strip(entry, undefined, context, depth + 1);
      if (stripped !== entry) {
        next ??= value.slice();
        next[index] = stripped;
      }
    }
    return next ?? value;
  }
  const record = value as UnknownRecord;
  if (record.type === "image" && isServed(context, record)) return record;
  const imageBody = isImageBody(record, key);
  let next: UnknownRecord | undefined;
  let removedBody: string | undefined;
  for (const entryKey in record) {
    if (!Object.hasOwn(record, entryKey)) continue;
    const entry = record[entryKey];
    if (imageBody && IMAGE_BODY_KEYS.has(entryKey) && isBase64Body(entry)) {
      next ??= { ...record };
      delete next[entryKey];
      removedBody = entry;
      continue;
    }
    const stripped = strip(entry, entryKey, context, depth + 1);
    if (stripped !== entry) {
      next ??= { ...record };
      next[entryKey] = stripped;
    }
  }
  if (next !== undefined && removedBody !== undefined) {
    next.sizeBytes = base64DecodedLength(removedBody);
  }
  return next ?? record;
}

/** Image bytes are stored twice; retain only size-limited toolOutputImageBlocks that are served.
 * Read-file previews use viewedImagePath, and context handoffs skip tools. */
export function stripUnservedToolOutputImageBytes(
  item: OrchestrationV2TurnItem,
): OrchestrationV2TurnItem {
  if (item.type !== "dynamic_tool" || typeof item.output !== "object" || item.output === null) {
    return item;
  }
  const output = strip(item.output, undefined, { output: item.output, served: undefined }, 0);
  return output === item.output ? item : { ...item, output };
}

function mapOutputBlocks(value: unknown, map: (block: unknown) => unknown): unknown {
  if (Array.isArray(value)) return value.map(map);
  if (Predicate.isObject(value) && Array.isArray(value.content)) {
    return { ...value, content: value.content.map(map) };
  }
  return map(value);
}

/** Moves served image bytes to the attachment store so SQLite rows keep only a reference.
 * Ids are deterministic per item, index, and bytes, so repeated updates reuse one file. */
export const storeServedToolOutputImages = Effect.fn(
  "ToolOutputImageBytes.storeServedToolOutputImages",
)(function* (item: OrchestrationV2TurnItem) {
  if (item.type !== "dynamic_tool") return item;
  const blocks = toolOutputImageBlocks(item.output);
  if (blocks.length === 0) return item;
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const replacements = new Map<unknown, unknown>();
  yield* Effect.forEach(
    blocks,
    Effect.fnUntraced(function* (block, index) {
      const image = readToolOutputImage(block);
      if (image === null) return;
      const reference = { type: "image", mimeType: image.mimeType };
      // Provider output must not point at another thread's stored file.
      if (image.data === undefined || image.data.length > MAX_TOOL_OUTPUT_IMAGE_BASE64_LENGTH) {
        if (image.attachmentId !== undefined) replacements.set(block, reference);
        return;
      }
      const decoded = Base64.decode(image.data);
      if (Result.isFailure(decoded)) return;
      const bytes = decoded.success;
      const baseId = createDeterministicAttachmentId(
        item.threadId,
        chatAttachmentStableKey(item.id, index, bytes),
      );
      if (baseId === null) return;
      const extension = inferImageExtension({ mimeType: image.mimeType });
      const attachmentId = `${baseId}-${extension.slice(1)}`;
      const filePath = path.join(config.attachmentsDir, `${attachmentId}${extension}`);
      const partPath = `${filePath}.${NodeCrypto.randomUUID()}.part`;
      const stored = yield* fileSystem.exists(filePath).pipe(
        Effect.flatMap((exists) =>
          exists
            ? Effect.void
            : fileSystem.makeDirectory(config.attachmentsDir, { recursive: true }).pipe(
                // Rename so an interrupted write never leaves a file that passes the exists check.
                Effect.andThen(fileSystem.writeFile(partPath, bytes)),
                Effect.andThen(fileSystem.rename(partPath, filePath)),
                Effect.tapError(() =>
                  fileSystem.remove(partPath, { force: true }).pipe(Effect.ignore),
                ),
              ),
        ),
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.logWarning("Keeping tool output image inline; storing it failed.", {
            threadId: item.threadId,
            itemId: item.id,
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
      if (stored) replacements.set(block, { ...reference, attachmentId });
    }),
    { concurrency: 1, discard: true },
  );
  if (replacements.size === 0) return item;
  return {
    ...item,
    output: mapOutputBlocks(item.output, (block) => replacements.get(block) ?? block),
  };
});
