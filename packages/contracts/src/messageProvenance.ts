import * as Schema from "effect/Schema";

import { EnvironmentId, ThreadId } from "./baseSchemas.ts";

export const OrchestrationV2Actor = Schema.Literals(["user", "agent", "system"]);
export type OrchestrationV2Actor = typeof OrchestrationV2Actor.Type;

export const OrchestrationV2CreationSource = Schema.Literals([
  "web",
  "mobile",
  "mcp",
  "provider",
  "server",
]);
export type OrchestrationV2CreationSource = typeof OrchestrationV2CreationSource.Type;

/** A sender in another environment; senderThreadId refers only to this environment. */
export const OrchestrationV2LinkedSender = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: Schema.String,
});
export type OrchestrationV2LinkedSender = typeof OrchestrationV2LinkedSender.Type;

export const OrchestrationV2MessageProvenance = Schema.Struct({
  createdBy: OrchestrationV2Actor,
  creationSource: OrchestrationV2CreationSource,
  senderThreadId: Schema.optional(ThreadId),
  linkedSender: Schema.optional(OrchestrationV2LinkedSender),
});
export type OrchestrationV2MessageProvenance = typeof OrchestrationV2MessageProvenance.Type;
