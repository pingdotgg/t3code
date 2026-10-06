import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/**
 * UI that Claude Code plugins draw for a headless session: `$.ui.status`
 * lines, `$.ui.toast` notices and the `AbovePrompt` band a `ui.render` hook
 * returns. The Claude CLI streams these as `ui_*` messages; the server keeps
 * the latest per thread and clients draw it. Nothing here is persisted.
 */

/** Where an element's handler lives, as the CLI stamped it. A press names it back. */
export const ClaudePluginUiPressTarget = Schema.Struct({
  plugin: Schema.String,
  handle: Schema.Number,
});
export type ClaudePluginUiPressTarget = typeof ClaudePluginUiPressTarget.Type;

export interface ClaudePluginUiElement {
  readonly type: string;
  readonly props?: { readonly [key: string]: unknown };
  readonly press?: ClaudePluginUiPressTarget;
  readonly children?: ReadonlyArray<ClaudePluginUiChild>;
}
export type ClaudePluginUiChild = string | ClaudePluginUiElement;

/**
 * One node of a plugin's render tree. Kept loose on purpose: the CLI already
 * validated it against the desktop element table, and clients draw the types
 * they know and skip the rest.
 */
export const ClaudePluginUiElement: Schema.Codec<ClaudePluginUiElement> = Schema.Struct({
  type: Schema.String,
  props: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  press: Schema.optionalKey(ClaudePluginUiPressTarget),
  children: Schema.optionalKey(
    Schema.Array(
      Schema.Union([
        Schema.String,
        Schema.suspend((): Schema.Codec<ClaudePluginUiElement> => ClaudePluginUiElement),
      ]),
    ),
  ),
});

export const ClaudePluginUiStatus = Schema.Struct({
  plugin: Schema.String,
  text: Schema.String,
});
export type ClaudePluginUiStatus = typeof ClaudePluginUiStatus.Type;

export const ClaudePluginUiToast = Schema.Struct({
  id: Schema.String,
  plugin: Schema.String,
  text: Schema.String,
  timeoutMs: Schema.Number,
});
export type ClaudePluginUiToast = typeof ClaudePluginUiToast.Type;

export const ClaudePluginUiSnapshot = Schema.Struct({
  statuses: Schema.Array(ClaudePluginUiStatus),
  band: Schema.NullOr(ClaudePluginUiElement),
  /** The latest toast; clients show each `id` once. */
  toast: Schema.NullOr(ClaudePluginUiToast),
});
export type ClaudePluginUiSnapshot = typeof ClaudePluginUiSnapshot.Type;

export const ClaudePluginUiSubscribeInput = Schema.Struct({
  threadId: ThreadId,
});
export type ClaudePluginUiSubscribeInput = typeof ClaudePluginUiSubscribeInput.Type;

export const ClaudePluginUiPressInput = Schema.Struct({
  threadId: ThreadId,
  plugin: Schema.String,
  handle: Schema.Number,
  key: Schema.optionalKey(Schema.String),
});
export type ClaudePluginUiPressInput = typeof ClaudePluginUiPressInput.Type;

/**
 * Terminal columns the band is laid out for. The server asks plugins to fit
 * this width; clients scale the font so it fits theirs.
 */
export const CLAUDE_PLUGIN_UI_BAND_COLUMNS = 100;

export const EMPTY_CLAUDE_PLUGIN_UI_SNAPSHOT: ClaudePluginUiSnapshot = {
  statuses: [],
  band: null,
  toast: null,
};
