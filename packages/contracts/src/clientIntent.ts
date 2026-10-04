import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** Right-panel surfaces a client can open beside a thread when asked to show it. */
export const ClientIntentThreadPanel = Schema.Literals(["diff", "files"]);
export type ClientIntentThreadPanel = typeof ClientIntentThreadPanel.Type;

/**
 * A server request for connected clients to show a thread. Every subscribed
 * client receives it. The client named by `targetClientId` (its preview
 * automation id) acts even when unfocused; any visible, focused client also
 * acts, so the window the user is looking at follows along.
 */
export const ClientIntent = Schema.Struct({
  type: Schema.Literal("openThread"),
  intentId: TrimmedNonEmptyString,
  /** The environment the thread belongs to; a client ignores intents for other environments. */
  environmentId: EnvironmentId,
  threadId: ThreadId,
  panel: Schema.optional(ClientIntentThreadPanel),
  targetClientId: Schema.optional(TrimmedNonEmptyString),
});
export type ClientIntent = typeof ClientIntent.Type;
