import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const AgentAlert = Schema.Struct({
  threadId: ThreadId,
  body: TrimmedNonEmptyString,
});
export type AgentAlert = typeof AgentAlert.Type;
