import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const TITLE_GENERATION_FAILED_MESSAGE = "The thread title could not be generated.";

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

/** The thread's latest failed title generation, as MCP thread metadata reports it. */
export const ThreadTitleRegenerationFailure = Schema.Struct({
  requestId: CommandId,
  message: TrimmedNonEmptyString,
});
export type ThreadTitleRegenerationFailure = typeof ThreadTitleRegenerationFailure.Type;
