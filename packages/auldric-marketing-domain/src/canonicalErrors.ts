import * as Schema from "effect/Schema";

import {
  MarketingCanonicalObjectIdentity,
  MarketingCanonicalVersion,
  MarketingExpectedVersion,
} from "./canonical.ts";

export class MarketingCanonicalAuthorizationError extends Schema.TaggedErrorClass<MarketingCanonicalAuthorizationError>()(
  "MarketingCanonicalAuthorizationError",
  { reason: Schema.Literal("content_operation_denied") },
) {
  override get message(): string {
    return "The request is not authorized for this canonical Marketing operation.";
  }
}

export const MarketingCanonicalValidationFailureReason = Schema.Literals([
  "invalid_canonical_input",
  "payload_not_json",
  "schema_reference_unregistered",
  "schema_reference_incompatible",
  "definition_reference_unregistered",
  "definition_reference_incompatible",
  "renderer_reference_unregistered",
  "renderer_reference_incompatible",
  "payload_schema_invalid",
  "projection_fact_invalid",
  "invalid_stored_payload",
]);
export type MarketingCanonicalValidationFailureReason =
  typeof MarketingCanonicalValidationFailureReason.Type;

export class MarketingCanonicalValidationError extends Schema.TaggedErrorClass<MarketingCanonicalValidationError>()(
  "MarketingCanonicalValidationError",
  {
    reason: MarketingCanonicalValidationFailureReason,
    reference: Schema.optionalKey(Schema.String),
  },
) {
  override get message(): string {
    return "Canonical Marketing content failed strict validation.";
  }
}

export const MarketingCanonicalConflictReason = Schema.Literals([
  "stale_version",
  "idempotency_key_reused",
  "idempotency_result_stale",
  "duplicate_canonical_claim",
  "canonical_identity_conflict",
  "referenced_object_missing",
  "referenced_revision_missing",
  "referenced_object_kind_mismatch",
  "duplicate_revision_reference",
  "duplicate_projection_fact",
  "workflow_definition_required",
  "projection_source_cannot_be_saved_output",
  "projection_target_must_be_saved_output",
  "canonical_write_not_visible",
]);
export type MarketingCanonicalConflictReason = typeof MarketingCanonicalConflictReason.Type;

export class MarketingCanonicalConflictError extends Schema.TaggedErrorClass<MarketingCanonicalConflictError>()(
  "MarketingCanonicalConflictError",
  {
    reason: MarketingCanonicalConflictReason,
    object: Schema.optionalKey(MarketingCanonicalObjectIdentity),
    expectedVersion: Schema.optionalKey(MarketingExpectedVersion),
    actualVersion: Schema.optionalKey(MarketingCanonicalVersion),
  },
) {
  override get message(): string {
    return "Canonical Marketing content conflicts with the current organization record.";
  }
}

export class MarketingCanonicalNotFoundError extends Schema.TaggedErrorClass<MarketingCanonicalNotFoundError>()(
  "MarketingCanonicalNotFoundError",
  { object: MarketingCanonicalObjectIdentity },
) {
  override get message(): string {
    return "The canonical Marketing object was not found in the authorized workspace.";
  }
}

export class MarketingCanonicalStoreError extends Schema.TaggedErrorClass<MarketingCanonicalStoreError>()(
  "MarketingCanonicalStoreError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `The canonical Marketing store failed during ${this.operation}.`;
  }
}

export const MarketingCanonicalDomainError = Schema.Union([
  MarketingCanonicalAuthorizationError,
  MarketingCanonicalConflictError,
  MarketingCanonicalNotFoundError,
  MarketingCanonicalValidationError,
]);
export type MarketingCanonicalDomainError = typeof MarketingCanonicalDomainError.Type;
export const isMarketingCanonicalDomainError = Schema.is(MarketingCanonicalDomainError);
