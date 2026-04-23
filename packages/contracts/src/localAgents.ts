import { Effect, Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ServerLocalAgentSource = Schema.Literal("local-agents");
export type ServerLocalAgentSource = typeof ServerLocalAgentSource.Type;

export const ServerLocalAgentSourceScope = Schema.Literal("project");
export type ServerLocalAgentSourceScope = typeof ServerLocalAgentSourceScope.Type;

export const ServerLocalAgentSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  scope: ServerLocalAgentSourceScope,
  enabled: Schema.Boolean,
  source: ServerLocalAgentSource,
  displayName: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
});
export type ServerLocalAgentSkill = typeof ServerLocalAgentSkill.Type;

export const ServerLocalAgentCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  scope: ServerLocalAgentSourceScope,
  source: ServerLocalAgentSource,
  description: Schema.optional(TrimmedNonEmptyString),
  inputHint: Schema.optional(TrimmedNonEmptyString),
});
export type ServerLocalAgentCommand = typeof ServerLocalAgentCommand.Type;

export const ServerLocalAgentInventory = Schema.Struct({
  skills: Schema.Array(ServerLocalAgentSkill).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  commands: Schema.Array(ServerLocalAgentCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ServerLocalAgentInventory = typeof ServerLocalAgentInventory.Type;
