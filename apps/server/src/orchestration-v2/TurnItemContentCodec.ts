import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { compactDynamicToolOutput, toolOutputIndicatesFailure } from "@t3tools/shared/toolOutput";

export const MAX_STORED_ITEM_BYTES = 64 * 1024;

const PREVIEW_BYTES = 1_024;
const TOOL_NAME_PREVIEW_CHARS = 256;

export type CommandItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;
export type DynamicToolItem = Extract<OrchestrationV2TurnItem, { type: "dynamic_tool" }>;
export type ToolItem = CommandItem | DynamicToolItem;

const StoredContent = Schema.Struct({
  version: Schema.Literal(1),
  fields: Schema.Record(Schema.String, Schema.Unknown),
});
const StoredContentJson = Schema.fromJsonString(StoredContent);
export const encodeStoredContent = Schema.encodeEffect(StoredContentJson);
export const decodeStoredContent = Schema.decodeEffect(StoredContentJson);

const CommandContentFields = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  input: Schema.String,
  output: Schema.optional(Schema.String),
});
const DynamicToolContentFields = Schema.Struct({
  title: Schema.NullOr(Schema.String),
  toolName: Schema.NullOr(Schema.String),
  input: Schema.Unknown,
  output: Schema.optional(Schema.Unknown),
  viewedImagePath: Schema.optional(Schema.String),
});
export const decodeCommandContentFields = Schema.decodeUnknownEffect(CommandContentFields);
export const decodeDynamicToolContentFields = Schema.decodeUnknownEffect(DynamicToolContentFields);

function jsonStringBytes(value: string, limit: number): number {
  let size = 2;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code === 0x22 ||
      code === 0x5c ||
      code === 0x08 ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d
    ) {
      size += 2;
    } else if (code <= 0x1f) {
      size += 6;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        size += 4;
        index += 1;
      } else {
        size += 6;
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      size += 6;
    } else if (code <= 0x7f) {
      size += 1;
    } else if (code <= 0x7ff) {
      size += 2;
    } else {
      size += 3;
    }
    if (size > limit) return limit + 1;
  }
  return size;
}

/** Counts compact JSON bytes without constructing a second copy of a large result body. */
export function serializedJsonBytesUpTo(value: unknown, limit: number): number {
  const ancestors = new Set<object>();
  const overLimit = limit + 1;
  const add = (left: number, right: number) =>
    left > limit || right > limit || left + right > limit ? overLimit : left + right;

  const visit = (current: unknown, arrayEntry = false): number => {
    if (current === null) return 4;
    switch (typeof current) {
      case "string":
        return jsonStringBytes(current, limit);
      case "boolean":
        return current ? 4 : 5;
      case "number":
        return Number.isFinite(current) ? String(current).length : 4;
      case "undefined":
      case "function":
      case "symbol":
        return arrayEntry ? 4 : 0;
      case "bigint":
        throw new TypeError("BigInt cannot be serialized as JSON.");
      case "object":
        break;
    }

    const object = current as object;
    if (ancestors.has(object)) throw new TypeError("Circular values cannot be serialized as JSON.");
    ancestors.add(object);
    try {
      if (Array.isArray(current)) {
        let size = 2;
        for (let index = 0; index < current.length; index += 1) {
          if (index > 0) size = add(size, 1);
          size = add(size, visit(current[index], true));
          if (size > limit) return overLimit;
        }
        return size;
      }

      let size = 2;
      let hasEntry = false;
      for (const key in current as Record<string, unknown>) {
        if (!Object.hasOwn(current, key)) continue;
        const member = (current as Record<string, unknown>)[key];
        if (member === undefined || typeof member === "function" || typeof member === "symbol") {
          continue;
        }
        if (hasEntry) size = add(size, 1);
        hasEntry = true;
        size = add(size, jsonStringBytes(key, limit));
        size = add(size, 1);
        size = add(size, visit(member));
        if (size > limit) return overLimit;
      }
      return size;
    } finally {
      ancestors.delete(object);
    }
  };

  return visit(value);
}

function previewText(value: string, maxBytes = PREVIEW_BYTES): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const prefix = Buffer.from(value.slice(0, maxBytes), "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
  return `${prefix}\n… stored outside SQLite`;
}

function previewValue(value: unknown): unknown {
  return serializedJsonBytesUpTo(value, PREVIEW_BYTES) <= PREVIEW_BYTES
    ? value
    : { summary: "Large tool input stored outside SQLite", truncated: true };
}

export function previewContentFields(item: ToolItem, contentRef: ToolItem["contentRef"]): ToolItem {
  if (item.type === "command_execution") {
    const failed =
      item.outputIndicatesFailure === true ||
      (item.exitCode === undefined &&
        item.output !== undefined &&
        toolOutputIndicatesFailure(item.output.slice(0, 32_768)));
    return {
      ...item,
      title: item.title === null ? null : previewText(item.title, TOOL_NAME_PREVIEW_CHARS),
      input: previewText(item.input),
      ...(item.output === undefined ? {} : { output: previewText(item.output) }),
      ...(failed ? { outputIndicatesFailure: true } : {}),
      contentRef,
    };
  }

  const compactOutput = compactDynamicToolOutput(item.output);
  const failed =
    item.outputIndicatesFailure === true ||
    compactOutput?.isError === true ||
    (typeof item.output === "string" && toolOutputIndicatesFailure(item.output.slice(0, 32_768)));
  return {
    ...item,
    title: item.title === null ? null : previewText(item.title, TOOL_NAME_PREVIEW_CHARS),
    toolName: item.toolName === null ? null : previewText(item.toolName, TOOL_NAME_PREVIEW_CHARS),
    ...(item.viewedImagePath === undefined
      ? {}
      : { viewedImagePath: previewText(item.viewedImagePath, 512) }),
    input: previewValue(item.input),
    ...(compactOutput === undefined ? { output: undefined } : { output: compactOutput }),
    ...(failed ? { outputIndicatesFailure: true } : {}),
    contentRef,
  };
}

export function storedFields(item: ToolItem) {
  return {
    version: 1 as const,
    fields: {
      title: item.title,
      input: item.input,
      ...(item.output === undefined ? {} : { output: item.output }),
      ...(item.type === "dynamic_tool"
        ? {
            toolName: item.toolName,
            ...(item.viewedImagePath === undefined
              ? {}
              : { viewedImagePath: item.viewedImagePath }),
          }
        : {}),
    },
  };
}
