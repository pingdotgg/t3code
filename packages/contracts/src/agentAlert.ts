import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** A message an agent asked to have shown to the user while its thread is still running. */
export const AgentAlert = Schema.Struct({
  // Two alerts with the same text are still two alerts.
  id: TrimmedNonEmptyString,
  threadId: ThreadId,
  body: TrimmedNonEmptyString,
});
export type AgentAlert = typeof AgentAlert.Type;
