import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * Authored in frontmatter and named by models as `targetAgentId`, so ids stay
 * lowercase kebab-case.
 */
export const AgentId = TrimmedNonEmptyString.check(
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("AgentId"));
export type AgentId = typeof AgentId.Type;

/**
 * Same shape as any thread's model selection. Frontmatter may write `provider`
 * in place of `instanceId`, which ModelSelection already decodes.
 */
export const AgentModelSelection = ModelSelection;
export type AgentModelSelection = typeof AgentModelSelection.Type;

/** Cost class used when an agent names no model. An explicit `model` always wins. */
export const AgentTier = Schema.Literals(["economy", "reasoning"]);
export type AgentTier = typeof AgentTier.Type;

/** The roster entry a lead agent chooses a delegation target from. */
export const AgentSummary = Schema.Struct({
  id: AgentId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(80)),
  description: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  tier: Schema.optionalKey(AgentTier),
  model: Schema.optionalKey(AgentModelSelection),
});
export type AgentSummary = typeof AgentSummary.Type;

/** One agent from `.agents/*.md` or `AGENTS.md`. The markdown body is `instructions`. */
export const AgentDefinition = Schema.Struct({
  ...AgentSummary.fields,
  tier: Schema.optionalKey(AgentTier),
  /** Agents this one may hand work to. Empty means it cannot delegate. */
  canDelegateTo: Schema.Array(AgentId).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  instructions: TrimmedNonEmptyString.check(Schema.isMaxLength(120_000)),
});
export type AgentDefinition = typeof AgentDefinition.Type;

export const AgentListInput = Schema.Struct({
  projectId: ProjectId,
  /** When supplied, ensure the project roster is requested for this thread's project. */
  threadId: Schema.optional(ThreadId),
});
export type AgentListInput = typeof AgentListInput.Type;

export class AgentListError extends Schema.TaggedError<AgentListError>()("AgentListError", {
  projectId: ProjectId,
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return `Unable to list custom agents for project ${this.projectId}.`;
  }
}
