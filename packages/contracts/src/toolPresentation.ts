import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { ToolLifecycleItemType } from "./providerRuntime.ts";

/**
 * Native presentation contract for tool, skill, and plugin invocations.
 *
 * Provider adapters emit `ItemLifecyclePayload` with an untyped `data` bag
 * whose shape differs per provider (Claude: `{ toolName, input, result }`,
 * Codex: the raw `{ item }` notification, ACP: `{ toolCallId, kind, rawInput,
 * rawOutput }`, ...). Every client used to re-scrape that bag independently,
 * so each one drifted on its own schedule.
 *
 * `ToolPresentation` is the single normalized surface the server derives once
 * (see `@t3tools/shared/toolPresentation`) and attaches to tool activities.
 * Clients switch on `surface` and render; anything unrecognized arrives as
 * `surface: "generic"` with a usable title and inputs, so a new or unknown
 * tool degrades instead of disappearing.
 */

/**
 * What the invocation *is*, i.e. which native surface should render it.
 * `generic` is the safe fallback and is always a valid rendering choice.
 */
export const ToolSurface = Schema.Literals([
  "command",
  "file_read",
  "file_change",
  "file_search",
  "web_search",
  "web_fetch",
  "image",
  "todo",
  "skill",
  "plugin",
  "mcp",
  "subagent",
  "generic",
]);
export type ToolSurface = typeof ToolSurface.Type;

/**
 * Where the invocation came from — orthogonal to {@link ToolSurface}. A skill
 * shipped by a plugin is `surface: "skill"` with `origin: "plugin"`; an MCP
 * server's `search_issues` is `surface: "mcp"` with `origin: "mcp"`.
 */
export const ToolOrigin = Schema.Literals([
  "builtin",
  "mcp",
  "skill",
  "plugin",
  "subagent",
  "unknown",
]);
export type ToolOrigin = typeof ToolOrigin.Type;

/** Identity + provenance of the invoked capability. */
export const ToolProvenance = Schema.Struct({
  origin: ToolOrigin,
  /** Raw provider-side tool name (e.g. `mcp__linear__create_issue`). */
  toolName: Schema.optional(TrimmedNonEmptyString),
  /** Human-facing name with transport prefixes stripped (e.g. `create_issue`). */
  displayName: Schema.optional(TrimmedNonEmptyString),
  /** MCP server that exposes the tool, when `origin` is `mcp`. */
  serverName: Schema.optional(TrimmedNonEmptyString),
  /** Plugin namespace, when the capability ships inside a plugin. */
  pluginName: Schema.optional(TrimmedNonEmptyString),
  /** Skill slug, when `surface` is `skill`. */
  skillName: Schema.optional(TrimmedNonEmptyString),
  /** Subagent type, when `surface` is `subagent`. */
  subagentType: Schema.optional(TrimmedNonEmptyString),
  /** Provider driver that ran the tool. */
  provider: Schema.optional(ProviderDriverKind),
});
export type ToolProvenance = typeof ToolProvenance.Type;

/** How a single input field should be rendered. */
export const ToolInputFieldKind = Schema.Literals([
  "text",
  "path",
  "command",
  "query",
  "url",
  "json",
]);
export type ToolInputFieldKind = typeof ToolInputFieldKind.Type;

/**
 * One normalized input argument. Values are bounded by the deriver; `truncated`
 * marks a value the client should offer to expand from the raw payload.
 */
export const ToolInputField = Schema.Struct({
  label: TrimmedNonEmptyString,
  value: TrimmedNonEmptyString,
  kind: ToolInputFieldKind,
  truncated: Schema.optional(Schema.Boolean),
});
export type ToolInputField = typeof ToolInputField.Type;

/** Execution state of the invocation, normalized across providers. */
export const ToolExecutionState = Schema.Literals([
  "pending",
  "running",
  "succeeded",
  "failed",
  "declined",
]);
export type ToolExecutionState = typeof ToolExecutionState.Type;

/** Bounded preview of what the tool returned. */
export const ToolResultPreview = Schema.Struct({
  /** Bounded text preview of the tool output. */
  text: Schema.optional(TrimmedNonEmptyString),
  truncated: Schema.optional(Schema.Boolean),
  /** Process exit code for command executions. */
  exitCode: Schema.optional(Schema.Int),
  /** Failure message when the tool errored. */
  error: Schema.optional(TrimmedNonEmptyString),
  /** Files the tool touched, for file surfaces. */
  paths: Schema.Array(TrimmedNonEmptyString).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type ToolResultPreview = typeof ToolResultPreview.Type;

export const ToolPermissionDecision = Schema.Literals(["pending", "approved", "denied"]);
export type ToolPermissionDecision = typeof ToolPermissionDecision.Type;

/**
 * Permission state for the invocation. Present only when the provider
 * surfaced one — absence means "no approval gate was involved", not "allowed".
 */
export const ToolPermission = Schema.Struct({
  decision: ToolPermissionDecision,
  reason: Schema.optional(TrimmedNonEmptyString),
});
export type ToolPermission = typeof ToolPermission.Type;

/**
 * Normalized, render-ready description of one tool/skill/plugin invocation.
 *
 * Every field is provider-agnostic. Clients must treat an unrecognized
 * `surface` as `generic` rather than dropping the row.
 */
export const ToolPresentation = Schema.Struct({
  surface: ToolSurface,
  /** Short human label, e.g. `Ran command`, `Skill: caveman`. Never empty. */
  title: TrimmedNonEmptyString,
  /** One-line supporting text, e.g. the command or the primary path. */
  subtitle: Schema.optional(TrimmedNonEmptyString),
  state: ToolExecutionState,
  provenance: ToolProvenance,
  inputs: Schema.Array(ToolInputField).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  result: Schema.optional(ToolResultPreview),
  permission: Schema.optional(ToolPermission),
  /** Canonical item type the presentation was derived from. */
  itemType: Schema.optional(ToolLifecycleItemType),
});
export type ToolPresentation = typeof ToolPresentation.Type;

/**
 * Payload carried by `tool.started` / `tool.updated` / `tool.completed`
 * orchestration activities (`ProviderRuntimeIngestion.ts`). `data` stays the
 * opaque provider bag for disclosure/debugging; `presentation` is the typed
 * surface clients should render.
 */
export const ToolLifecycleActivityPayload = Schema.Struct({
  itemType: ToolLifecycleItemType,
  status: Schema.optional(TrimmedNonEmptyString),
  detail: Schema.optional(TrimmedNonEmptyString),
  data: Schema.optional(Schema.Unknown),
  presentation: Schema.optional(ToolPresentation),
});
export type ToolLifecycleActivityPayload = typeof ToolLifecycleActivityPayload.Type;
