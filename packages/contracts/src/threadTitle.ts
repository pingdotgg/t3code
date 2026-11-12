import * as Schema from "effect/Schema";

import { CommandId, IsoDateTime } from "./baseSchemas.ts";

export const ThreadTitleRegeneration = Schema.Struct({
  requestId: CommandId,
  startedAt: IsoDateTime,
});
export type ThreadTitleRegeneration = typeof ThreadTitleRegeneration.Type;

export const ThreadTitleRegenerationStatus = Schema.Literals(["renamed", "unchanged", "failed"]);
export type ThreadTitleRegenerationStatus = typeof ThreadTitleRegenerationStatus.Type;

export const ThreadTitleRegenerationOutcome = Schema.Struct({
  status: ThreadTitleRegenerationStatus,
  message: Schema.optional(Schema.String),
});
export type ThreadTitleRegenerationOutcome = typeof ThreadTitleRegenerationOutcome.Type;

export const LastThreadTitleRegeneration = Schema.Struct({
  ...ThreadTitleRegenerationOutcome.fields,
  requestId: CommandId,
  completedAt: IsoDateTime,
});
export type LastThreadTitleRegeneration = typeof LastThreadTitleRegeneration.Type;
