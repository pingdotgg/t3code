import type { PluginId } from "@t3tools/contracts/plugin";
import type { PluginToolDescriptor, PluginToolResult } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Tool } from "effect/unstable/ai";

import {
  PLUGIN_TOOL_MAX_CONTENT_ITEMS,
  PLUGIN_TOOL_MAX_DESCRIPTION_LENGTH,
  PLUGIN_TOOL_MAX_PER_PLUGIN,
  PLUGIN_TOOL_MAX_SCHEMA_DEPTH,
  PLUGIN_TOOL_MAX_SCHEMA_JSON_BYTES,
  PLUGIN_TOOL_MAX_TEXT_CHARS,
  PLUGIN_TOOL_MAX_TITLE_LENGTH,
} from "./pluginToolBounds.ts";
import { isValidPluginToolLocalName, pluginToolFinalName } from "./pluginToolNames.ts";

export interface PluginToolAnnotations {
  readonly title?: string | undefined;
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export interface ValidatedPluginTool {
  readonly localName: string;
  readonly finalName: string;
  readonly description: string;
  readonly inputSchema: Schema.Decoder<unknown, never>;
  readonly inputJsonSchema: unknown;
  readonly annotations: PluginToolAnnotations;
  readonly fingerprint: string;
}

export const pluginToolValidationError = (pluginId: PluginId, detail: string) =>
  ({ pluginId, detail }) as const;

export type PluginToolValidationError = ReturnType<typeof pluginToolValidationError>;

const jsonSchemaDepth = (value: unknown, depth: number): number => {
  if (value === null || typeof value !== "object") return depth;
  if (Array.isArray(value)) {
    let max = depth;
    for (const item of value) {
      max = Math.max(max, jsonSchemaDepth(item, depth + 1));
    }
    return max;
  }
  let max = depth;
  for (const nested of Object.values(value as Record<string, unknown>)) {
    max = Math.max(max, jsonSchemaDepth(nested, depth + 1));
  }
  return max;
};

const isServiceFreeDecoder = (value: unknown): value is Schema.Decoder<unknown, never> => {
  if (value === null || typeof value !== "object") return false;
  // Effect Schema codecs expose an AST; reject plain objects/functions that
  // cannot participate in getJsonSchemaFromSchema / decodeUnknownEffect.
  return "ast" in value;
};

const deriveJsonSchema = (inputSchema: Schema.Decoder<unknown, never>): unknown | null => {
  try {
    return Tool.getJsonSchemaFromSchema(inputSchema);
  } catch {
    return null;
  }
};

/**
 * MCP delivers `tools/call.arguments` as a string-keyed record, so the derived
 * input schema must have an object root. A scalar root (Schema.String) or a
 * union root (anyOf/oneOf) describes a payload the protocol cannot express, so
 * the tool would be listed but permanently uncallable.
 *
 * Returns null when the root is acceptable, or a reason fragment otherwise.
 */
const objectRootSchemaError = (jsonSchema: unknown): string | null => {
  if (typeof jsonSchema !== "object" || jsonSchema === null || Array.isArray(jsonSchema)) {
    return "must derive to a JSON Schema object";
  }
  const schema = jsonSchema as Record<string, unknown>;
  if ("anyOf" in schema || "oneOf" in schema || "allOf" in schema) {
    return "must have a single object root (a union/intersection root cannot be expressed by tools/call arguments)";
  }
  if (schema["type"] !== "object") {
    return `must have an object root, not ${JSON.stringify(schema["type"] ?? "an untyped schema")} (tools/call arguments is always a string-keyed record)`;
  }
  return null;
};

export const resolvePluginToolAnnotations = (
  tool: PluginToolDescriptor,
): PluginToolAnnotations | string => {
  if (tool.scope !== "read" && tool.scope !== "operate") {
    return `invalid tool scope ${String(tool.scope)}`;
  }
  if (tool.destructive !== undefined && typeof tool.destructive !== "boolean") {
    return "tool destructive must be a boolean";
  }
  if (tool.idempotent !== undefined && typeof tool.idempotent !== "boolean") {
    return "tool idempotent must be a boolean";
  }
  if (tool.openWorld !== undefined && typeof tool.openWorld !== "boolean") {
    return "tool openWorld must be a boolean";
  }
  if (tool.title !== undefined) {
    if (typeof tool.title !== "string" || tool.title.trim().length === 0) {
      return "tool title must be a non-empty string";
    }
    if (tool.title.length > PLUGIN_TOOL_MAX_TITLE_LENGTH) {
      return `tool title exceeds ${PLUGIN_TOOL_MAX_TITLE_LENGTH} characters`;
    }
  }

  const readOnlyHint = tool.scope === "read";
  const destructiveHint = tool.destructive ?? tool.scope === "operate";
  if (readOnlyHint && destructiveHint) {
    return 'contradictory tool annotations: scope "read" cannot be destructive';
  }

  return {
    ...(tool.title === undefined ? {} : { title: tool.title }),
    readOnlyHint,
    destructiveHint,
    idempotentHint: tool.idempotent ?? false,
    openWorldHint: tool.openWorld ?? false,
  };
};

export const fingerprintPluginTool = (input: {
  readonly finalName: string;
  readonly description: string;
  readonly inputJsonSchema: unknown;
  readonly annotations: PluginToolAnnotations;
}): string =>
  JSON.stringify({
    name: input.finalName,
    description: input.description,
    inputSchema: input.inputJsonSchema,
    annotations: {
      title: input.annotations.title ?? null,
      readOnlyHint: input.annotations.readOnlyHint,
      destructiveHint: input.annotations.destructiveHint,
      idempotentHint: input.annotations.idempotentHint,
      openWorldHint: input.annotations.openWorldHint,
    },
  });

export const validatePluginToolDescriptors = (
  pluginId: PluginId,
  tools: ReadonlyArray<PluginToolDescriptor> | undefined,
  options: {
    readonly hasToolsCapability: boolean;
  },
): Effect.Effect<ReadonlyArray<ValidatedPluginTool>, PluginToolValidationError> => {
  const declared = tools ?? [];
  if (declared.length === 0) {
    return Effect.succeed([]);
  }
  if (!options.hasToolsCapability) {
    return Effect.fail(
      pluginToolValidationError(
        pluginId,
        'plugin declares tools but does not include the "tools" capability',
      ),
    );
  }
  if (declared.length > PLUGIN_TOOL_MAX_PER_PLUGIN) {
    return Effect.fail(
      pluginToolValidationError(
        pluginId,
        `plugin declares ${declared.length} tools; max is ${PLUGIN_TOOL_MAX_PER_PLUGIN}`,
      ),
    );
  }

  const seenLocal = new Set<string>();
  const validated: Array<ValidatedPluginTool> = [];

  for (const tool of declared) {
    if (typeof tool !== "object" || tool === null) {
      return Effect.fail(pluginToolValidationError(pluginId, "tool descriptor must be an object"));
    }
    if (typeof tool.name !== "string" || !isValidPluginToolLocalName(tool.name)) {
      return Effect.fail(
        pluginToolValidationError(
          pluginId,
          `invalid tool name ${String((tool as { name?: unknown }).name)}`,
        ),
      );
    }
    if (seenLocal.has(tool.name)) {
      return Effect.fail(pluginToolValidationError(pluginId, `duplicate tool name ${tool.name}`));
    }
    seenLocal.add(tool.name);

    if (typeof tool.description !== "string" || tool.description.trim().length === 0) {
      return Effect.fail(
        pluginToolValidationError(pluginId, `tool ${tool.name} description must be non-empty`),
      );
    }
    if (tool.description.length > PLUGIN_TOOL_MAX_DESCRIPTION_LENGTH) {
      return Effect.fail(
        pluginToolValidationError(
          pluginId,
          `tool ${tool.name} description exceeds ${PLUGIN_TOOL_MAX_DESCRIPTION_LENGTH} characters`,
        ),
      );
    }
    if (typeof tool.handle !== "function") {
      return Effect.fail(
        pluginToolValidationError(pluginId, `tool ${tool.name} handle must be a function`),
      );
    }
    if (!isServiceFreeDecoder(tool.inputSchema)) {
      return Effect.fail(
        pluginToolValidationError(
          pluginId,
          `tool ${tool.name} inputSchema must be an Effect Schema decoder`,
        ),
      );
    }

    const annotations = resolvePluginToolAnnotations(tool);
    if (typeof annotations === "string") {
      return Effect.fail(pluginToolValidationError(pluginId, `tool ${tool.name}: ${annotations}`));
    }

    const inputJsonSchema = deriveJsonSchema(tool.inputSchema);
    if (inputJsonSchema === null) {
      return Effect.fail(
        pluginToolValidationError(
          pluginId,
          `tool ${tool.name} inputSchema is not JSON-Schema-derivable`,
        ),
      );
    }

    // MCP `tools/call.arguments` is always a string-keyed record, so a scalar or
    // union root (e.g. Schema.String) would advertise a tool that no protocol-valid
    // payload can ever satisfy. Reject at registration rather than shipping a tool
    // the model can see but never successfully call.
    const rootTypeError = objectRootSchemaError(inputJsonSchema);
    if (rootTypeError !== null) {
      return Effect.fail(
        pluginToolValidationError(pluginId, `tool ${tool.name} inputSchema ${rootTypeError}`),
      );
    }

    let schemaJson: string;
    try {
      schemaJson = JSON.stringify(inputJsonSchema);
    } catch {
      return Effect.fail(
        pluginToolValidationError(
          pluginId,
          `tool ${tool.name} inputSchema is not JSON-serializable`,
        ),
      );
    }
    if (new TextEncoder().encode(schemaJson).byteLength > PLUGIN_TOOL_MAX_SCHEMA_JSON_BYTES) {
      return Effect.fail(
        pluginToolValidationError(
          pluginId,
          `tool ${tool.name} inputSchema exceeds ${PLUGIN_TOOL_MAX_SCHEMA_JSON_BYTES} bytes`,
        ),
      );
    }
    if (jsonSchemaDepth(inputJsonSchema, 0) > PLUGIN_TOOL_MAX_SCHEMA_DEPTH) {
      return Effect.fail(
        pluginToolValidationError(
          pluginId,
          `tool ${tool.name} inputSchema exceeds depth ${PLUGIN_TOOL_MAX_SCHEMA_DEPTH}`,
        ),
      );
    }

    const finalName = pluginToolFinalName(pluginId, tool.name);
    validated.push({
      localName: tool.name,
      finalName,
      description: tool.description,
      inputSchema: tool.inputSchema,
      inputJsonSchema,
      annotations,
      fingerprint: fingerprintPluginTool({
        finalName,
        description: tool.description,
        inputJsonSchema,
        annotations,
      }),
    });
  }

  return Effect.succeed(validated);
};

const isPlainJsonObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const isJsonValue = (value: unknown, depth: number): boolean => {
  if (depth > PLUGIN_TOOL_MAX_SCHEMA_DEPTH) return false;
  if (value === null) return true;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return true;
  if (kind === "number") return Number.isFinite(value);
  if (kind === "bigint" || kind === "function" || kind === "symbol" || kind === "undefined") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.every((item) => isJsonValue(item, depth + 1));
  }
  if (!isPlainJsonObject(value)) return false;
  return Object.values(value).every((item) => isJsonValue(item, depth + 1));
};

export const validatePluginToolResult = (
  result: unknown,
):
  | { readonly ok: true; readonly value: PluginToolResult }
  | { readonly ok: false; readonly detail: string } => {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return { ok: false, detail: "tool result must be an object" };
  }
  const record = result as Record<string, unknown>;
  if (!Array.isArray(record.content)) {
    return { ok: false, detail: "tool result.content must be an array" };
  }
  if (record.content.length === 0) {
    return { ok: false, detail: "tool result.content must be non-empty" };
  }
  if (record.content.length > PLUGIN_TOOL_MAX_CONTENT_ITEMS) {
    return {
      ok: false,
      detail: `tool result.content exceeds ${PLUGIN_TOOL_MAX_CONTENT_ITEMS} items`,
    };
  }
  const content: Array<PluginToolResult["content"][number]> = [];
  for (const item of record.content) {
    if (typeof item !== "object" || item === null) {
      return { ok: false, detail: "tool result content item must be an object" };
    }
    const block = item as Record<string, unknown>;
    if (block.type !== "text" || typeof block.text !== "string") {
      return { ok: false, detail: "tool result content supports text blocks only in this slice" };
    }
    if (block.text.length > PLUGIN_TOOL_MAX_TEXT_CHARS) {
      return {
        ok: false,
        detail: `tool result text exceeds ${PLUGIN_TOOL_MAX_TEXT_CHARS} characters`,
      };
    }
    content.push({ type: "text", text: block.text });
  }

  let structuredContent: PluginToolResult["structuredContent"];
  if ("structuredContent" in record && record.structuredContent !== undefined) {
    if (!isPlainJsonObject(record.structuredContent) || !isJsonValue(record.structuredContent, 0)) {
      return {
        ok: false,
        detail: "tool result.structuredContent must be a JSON object",
      };
    }
    structuredContent = record.structuredContent;
  }

  if (record.isError !== undefined && typeof record.isError !== "boolean") {
    return { ok: false, detail: "tool result.isError must be a boolean" };
  }

  return {
    ok: true,
    value: {
      content,
      ...(structuredContent === undefined ? {} : { structuredContent }),
      ...(record.isError === undefined ? {} : { isError: record.isError }),
    },
  };
};
