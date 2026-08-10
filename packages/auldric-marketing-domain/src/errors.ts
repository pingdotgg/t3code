import * as Schema from "effect/Schema";

export const MarketingActorResolutionFailureReason = Schema.Literals([
  "request_authority_rejected",
  "actor_binding_missing",
  "actor_binding_revoked",
  "membership_missing",
  "membership_revoked",
]);
export type MarketingActorResolutionFailureReason =
  typeof MarketingActorResolutionFailureReason.Type;

export class MarketingActorResolutionError extends Schema.TaggedErrorClass<MarketingActorResolutionError>()(
  "MarketingActorResolutionError",
  { reason: MarketingActorResolutionFailureReason },
) {
  override get message(): string {
    return "Marketing actor authority could not be resolved.";
  }
}

export const MarketingWorkspaceUnavailableReason = Schema.Literals([
  "organization_unavailable",
  "project_unavailable",
  "workspace_unavailable",
  "workspace_database_missing",
  "workspace_database_identity_missing",
  "workspace_database_identity_mismatch",
  "workspace_database_schema_stale",
  "workspace_registry_stale",
]);
export type MarketingWorkspaceUnavailableReason = typeof MarketingWorkspaceUnavailableReason.Type;

export class MarketingWorkspaceUnavailableError extends Schema.TaggedErrorClass<MarketingWorkspaceUnavailableError>()(
  "MarketingWorkspaceUnavailableError",
  { reason: MarketingWorkspaceUnavailableReason },
) {
  override get message(): string {
    return "The authorized Marketing workspace database is unavailable.";
  }
}

export class MarketingWorkspaceCrossOrganizationError extends Schema.TaggedErrorClass<MarketingWorkspaceCrossOrganizationError>()(
  "MarketingWorkspaceCrossOrganizationError",
  {},
) {
  override get message(): string {
    return "The Marketing workspace does not belong to the authorized organization.";
  }
}

export class MarketingWorkspaceConflictError extends Schema.TaggedErrorClass<MarketingWorkspaceConflictError>()(
  "MarketingWorkspaceConflictError",
  { reason: Schema.String },
) {
  override get message(): string {
    return "Marketing identity or workspace state conflicts with the requested operation.";
  }
}

export class MarketingWorkspaceStoreError extends Schema.TaggedErrorClass<MarketingWorkspaceStoreError>()(
  "MarketingWorkspaceStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The Marketing workspace store failed during ${this.operation}.`;
  }
}

export const MarketingWorkspaceDomainError = Schema.Union([
  MarketingActorResolutionError,
  MarketingWorkspaceConflictError,
  MarketingWorkspaceCrossOrganizationError,
  MarketingWorkspaceUnavailableError,
]);
export type MarketingWorkspaceDomainError = typeof MarketingWorkspaceDomainError.Type;
export const isMarketingWorkspaceDomainError = Schema.is(MarketingWorkspaceDomainError);
