/**
 * PluginTransforms - Context a trusted local plugin adds to a run before the
 * provider sees it.
 *
 * A plugin declares the transform in `t3-plugin.json`, next to the
 * `transforms` capability and `proposedApi: true`, so consent covers it:
 *
 * ```json
 * "capabilities": ["transforms"],
 * "proposedApi": true,
 * "transforms": { "enrich": { "timeoutSeconds": 5 } }
 * ```
 *
 * and registers the handler the host calls:
 *
 * ```js
 * context.proposed.handle("t3.transform.enrich", async ({ message }) => ({
 *   context: [{ title: "Team conventions", text: await lookUp(message.text) }],
 * }));
 * ```
 *
 * After a run's message is saved and before the provider turn starts, the
 * server calls `t3.transform.enrich` once per run on the first
 * `maxPluginsPerRun` enabled plugins (in catalogue order) that declare it.
 * Only a turn the user started (sent or queued) is enriched, and not a
 * command typed with `/`: steering input, including steering that restarts a
 * run, and wakes the agent, server or app prompts (notifications, delegated
 * task results, restart continuations) are never enriched. Each answer
 * is saved as an item in the run's timeline before the provider starts, and
 * the provider receives exactly the saved items, delimited, ahead of the
 * message text. A plugin is never called twice for one run: a retried or
 * replayed start reuses what was saved, and a call that was cut off is
 * recorded as not added.
 *
 * Enrichment fails open. A plugin that is slow, crashes, is disabled during
 * the call, or answers with something outside the bounds below adds nothing;
 * its timeline item says so and the run proceeds. Return `null` or an empty
 * `context` to add nothing.
 *
 * @module PluginTransforms
 */
import * as Schema from "effect/Schema";

import { EnvironmentId, ProjectId, RunId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import type { OrchestrationV2TurnItem } from "./orchestrationV2.ts";

/** The manifest capability a plugin declares to transform runs. */
export const PLUGIN_TRANSFORMS_CAPABILITY = "transforms";

/** The handler the server calls to enrich a run; plugins register exactly this name. */
export const PLUGIN_ENRICH_HANDLER = "t3.transform.enrich";

export const PLUGIN_ENRICH_LIMITS = {
  defaultTimeoutSeconds: 5,
  maxTimeoutSeconds: 10,
  /** Plugins called for one run, in catalogue order; the rest share one skipped record. */
  maxPluginsPerRun: 4,
  /** Items in one plugin's answer. */
  maxItems: 4,
  maxTitleLength: 100,
  /** One item's text, in UTF-16 code units. */
  maxTextLength: 6_000,
  /** One plugin's serialized answer. */
  maxResultBytes: 8 * 1024,
  /**
   * The serialized answers one run keeps, in catalogue order; an answer that
   * would pass it is not added. Saved context travels with the thread's
   * snapshots, so this keeps it to a small share of their byte budget.
   */
  maxRunContextBytes: 8 * 1024,
  /** The user's text passed to plugins, in UTF-16 code units; longer text is cut. */
  maxMessageTextLength: 16_000,
} as const;

/** The manifest's `transforms` object. */
export const PluginTransformsDeclaration = Schema.Struct({
  enrich: Schema.optionalKey(
    Schema.Struct({
      /** Deadline of one enrich call once the plugin runs; default 5. */
      timeoutSeconds: Schema.optionalKey(
        Schema.Int.check(
          Schema.isBetween({ minimum: 1, maximum: PLUGIN_ENRICH_LIMITS.maxTimeoutSeconds }),
        ),
      ),
    }),
  ),
});
export type PluginTransformsDeclaration = typeof PluginTransformsDeclaration.Type;

/** What `t3.transform.enrich` receives. */
export const PluginEnrichInput = Schema.Struct({
  environmentId: EnvironmentId,
  projectId: ProjectId,
  threadId: ThreadId,
  runId: RunId,
  /** Working directory the provider runs in, when known. */
  cwd: Schema.NullOr(Schema.String),
  message: Schema.Struct({
    /** The user's text as the provider receives it, cut to `maxMessageTextLength`. */
    text: Schema.String,
    truncated: Schema.Boolean,
  }),
});
export type PluginEnrichInput = typeof PluginEnrichInput.Type;

/** One piece of context, shown in the timeline and given to the provider. */
export const PluginContextItem = Schema.Struct({
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(PLUGIN_ENRICH_LIMITS.maxTitleLength)),
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(PLUGIN_ENRICH_LIMITS.maxTextLength)),
});
export type PluginContextItem = typeof PluginContextItem.Type;

/** What `t3.transform.enrich` returns; `null` adds nothing. Unknown fields are ignored. */
export const PluginEnrichResult = Schema.NullOr(
  Schema.Struct({
    context: Schema.Array(PluginContextItem).check(
      Schema.isMaxLength(PLUGIN_ENRICH_LIMITS.maxItems),
    ),
  }),
);
export type PluginEnrichResult = typeof PluginEnrichResult.Type;

/** `toolName` of the timeline items that record plugin context. */
export const PLUGIN_CONTEXT_TOOL_NAME = "plugin_context";

/**
 * `toolSource.key` of the one record that counts the plugins a run did not
 * call; every other record's key is `plugin:<plugin id>`.
 */
export const PLUGIN_CONTEXT_OVERFLOW_SOURCE_KEY = "plugins";

/**
 * A `dynamic_tool` item the server wrote to record plugin context for a run.
 * Its `output` is `{ context: PluginContextItem[] }` once added, or
 * `{ reason: string }` when nothing was added.
 */
export const isPluginContextTurnItem = (
  item: OrchestrationV2TurnItem,
): item is Extract<OrchestrationV2TurnItem, { readonly type: "dynamic_tool" }> =>
  item.type === "dynamic_tool" &&
  item.nativeItemRef === null &&
  item.toolName === PLUGIN_CONTEXT_TOOL_NAME &&
  item.toolSource?.kind === "integration" &&
  (item.toolSource.key === PLUGIN_CONTEXT_OVERFLOW_SOURCE_KEY ||
    item.toolSource.key.startsWith("plugin:"));
