import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** An in-flight title regeneration, as MCP thread metadata reports it. */
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
