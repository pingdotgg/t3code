import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

/** Why the latest title regeneration request kept the current title. */
export const ThreadTitleRegenerationFailure = Schema.Struct({
  requestId: CommandId,
  message: TrimmedNonEmptyString,
});
export type ThreadTitleRegenerationFailure = typeof ThreadTitleRegenerationFailure.Type;
