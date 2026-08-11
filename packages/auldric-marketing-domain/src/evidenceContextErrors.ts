import * as Schema from "effect/Schema";

export const MarketingEvidenceSafeReference = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._:@-]{0,198}[a-z0-9])?$/u),
).pipe(Schema.brand("MarketingEvidenceSafeReference"));
export type MarketingEvidenceSafeReference = typeof MarketingEvidenceSafeReference.Type;

export const MarketingEvidenceContextFailureReason = Schema.Literals([
  "invalid_context_input",
  "source_not_allowlisted",
  "source_snapshot_mismatch",
  "duplicate_fact_key",
  "locator_content_conflict",
  "candidate_limit_exceeded",
  "budget_too_small",
]);
export type MarketingEvidenceContextFailureReason =
  typeof MarketingEvidenceContextFailureReason.Type;

export class MarketingEvidenceContextError extends Schema.TaggedErrorClass<MarketingEvidenceContextError>()(
  "MarketingEvidenceContextError",
  {
    reason: MarketingEvidenceContextFailureReason,
    reference: Schema.optionalKey(MarketingEvidenceSafeReference),
  },
) {
  override get message(): string {
    return "The bounded Marketing evidence context could not be compiled safely.";
  }
}

export const MarketingEvidenceServiceFailureReason = Schema.Literals([
  "invalid_service_input",
  "source_not_found",
  "source_record_invalid",
  "fact_record_invalid",
  "canonical_snapshot_changed",
  "adapter_not_registered",
  "adapter_output_invalid",
  "adapter_source_mismatch",
  "adapter_bounds_exceeded",
  "fact_transition_invalid",
  "canonical_readback_mismatch",
]);
export type MarketingEvidenceServiceFailureReason =
  typeof MarketingEvidenceServiceFailureReason.Type;

export class MarketingEvidenceServiceError extends Schema.TaggedErrorClass<MarketingEvidenceServiceError>()(
  "MarketingEvidenceServiceError",
  {
    reason: MarketingEvidenceServiceFailureReason,
    reference: Schema.optionalKey(MarketingEvidenceSafeReference),
  },
) {
  override get message(): string {
    return "The Marketing evidence service rejected an unsafe or inconsistent operation.";
  }
}

export class MarketingEvidenceSourceAdapterError extends Schema.TaggedErrorClass<MarketingEvidenceSourceAdapterError>()(
  "MarketingEvidenceSourceAdapterError",
  {
    code: Schema.String.check(
      Schema.isTrimmed(),
      Schema.isNonEmpty(),
      Schema.isMaxLength(100),
      Schema.isPattern(/^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/u),
    ),
  },
) {
  override get message(): string {
    return "The authorized Marketing evidence source could not be retrieved.";
  }
}

export const MarketingEvidenceContextDomainError = Schema.Union([
  MarketingEvidenceContextError,
  MarketingEvidenceServiceError,
]);
export type MarketingEvidenceContextDomainError = typeof MarketingEvidenceContextDomainError.Type;
