import * as Schema from "effect/Schema";

import {
  ApprovalRequestId,
  ClientSurface,
  CommandId,
  EventId,
  IsoDateTime,
  NonNegativeInt,
  ProjectId,
  ProviderItemId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { RepositoryIdentity, ThreadEnvMode } from "./environment.ts";
import { ModelSelection } from "./modelSelection.ts";
import type { OrchestrationV2StoredEvent } from "./orchestrationV2.ts";
import { ProjectIconOverride, ProjectScript } from "./project.ts";

/**
 * Which client dispatched the command that produced this event (#7774).
 * Stamped by the orchestration engine on client-dispatched commands; absent on
 * provider/server-originated events and on commands from clients too old to
 * report it.
 */
export const OrchestrationClientOrigin = Schema.Struct({
  surface: Schema.optional(ClientSurface),
  appVersion: Schema.optional(TrimmedNonEmptyString),
});
export type OrchestrationClientOrigin = typeof OrchestrationClientOrigin.Type;

/** Metadata retained by the shared application event source. */
export const ApplicationEventMetadata = Schema.Struct({
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
  providerItemId: Schema.optional(ProviderItemId),
  adapterKey: Schema.optional(TrimmedNonEmptyString),
  requestId: Schema.optional(ApprovalRequestId),
  ingestedAt: Schema.optional(IsoDateTime),
  origin: Schema.optional(OrchestrationClientOrigin),
});
export type ApplicationEventMetadata = typeof ApplicationEventMetadata.Type;

export const ApplicationProjectCreatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: TrimmedNonEmptyString,
  workspaceRoot: TrimmedNonEmptyString,
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.NullOr(ModelSelection),
  // Per-project override for where new threads start; optional so persisted
  // events from older servers still decode.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  // Optional so persisted events from older servers still decode.
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.Array(ProjectScript),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ApplicationProjectCreatedPayload = typeof ApplicationProjectCreatedPayload.Type;

export const ApplicationProjectMetaUpdatedPayload = Schema.Struct({
  projectId: ProjectId,
  title: Schema.optional(TrimmedNonEmptyString),
  workspaceRoot: Schema.optional(TrimmedNonEmptyString),
  repositoryIdentity: Schema.optional(Schema.NullOr(RepositoryIdentity)),
  defaultModelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
  // Absent = leave unchanged; null = clear the override.
  defaultThreadEnvMode: Schema.optional(Schema.NullOr(ThreadEnvMode)),
  autoPull: Schema.optional(Schema.Boolean),
  faviconPath: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  projectIcon: Schema.optional(Schema.NullOr(ProjectIconOverride)),
  scripts: Schema.optional(Schema.Array(ProjectScript)),
  updatedAt: IsoDateTime,
});
export type ApplicationProjectMetaUpdatedPayload = typeof ApplicationProjectMetaUpdatedPayload.Type;

export const ApplicationProjectDeletedPayload = Schema.Struct({
  projectId: ProjectId,
  deletedAt: IsoDateTime,
});
export type ApplicationProjectDeletedPayload = typeof ApplicationProjectDeletedPayload.Type;

const ApplicationProjectEventBaseFields = {
  sequence: NonNegativeInt,
  eventId: EventId,
  aggregateKind: Schema.Literal("project"),
  aggregateId: ProjectId,
  occurredAt: IsoDateTime,
  commandId: Schema.NullOr(CommandId),
  causationEventId: Schema.NullOr(EventId),
  correlationId: Schema.NullOr(CommandId),
  metadata: ApplicationEventMetadata,
} as const;

export const ApplicationProjectCreatedEvent = Schema.Struct({
  ...ApplicationProjectEventBaseFields,
  type: Schema.Literal("project.created"),
  payload: ApplicationProjectCreatedPayload,
});
export type ApplicationProjectCreatedEvent = typeof ApplicationProjectCreatedEvent.Type;

export const ApplicationProjectMetaUpdatedEvent = Schema.Struct({
  ...ApplicationProjectEventBaseFields,
  type: Schema.Literal("project.meta-updated"),
  payload: ApplicationProjectMetaUpdatedPayload,
});
export type ApplicationProjectMetaUpdatedEvent = typeof ApplicationProjectMetaUpdatedEvent.Type;

export const ApplicationProjectDeletedEvent = Schema.Struct({
  ...ApplicationProjectEventBaseFields,
  type: Schema.Literal("project.deleted"),
  payload: ApplicationProjectDeletedPayload,
});
export type ApplicationProjectDeletedEvent = typeof ApplicationProjectDeletedEvent.Type;

export const ApplicationProjectEvent = Schema.Union([
  ApplicationProjectCreatedEvent,
  ApplicationProjectMetaUpdatedEvent,
  ApplicationProjectDeletedEvent,
]);
export type ApplicationProjectEvent = typeof ApplicationProjectEvent.Type;

/** Events exposed by the retained application event source. */
export type ApplicationStoredEvent = ApplicationProjectEvent | OrchestrationV2StoredEvent;
