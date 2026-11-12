import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { OwnedWorkItem } from "./ownedWork.ts";
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

/**
 * Cross-seat owned-work obligations for one actor (OpenRig `rig queue list --owned`).
 * Items still live on their home thread; the actor claims/acts against that home id.
 */
export const OrchestrationV2OwnedWorkInboxEntry = Schema.Struct({
  homeThreadId: ThreadId,
  homeSpecialistKey: Schema.optional(ThreadSpecialistKey),
  homeLabel: Schema.optional(TrimmedNonEmptyString),
  item: OwnedWorkItem,
});
export type OrchestrationV2OwnedWorkInboxEntry = typeof OrchestrationV2OwnedWorkInboxEntry.Type;

export const OrchestrationV2ListOwnedWorkInboxInput = Schema.Struct({
  projectId: ProjectId,
  actorThreadId: ThreadId,
});
export type OrchestrationV2ListOwnedWorkInboxInput =
  typeof OrchestrationV2ListOwnedWorkInboxInput.Type;

export const OrchestrationV2ListOwnedWorkInboxResult = Schema.Struct({
  entries: Schema.Array(OrchestrationV2OwnedWorkInboxEntry),
});
export type OrchestrationV2ListOwnedWorkInboxResult =
  typeof OrchestrationV2ListOwnedWorkInboxResult.Type;
