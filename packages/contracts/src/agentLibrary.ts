import * as Schema from "effect/Schema";
import { AgentSkill } from "./agentSkills.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { McpGatewayProfile } from "./settings.ts";

/** Null creates: the item must not exist yet. Otherwise the stored revision must match. */
const BaseRevision = Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)));

/**
 * One item edit against the revision the writer saw. The server owns `revision`, `createdAt` and
 * `updatedAt`; an upserted skill without `resources`, or a stub, keeps the stored body.
 */
export const AgentLibraryOperation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("profile.upsert"),
    profile: McpGatewayProfile,
    baseRevision: BaseRevision,
  }),
  Schema.Struct({
    type: Schema.Literal("profile.delete"),
    profileId: TrimmedNonEmptyString,
    baseRevision: Schema.Int,
  }),
  Schema.Struct({
    type: Schema.Literal("skill.upsert"),
    skill: AgentSkill,
    baseRevision: BaseRevision,
  }),
  Schema.Struct({
    type: Schema.Literal("skill.delete"),
    skillId: TrimmedNonEmptyString,
    baseRevision: Schema.Int,
  }),
]);
export type AgentLibraryOperation = typeof AgentLibraryOperation.Type;

export const AgentLibraryMutationInput = Schema.Struct({
  operations: Schema.Array(AgentLibraryOperation).check(Schema.isMaxLength(400)),
});
export type AgentLibraryMutationInput = typeof AgentLibraryMutationInput.Type;

/** The stored state of every touched item, including agents a skill deletion unassigned. */
export const AgentLibraryMutationResult = Schema.Struct({
  mcpGatewayProfiles: Schema.Array(McpGatewayProfile),
  agentSkills: Schema.Array(AgentSkill),
  mcpGatewayProfileDeletedAt: Schema.Record(Schema.String, Schema.String),
  agentSkillDeletedAt: Schema.Record(Schema.String, Schema.String),
});
export type AgentLibraryMutationResult = typeof AgentLibraryMutationResult.Type;

export class AgentLibraryConflictError extends Schema.TaggedError<AgentLibraryConflictError>()(
  "AgentLibraryConflictError",
  {
    itemKind: Schema.Literals(["agent", "skill"]),
    itemId: Schema.String,
    itemName: Schema.optional(Schema.String),
    reason: Schema.Literals(["revision", "name", "missing", "exists"]),
    expectedRevision: Schema.optional(Schema.NullOr(Schema.Int)),
    actualRevision: Schema.optional(Schema.NullOr(Schema.Int)),
  },
) {
  override get message(): string {
    const label = `${this.itemKind === "agent" ? "Agent" : "Skill"} ${this.itemName === undefined ? this.itemId : `"${this.itemName}"`}`;
    switch (this.reason) {
      case "name":
        return `An agent named "${this.itemName ?? this.itemId}" already exists (names ignore case).`;
      case "missing":
        return `${label} no longer exists.`;
      case "exists":
        return `${label} already exists.`;
      case "revision":
        return `${label} changed elsewhere (revision ${this.actualRevision ?? "deleted"}, expected ${this.expectedRevision ?? "new"}). Reload and try again.`;
    }
  }
}

export const GetAgentSkillsInput = Schema.Struct({
  skillIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(200)),
});

/** Full skills for the requested ids that still exist; missing ids are left out. */
export const GetAgentSkillsResult = Schema.Struct({
  agentSkills: Schema.Array(AgentSkill),
});
export type GetAgentSkillsResult = typeof GetAgentSkillsResult.Type;
