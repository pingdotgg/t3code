import * as Schema from "effect/Schema";

import { ProjectId } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderSkill } from "./server.ts";

export const AgentSkillQuery = Schema.Struct({
  projectId: Schema.optionalKey(ProjectId),
});
export type AgentSkillQuery = typeof AgentSkillQuery.Type;

export const AgentSkillInstallation = Schema.Struct({
  ...ServerProviderSkill.fields,
  instanceId: ProviderInstanceId,
  provider: ProviderDriverKind,
  providerName: Schema.String,
  providerEnabled: Schema.Boolean,
});
export type AgentSkillInstallation = typeof AgentSkillInstallation.Type;

// One file can be linked into multiple providers under different names and policies.
export const AgentSkillSummary = Schema.Struct({
  id: Schema.String,
  resolvedPath: Schema.NullOr(Schema.String),
  installations: Schema.Array(AgentSkillInstallation),
});
export type AgentSkillSummary = typeof AgentSkillSummary.Type;

export const AgentSkillCatalog = Schema.Struct({
  skills: Schema.Array(AgentSkillSummary),
  issues: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      providerName: Schema.String,
      message: Schema.String,
    }),
  ),
});
export type AgentSkillCatalog = typeof AgentSkillCatalog.Type;

export const AgentSkillDetailParams = Schema.Struct({ id: Schema.String });
export type AgentSkillDetailParams = typeof AgentSkillDetailParams.Type;

export const AgentSkillDetail = Schema.Struct({
  ...AgentSkillSummary.fields,
  content: Schema.String,
});
export type AgentSkillDetail = typeof AgentSkillDetail.Type;
