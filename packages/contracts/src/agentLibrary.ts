import * as Schema from "effect/Schema";
import { AgentSkill } from "./agentSkills.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { McpGatewayProfile } from "./settings.ts";

/** Ignored: writes always apply. Clients from before last-write-wins still send it. */
const LegacyBaseRevision = Schema.optionalKey(Schema.NullOr(Schema.Int));

/**
 * One item edit; the latest write wins. The server owns `revision`, `createdAt` and `updatedAt`;
 * an upserted skill without `resources`, or a stub, keeps the stored body.
 */
export const AgentLibraryOperation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("profile.upsert"),
    profile: McpGatewayProfile,
    baseRevision: LegacyBaseRevision,
  }),
  Schema.Struct({
    type: Schema.Literal("profile.delete"),
    profileId: TrimmedNonEmptyString,
    baseRevision: LegacyBaseRevision,
  }),
  Schema.Struct({
    type: Schema.Literal("skill.upsert"),
    skill: AgentSkill,
    baseRevision: LegacyBaseRevision,
  }),
  Schema.Struct({
    type: Schema.Literal("skill.delete"),
    skillId: TrimmedNonEmptyString,
    baseRevision: LegacyBaseRevision,
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

export const GetAgentSkillsInput = Schema.Struct({
  skillIds: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(200)),
});

/** Full skills for the requested ids that still exist; missing ids are left out. */
export const GetAgentSkillsResult = Schema.Struct({
  agentSkills: Schema.Array(AgentSkill),
});
export type GetAgentSkillsResult = typeof GetAgentSkillsResult.Type;
