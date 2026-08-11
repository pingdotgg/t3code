import * as Schema from "effect/Schema";

export const MarketingDay0SafeReference = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isNonEmpty(),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9._:@/-]{0,198}[a-z0-9])?$/u),
).pipe(Schema.brand("MarketingDay0SafeReference"));
export type MarketingDay0SafeReference = typeof MarketingDay0SafeReference.Type;

export const MarketingDay0FailureReason = Schema.Literals([
  "invalid_day0_input",
  "evidence_receipt_mismatch",
  "incomplete_route_contract",
  "context_state_mismatch",
  "unsupported_evidence_reference",
  "route_not_registered",
  "route_review_conflict",
  "output_budget_exceeded",
]);
export type MarketingDay0FailureReason = typeof MarketingDay0FailureReason.Type;

export class MarketingDay0Error extends Schema.TaggedErrorClass<MarketingDay0Error>()(
  "MarketingDay0Error",
  {
    reason: MarketingDay0FailureReason,
    reference: Schema.optionalKey(MarketingDay0SafeReference),
  },
) {
  override get message(): string {
    return "The Marketing Day 0 kernel rejected an unsafe or inconsistent packet.";
  }
}
