import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { SpecialistTemplateSource } from "./teamTemplates.ts";
import { ThreadSpecialistKey } from "./threadSpecialist.ts";

export const AgentTeamId = TrimmedNonEmptyString.pipe(Schema.brand("AgentTeamId"));
export type AgentTeamId = typeof AgentTeamId.Type;

export const AgentTeam = Schema.Struct({
  id: AgentTeamId,
  projectId: ProjectId,
  name: TrimmedNonEmptyString,
  installedFrom: SpecialistTemplateSource,
  seatKeys: Schema.NonEmptyArray(ThreadSpecialistKey),
  leadKey: Schema.optional(ThreadSpecialistKey),
  archivedAt: Schema.NullOr(IsoDateTime),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AgentTeam = typeof AgentTeam.Type;

export const AgentTeamSeatStatus = Schema.Literals([
  "idle",
  "active",
  "needs_attention",
  "archived",
]);
export type AgentTeamSeatStatus = typeof AgentTeamSeatStatus.Type;

export const AgentTeamSeatView = Schema.Struct({
  key: ThreadSpecialistKey,
  label: TrimmedNonEmptyString,
  threadId: ThreadId,
  status: AgentTeamSeatStatus,
  openOwnedWorkCount: NonNegativeInt,
  pendingReviewCount: NonNegativeInt,
});
export type AgentTeamSeatView = typeof AgentTeamSeatView.Type;

export const OrchestrationV2ReadAgentTeamInput = Schema.Struct({
  projectId: ProjectId,
});
export type OrchestrationV2ReadAgentTeamInput = typeof OrchestrationV2ReadAgentTeamInput.Type;

export const OrchestrationV2ReadAgentTeamResult = Schema.Struct({
  team: Schema.NullOr(AgentTeam),
  seats: Schema.Array(AgentTeamSeatView),
});
export type OrchestrationV2ReadAgentTeamResult = typeof OrchestrationV2ReadAgentTeamResult.Type;
