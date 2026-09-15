import * as NodeCrypto from "node:crypto";

import type { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

export class CuaScreenshotSaveError extends Schema.TaggedError<CuaScreenshotSaveError>()(
  "CuaScreenshotSaveError",
  { screenshotPath: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not save computer use screenshot to ${this.screenshotPath}.`;
  }
}

export interface CuaScreenshot {
  readonly imagePath: string;
  readonly windowTitle?: string;
}

interface ImageBlock {
  readonly mimeType: string;
  readonly base64: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Finds the first image block in a raw MCP tool result. Codex hands over the
 * MCP `{content: [...]}` record, Claude the `tool_result` block whose
 * `content` is the same array, and ACP a `[{type: "content", content}]` list.
 */
function findImageBlock(result: unknown, depth = 0): ImageBlock | undefined {
  if (depth > 3) return undefined;
  if (Array.isArray(result)) {
    for (const entry of result) {
      const found = findImageBlock(entry, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = asRecord(result);
  if (!record) return undefined;
  if (record.type === "image") {
    const source = asRecord(record.source);
    const base64 = typeof record.data === "string" ? record.data : source?.data;
    const mimeType =
      typeof record.mimeType === "string"
        ? record.mimeType
        : typeof source?.media_type === "string"
          ? source.media_type
          : "image/png";
    return typeof base64 === "string" && base64.length > 0 ? { mimeType, base64 } : undefined;
  }
  return findImageBlock(record.content, depth + 1);
}

function windowTitleOf(result: unknown): string | undefined {
  const record = asRecord(result);
  const structured = asRecord(record?.structuredContent) ?? record;
  const title = structured?.window_title ?? structured?.windowTitle;
  return typeof title === "string" && title.trim().length > 0
    ? title.trim().slice(0, 200)
    : undefined;
}

const extensionFor = (mimeType: string) =>
  mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : "png";

/**
 * The raw tool result inside a computer-use activity payload, per provider:
 * Codex nests it under `data.item.result`, Claude under `data.result`, and ACP
 * under `data.rawOutput` or `data.content`. OpenCode flattens output to text
 * before the adapter sees it, so its screenshots are never recoverable.
 */
export function cuaToolResultOf(data: unknown): unknown {
  const record = asRecord(data);
  if (!record) return undefined;
  return asRecord(record.item)?.result ?? record.result ?? record.rawOutput ?? record.content;
}

/**
 * Persists the screenshot a Cua tool returned so clients can show what the
 * agent last looked at. Only capture tools return images, so any image block
 * qualifies. Failures are logged, never raised into the provider event path.
 */
export const saveCuaScreenshot = Effect.fn("cua.saveScreenshot")(function* (input: {
  readonly threadId: ThreadId;
  readonly result: unknown;
}) {
  const image = findImageBlock(input.result);
  if (!image) return undefined;
  const bytes = Buffer.from(image.base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return undefined;

  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const millis = yield* Clock.currentTimeMillis;
  const fileName = `computer-use-${input.threadId.slice(0, 8)}-${millis.toString(36)}-${NodeCrypto.randomUUID().slice(0, 8)}.${extensionFor(image.mimeType)}`;
  const screenshotPath = path.join(config.browserArtifactsDir, fileName);
  const saved = yield* fs.makeDirectory(config.browserArtifactsDir, { recursive: true }).pipe(
    Effect.andThen(fs.writeFile(screenshotPath, new Uint8Array(bytes))),
    Effect.mapError((cause) => new CuaScreenshotSaveError({ screenshotPath, cause })),
    Effect.tapError((error) => Effect.logWarning(error.message, { cause: error.cause })),
    Effect.option,
  );
  if (saved._tag === "None") return undefined;
  const windowTitle = windowTitleOf(input.result);
  return {
    imagePath: screenshotPath,
    ...(windowTitle ? { windowTitle } : {}),
  } satisfies CuaScreenshot;
});
