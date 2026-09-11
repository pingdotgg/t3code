import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";

export const AgentSkillQuery = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentSkillQuery = typeof AgentSkillQuery.Type;

export const AgentSkillScope = Schema.Literals(["project", "global"]);
export type AgentSkillScope = typeof AgentSkillScope.Type;

export const AgentSkillSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  path: Schema.String,
  scope: AgentSkillScope,
  agents: Schema.Array(Schema.String),
  source: Schema.NullOr(Schema.String),
  sourceUrl: Schema.NullOr(Schema.String),
  sourceType: Schema.NullOr(Schema.String),
});
export type AgentSkillSummary = typeof AgentSkillSummary.Type;

export const AgentSkillCatalog = Schema.Array(AgentSkillSummary);
export type AgentSkillCatalog = typeof AgentSkillCatalog.Type;

export const AgentSkillDetailParams = Schema.Struct({
  scope: AgentSkillScope,
  name: Schema.String,
});
export type AgentSkillDetailParams = typeof AgentSkillDetailParams.Type;

export const AgentSkillDetail = Schema.Struct({
  ...AgentSkillSummary.fields,
  content: Schema.String,
});
export type AgentSkillDetail = typeof AgentSkillDetail.Type;
