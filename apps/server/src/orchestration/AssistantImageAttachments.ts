import Mime from "@effect/platform-node/Mime";
import {
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ChatAttachment,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Predicate from "effect/Predicate";

import { createAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import {
  inferImageExtension,
  parseBase64DataUrl,
  SAFE_IMAGE_FILE_EXTENSIONS,
} from "../imageMime.ts";

export type AssistantImageInput =
  | {
      readonly _tag: "base64";
      readonly base64: string;
      readonly mimeType: string;
      readonly name: string;
    }
  | {
      readonly _tag: "data-url";
      readonly dataUrl: string;
      readonly name: string;
    }
  | {
      readonly _tag: "local-file";
      readonly path: string;
      readonly name: string;
    };

const MAX_TRAVERSAL_DEPTH = 8;
const MAX_BASE64_IMAGE_CHARS = Math.ceil(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES / 3) * 4;
const MAX_IMAGE_DATA_URL_CHARS = MAX_BASE64_IMAGE_CHARS + 1_024;

function stringProperty(record: { [x: PropertyKey]: unknown }, key: string): string | undefined {
  const value = record[key];
  return Predicate.isString(value) && value.trim().length > 0 ? value.trim() : undefined;
}

function basename(value: string): string {
  return value.replaceAll("\\", "/").split("/").at(-1)?.trim() ?? "";
}

function safeImageName(value: string | undefined, mimeType: string): string {
  const candidate = basename(value ?? "").slice(0, 255);
  const inferredExtension = inferImageExtension({ mimeType, fileName: candidate });
  const extension = /\.[a-z0-9]{1,8}$/i.exec(candidate)?.[0]?.toLowerCase();
  const extensionMatchesMime =
    extension === inferredExtension ||
    (inferredExtension === ".jpg" && (extension === ".jpg" || extension === ".jpeg"));
  if (
    candidate.length > 0 &&
    extension &&
    SAFE_IMAGE_FILE_EXTENSIONS.has(extension) &&
    (inferredExtension === ".bin" || extensionMatchesMime)
  ) {
    return candidate;
  }
  const stem = candidate.replace(/\.[a-z0-9]{1,8}$/i, "").trim() || "generated-image";
  return `${stem}${inferredExtension === ".bin" ? ".png" : inferredExtension}`;
}

function dataUrlInput(
  dataUrl: string,
  suggestedName: string | undefined,
): AssistantImageInput | null {
  if (dataUrl.length > MAX_IMAGE_DATA_URL_CHARS) {
    return null;
  }
  const parsed = parseBase64DataUrl(dataUrl);
  if (!parsed?.mimeType.startsWith("image/")) {
    return null;
  }
  return {
    _tag: "data-url",
    dataUrl,
    name: safeImageName(suggestedName, parsed.mimeType),
  };
}

function rawBase64Input(
  base64: string,
  mimeType: string | undefined,
  suggestedName: string | undefined,
): AssistantImageInput | null {
  if (base64.length > MAX_BASE64_IMAGE_CHARS || !mimeType?.toLowerCase().startsWith("image/")) {
    return null;
  }
  const normalizedMimeType = mimeType.toLowerCase();
  const parsed = parseBase64DataUrl(`data:${normalizedMimeType};base64,${base64}`);
  if (!parsed) {
    return null;
  }
  return {
    _tag: "base64",
    base64: parsed.base64,
    mimeType: normalizedMimeType,
    name: safeImageName(suggestedName, normalizedMimeType),
  };
}

/**
 * Extracts only explicit image-bearing provider result shapes. In particular,
 * filesystem paths are accepted solely from Codex's native imageGeneration
 * item so arbitrary tool output can never become a client-visible file URL.
 */
export function extractAssistantImageInputs(
  payload: unknown,
  context?: { readonly provider?: ProviderDriverKind },
): ReadonlyArray<AssistantImageInput> {
  const inputs: Array<AssistantImageInput> = [];
  const seenObjects = new WeakSet<object>();
  const seenSources = new Set<string>();

  const add = (input: AssistantImageInput | null) => {
    if (!input || inputs.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      return;
    }
    const source =
      input._tag === "data-url"
        ? input.dataUrl
        : input._tag === "base64"
          ? `${input.mimeType}:${input.base64}`
          : input.path;
    if (!seenSources.has(source)) {
      seenSources.add(source);
      inputs.push(input);
    }
  };

  const visitOutput = (value: unknown, depth: number, nativeCodexItem = false): void => {
    if (depth > MAX_TRAVERSAL_DEPTH || inputs.length >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visitOutput(entry, depth + 1);
      return;
    }
    if (!Predicate.isObject(value) || seenObjects.has(value)) {
      return;
    }
    seenObjects.add(value);

    const type = stringProperty(value, "type");
    const suggestedName =
      stringProperty(value, "output_hint") ??
      stringProperty(value, "outputHint") ??
      stringProperty(value, "fileName") ??
      stringProperty(value, "name");

    if (type === "imageGeneration") {
      if (!nativeCodexItem) {
        return;
      }
      const result = stringProperty(value, "result");
      if (result) {
        const savedPath = stringProperty(value, "savedPath");
        const embedded =
          dataUrlInput(result, savedPath ?? suggestedName) ??
          rawBase64Input(result, "image/png", savedPath ?? suggestedName);
        if (embedded) {
          add(embedded);
          return;
        }
      }
      const savedPath = stringProperty(value, "savedPath");
      if (savedPath) {
        const name = basename(savedPath).slice(0, 255);
        if (name.length > 0) add({ _tag: "local-file", path: savedPath, name });
      }
      return;
    }

    if (type === "generated_image" || type === "generatedImage") {
      const imageUrl = stringProperty(value, "image_url") ?? stringProperty(value, "imageUrl");
      if (imageUrl) add(dataUrlInput(imageUrl, suggestedName));
      return;
    }

    if (type === "image") {
      const data = stringProperty(value, "data");
      const mimeType = stringProperty(value, "mimeType") ?? stringProperty(value, "mime_type");
      if (data) {
        add(dataUrlInput(data, suggestedName) ?? rawBase64Input(data, mimeType, suggestedName));
        return;
      }

      const source = value["source"];
      if (Predicate.isObject(source) && stringProperty(source, "type") === "base64") {
        const sourceData = stringProperty(source, "data");
        const sourceMimeType = stringProperty(source, "media_type");
        if (sourceData) {
          add(rawBase64Input(sourceData, sourceMimeType, suggestedName));
          return;
        }
      }
    }

    for (const key of ["content", "result", "output"] as const) {
      if (key in value) visitOutput(value[key], depth + 1);
    }
  };

  if (!Predicate.isObject(payload)) return inputs;
  const item = payload["item"];
  if (Predicate.isObject(item)) {
    const itemType = stringProperty(item, "type");
    if (itemType === "imageGeneration") {
      visitOutput(item, 0, String(context?.provider) === "codex");
    } else if (itemType === "mcpToolCall") {
      visitOutput(item["result"], 0);
    }
  }
  if (stringProperty(payload, "type") === "tool_result") {
    visitOutput(payload["content"], 0);
  }
  visitOutput(payload["result"], 0);
  visitOutput(payload["content"], 0);
  return inputs;
}

function bytesFromInput(input: Exclude<AssistantImageInput, { _tag: "local-file" }>): {
  readonly bytes: Uint8Array;
  readonly mimeType: string;
  readonly name: string;
} | null {
  const parsed =
    input._tag === "data-url"
      ? parseBase64DataUrl(input.dataUrl)
      : parseBase64DataUrl(`data:${input.mimeType};base64,${input.base64}`);
  if (!parsed?.mimeType.startsWith("image/")) {
    return null;
  }
  const padding = parsed.base64.endsWith("==") ? 2 : parsed.base64.endsWith("=") ? 1 : 0;
  const decodedByteLength = (parsed.base64.length / 4) * 3 - padding;
  if (
    parsed.base64.length > MAX_BASE64_IMAGE_CHARS ||
    decodedByteLength <= 0 ||
    decodedByteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
  ) {
    return null;
  }
  const bytes = Buffer.from(parsed.base64, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
    return null;
  }
  return { bytes, mimeType: parsed.mimeType, name: input.name };
}

export const persistAssistantImageInputs = Effect.fn("persistAssistantImageInputs")(
  function* (input: {
    readonly threadId: ThreadId;
    readonly inputs: ReadonlyArray<AssistantImageInput>;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;

    const persistOne = Effect.fn("persistAssistantImageInputs.persistOne")(function* (
      imageInput: AssistantImageInput,
    ) {
      let image: {
        readonly bytes: Uint8Array;
        readonly mimeType: string;
        readonly name: string;
      } | null;

      if (imageInput._tag === "local-file") {
        const mimeType = Mime.getType(imageInput.name)?.toLowerCase();
        const extension = /\.[a-z0-9]{1,8}$/i.exec(imageInput.name)?.[0]?.toLowerCase();
        if (
          !mimeType?.startsWith("image/") ||
          !extension ||
          !SAFE_IMAGE_FILE_EXTENSIONS.has(extension)
        ) {
          return null;
        }
        const stat = yield* fs.stat(imageInput.path);
        if (
          stat.type !== "File" ||
          stat.size <= 0n ||
          stat.size > BigInt(PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
        ) {
          return null;
        }
        image = {
          bytes: yield* fs.readFile(imageInput.path),
          mimeType,
          name: safeImageName(imageInput.name, mimeType),
        };
      } else {
        image = bytesFromInput(imageInput);
      }
      if (!image) {
        return null;
      }
      if (
        image.bytes.byteLength === 0 ||
        image.bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
      ) {
        return null;
      }

      const attachmentId = createAttachmentId(input.threadId);
      if (!attachmentId) {
        return null;
      }
      const attachment: ChatAttachment = {
        type: "image",
        id: attachmentId,
        name: image.name,
        mimeType: image.mimeType,
        sizeBytes: image.bytes.byteLength,
      };
      const attachmentPath = resolveAttachmentPath({
        attachmentsDir: config.attachmentsDir,
        attachment,
      });
      if (!attachmentPath) {
        return null;
      }
      yield* fs.makeDirectory(config.attachmentsDir, { recursive: true });
      yield* fs.writeFile(attachmentPath, image.bytes);
      return attachment;
    });

    const attachments = yield* Effect.forEach(
      input.inputs.slice(0, PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
      (imageInput) =>
        persistOne(imageInput).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Failed to persist an assistant-generated image", { cause }).pipe(
              Effect.as(null),
            ),
          ),
        ),
      { concurrency: 1 },
    );
    return attachments.filter((attachment): attachment is ChatAttachment => attachment !== null);
  },
);
