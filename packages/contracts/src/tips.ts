import * as Schema from "effect/Schema";

/** Tips shown under the new-thread composer. Closed so analytics never carries free text. */
export const TipId = Schema.Literals([
  "boring-sidebar",
  "voice-input",
  "claude-codex",
  "phone-app",
  "agent-threads",
  "side-chats",
  "other-computers",
  "mcp-apps",
  "devices",
]);
export type TipId = typeof TipId.Type;

export const TipAnalyticsInput = Schema.Union([
  Schema.Struct({
    event: Schema.Literals([
      "shown",
      "opened",
      "dismissed",
      "restored",
      "completed",
      "marked_tried",
      "marked_not_tried",
    ]),
    tip: TipId,
    /** Stays the same across retries of one event, so ingest keeps a single copy. */
    id: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
    /** When it happened, in epoch ms, so a retry keeps its real time. */
    at: Schema.optionalKey(Schema.Number),
  }),
  Schema.Struct({ event: Schema.Literals(["disabled", "enabled"]) }),
]);
export type TipAnalyticsInput = typeof TipAnalyticsInput.Type;
