/**
 * PluginTools - Tools a trusted local plugin offers to agents.
 *
 * A plugin declares its tools in `t3-plugin.json`, next to the `tools`
 * capability and `proposedApi: true`, so they are covered by the digest the
 * user consented to and listing them never starts the plugin:
 *
 * ```json
 * "capabilities": ["tools"],
 * "proposedApi": true,
 * "tools": [{
 *   "name": "word_count",
 *   "description": "Count the words in a text.",
 *   "inputSchema": {
 *     "type": "object",
 *     "properties": { "text": { "type": "string" } },
 *     "required": ["text"],
 *     "additionalProperties": false
 *   },
 *   "sideEffect": "read"
 * }]
 * ```
 *
 * Each tool runs the handler the plugin registers as `t3.tool.<name>`:
 *
 * ```js
 * context.proposed.handle("t3.tool.word_count", ({ input }) => ({
 *   words: input.text.split(/\s+/).length,
 * }));
 * ```
 *
 * Agents never see one MCP tool per plugin tool. Every provider session gets
 * the same two fixed tools: `plugin_tools_list` shows the declarations below,
 * qualified by plugin id, and `plugin_tool_call` calls one by that name. The
 * host checks every call against the declared input schema before the plugin
 * sees it. `sideEffect` and `openWorld` are metadata for the agent, not
 * enforcement: the plugin is trusted local code.
 *
 * Input schemas use a JSON Schema (draft 2020-12) subset, and the host
 * enforces each keyword it accepts with JSON Schema's own meaning. A manifest
 * using anything else is refused when the plugin is added, naming the keyword:
 *
 * - `type`: one of, or an array of, `object`, `array`, `string`, `number`,
 *   `integer`, `boolean`, `null`. The root is `"type": "object"`.
 * - objects: `properties`, `required` (names from `properties`),
 *   `additionalProperties` as `true` or `false` (omitted means `true`).
 * - arrays: `items`, `minItems`, `maxItems`.
 * - strings: `minLength`, `maxLength`, counted in Unicode code points.
 * - numbers and integers: `minimum`, `maximum`, `exclusiveMinimum`,
 *   `exclusiveMaximum`.
 * - `enum` and `const` with string, number, boolean, or null values.
 * - `anyOf`.
 * - `$defs` at the root and `"$ref": "#/$defs/<name>"`. A reference cycle
 *   must pass through `properties` or `items`.
 * - Annotations, shown but not enforced: `title`, `description`, `default`,
 *   `examples`, `deprecated`, `readOnly`, `writeOnly`, `format`, `$comment`.
 *   The host never fills in a `default`.
 *
 * Type-specific keywords need their `type`; `$ref` and `anyOf` take only
 * annotations beside them. Every keyword must have its JSON Schema shape (a
 * `null` is refused, never read as absent), and every `$defs` entry is held to
 * the subset whether or not it is referenced. A plugin written with Effect Schema can generate the
 * schema at build time:
 *
 * ```ts
 * const { schema, definitions } = Schema.toJsonSchemaDocument(Input, { onExcessProperty: "error" });
 * const inputSchema = Object.keys(definitions).length === 0 ? schema : { ...schema, $defs: definitions };
 * ```
 *
 * @module PluginTools
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/** The manifest capability a plugin declares to offer tools. */
export const PLUGIN_TOOLS_CAPABILITY = "tools";

/** Handler names starting with this run declared tools; the prefix is reserved. */
export const PLUGIN_TOOL_HANDLER_PREFIX = "t3.tool.";

/**
 * Handler that runs one tool. It receives `{ input, context: { environmentId, threadId } }`:
 * `input` already matched the tool's schema, and `context` comes from the calling
 * session's credential, never from the agent.
 */
export const pluginToolHandlerName = (name: PluginToolName) =>
  `${PLUGIN_TOOL_HANDLER_PREFIX}${name}`;

export const PLUGIN_TOOL_LIMITS = {
  maxToolsPerPlugin: 32,
  /** Serialized `inputSchema` of one tool. */
  maxInputSchemaBytes: 16 * 1024,
  /** Nesting of schemas inside one `inputSchema`. */
  maxInputSchemaDepth: 32,
  /** One plugin's tools as `plugin_tools_list` shows them, so every plugin fits on a page. */
  maxPluginListingBytes: 48 * 1024,
  /** A whole serialized `plugin_tools_list` result. */
  maxListBytes: 64 * 1024,
  /** Serialized result of one tool call. */
  maxResultBytes: 64 * 1024,
  defaultTimeoutSeconds: 60,
  maxTimeoutSeconds: 600,
} as const;

/** Unique within its plugin; agents address it as `<pluginId>/<name>`. */
export const PluginToolName = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]{0,63}$/));
export type PluginToolName = typeof PluginToolName.Type;

/**
 * What a tool may do: `read` only observes, `write` changes state, and
 * `destructive` may lose data. Shown to the agent; not enforced.
 */
export const PluginToolSideEffect = Schema.Literals(["read", "write", "destructive"]);
export type PluginToolSideEffect = typeof PluginToolSideEffect.Type;

const PluginToolTitle = Schema.String.check(Schema.isMaxLength(100));
const PluginToolDescriptionText = TrimmedNonEmptyString.check(Schema.isMaxLength(2000));

/** A JSON Schema object in the subset above; the root describes an object. */
const JsonSchemaObject = Schema.Record(Schema.String, Schema.Json);

/** One entry of the manifest's `tools` array. */
export const PluginToolDeclaration = Schema.Struct({
  name: PluginToolName,
  title: Schema.optionalKey(PluginToolTitle),
  description: PluginToolDescriptionText,
  inputSchema: JsonSchemaObject,
  sideEffect: PluginToolSideEffect,
  /** True when the tool reaches outside this machine (network, external services). */
  openWorld: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  /** Deadline of the tool's handler once its plugin runs; default 60. */
  timeoutSeconds: Schema.optionalKey(
    Schema.Int.check(
      Schema.isBetween({ minimum: 1, maximum: PLUGIN_TOOL_LIMITS.maxTimeoutSeconds }),
    ),
  ),
});
export type PluginToolDeclaration = typeof PluginToolDeclaration.Type;

/** `<pluginId>/<name>`, the name agents call a tool by. */
export const qualifyPluginToolName = (pluginId: string, name: PluginToolName) =>
  `${pluginId}/${name}`;

const decodeToolName = Schema.decodeUnknownOption(PluginToolName);

/** Splits `<pluginId>/<name>` at the first `/`; plugin ids never contain one. */
export const parseQualifiedPluginToolName = (tool: string) => {
  const slash = tool.indexOf("/");
  if (slash <= 0) return Option.none();
  return decodeToolName(tool.slice(slash + 1)).pipe(
    Option.map((name) => ({ pluginId: tool.slice(0, slash), name })),
  );
};

const PluginToolPlugin = Schema.Struct({ id: Schema.String, name: Schema.String });

/** One tool as `plugin_tools_list` shows it. */
export const PluginToolListing = Schema.Struct({
  tool: Schema.String,
  plugin: PluginToolPlugin,
  title: Schema.optionalKey(Schema.String),
  description: Schema.String,
  /** Exactly the declared schema; calls are checked against it. */
  inputSchema: JsonSchemaObject,
  sideEffect: PluginToolSideEffect,
  openWorld: Schema.Boolean,
});
export type PluginToolListing = typeof PluginToolListing.Type;

/**
 * One page of tools, ordered by plugin id. A plugin's tools are never split
 * across pages. Pass `nextCursor` back as `cursor` for the next page.
 */
export const PluginToolsListResult = Schema.Struct({
  tools: Schema.Array(PluginToolListing),
  /** Tool plugins enabled after this session started; a new session can use them. */
  notInThisSession: Schema.Array(PluginToolPlugin),
  nextCursor: Schema.optionalKey(Schema.String),
});
export type PluginToolsListResult = typeof PluginToolsListResult.Type;

/**
 * Why a plugin tool call or listing failed. `reason` is an open string; in
 * use: `not-granted`, `unavailable`, `unknown-tool`, `invalid-input`,
 * `timeout`, `failed`, `result-too-large`.
 */
export class PluginToolError extends Schema.TaggedError<PluginToolError>()("PluginToolError", {
  reason: Schema.String,
  message: Schema.String,
}) {}
