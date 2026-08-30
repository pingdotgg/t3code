import * as Schema from "effect/Schema";

import { NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  UsageCostSource,
  UsageDay,
  UsagePricingStatus,
  UsageProviderKind,
  UsageResolution,
  UsageSourceStatus,
  UsageTokenTotals,
} from "./usage.ts";

export const ENVIRONMENT_USAGE_MCP_MAX_DAYS = 31;
export const ENVIRONMENT_USAGE_MCP_DEFAULT_BUCKET_LIMIT = 100;
export const ENVIRONMENT_USAGE_MCP_MAX_BUCKET_LIMIT = 200;
export const ENVIRONMENT_USAGE_MCP_MAX_TEXT_CHARACTERS = 256;

export const EnvironmentUsageMcpInput = Schema.Struct({
  sinceDay: UsageDay.annotate({
    description: "Inclusive first calendar day in timeZone, formatted YYYY-MM-DD.",
  }),
  untilDay: UsageDay.annotate({
    description: `Inclusive last calendar day in timeZone, formatted YYYY-MM-DD. Daily windows may cover at most ${ENVIRONMENT_USAGE_MCP_MAX_DAYS} days.`,
  }),
  timeZone: TrimmedNonEmptyString.annotate({
    description: "IANA time-zone name used to bucket calendar days, such as America/Los_Angeles.",
  }),
  resolution: Schema.optional(
    UsageResolution.annotate({
      description: "Bucket resolution. Defaults to day; hour is limited to 24 hours.",
    }),
  ),
  sinceTime: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Inclusive ISO instant. Required only for hourly resolution.",
    }),
  ),
  untilTime: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Exclusive ISO instant. Required only for hourly resolution.",
    }),
  ),
  bucketCursor: Schema.optional(
    NonNegativeInt.annotate({
      description:
        "Zero-based bucket offset into this live summary. Defaults to 0; later pages may shift as transcripts change.",
    }),
  ),
  bucketLimit: Schema.optional(
    Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(ENVIRONMENT_USAGE_MCP_MAX_BUCKET_LIMIT),
    ).annotate({
      description: `Bucket page size. Defaults to ${ENVIRONMENT_USAGE_MCP_DEFAULT_BUCKET_LIMIT}; maximum ${ENVIRONMENT_USAGE_MCP_MAX_BUCKET_LIMIT}.`,
    }),
  ),
}).check(
  Schema.makeFilter((input) => {
    const hourly = input.resolution === "hour";
    const hasSinceTime = input.sinceTime !== undefined;
    const hasUntilTime = input.untilTime !== undefined;
    if (hourly) {
      return hasSinceTime && hasUntilTime
        ? true
        : "Hourly resolution requires sinceTime and untilTime.";
    }
    return !hasSinceTime && !hasUntilTime
      ? true
      : "sinceTime and untilTime are accepted only for hourly resolution.";
  }),
);
export type EnvironmentUsageMcpInput = typeof EnvironmentUsageMcpInput.Type;

export const EnvironmentUsageMcpTextWindow = Schema.Struct({
  text: Schema.String,
  characters: NonNegativeInt,
  maximumCharacters: NonNegativeInt,
  truncated: Schema.Boolean,
});
export type EnvironmentUsageMcpTextWindow = typeof EnvironmentUsageMcpTextWindow.Type;

export const EnvironmentUsageMcpBucket = Schema.Struct({
  day: UsageDay,
  hourStart: Schema.NullOr(TrimmedNonEmptyString),
  provider: UsageProviderKind,
  model: EnvironmentUsageMcpTextWindow,
  totals: UsageTokenTotals,
  costUsd: Schema.Number,
  cacheSavingsUsd: Schema.Number,
  costSource: UsageCostSource,
  records: NonNegativeInt,
  unpricedRecords: NonNegativeInt,
  sessions: NonNegativeInt,
});
export type EnvironmentUsageMcpBucket = typeof EnvironmentUsageMcpBucket.Type;

export const EnvironmentUsageMcpSource = Schema.Struct({
  provider: UsageProviderKind,
  status: UsageSourceStatus,
  scannedFiles: NonNegativeInt,
  skippedFiles: NonNegativeInt,
  malformedRecords: NonNegativeInt,
  distinctSessions: NonNegativeInt,
  message: Schema.NullOr(EnvironmentUsageMcpTextWindow),
});
export type EnvironmentUsageMcpSource = typeof EnvironmentUsageMcpSource.Type;

export const EnvironmentUsageMcpPricingSource = Schema.Literals(["litellm_public_model_prices"]);
export type EnvironmentUsageMcpPricingSource = typeof EnvironmentUsageMcpPricingSource.Type;

export const EnvironmentUsageMcpResult = Schema.Struct({
  readAt: TrimmedNonEmptyString,
  timeZone: TrimmedNonEmptyString,
  sinceDay: UsageDay,
  untilDay: UsageDay,
  resolution: UsageResolution,
  buckets: Schema.Array(EnvironmentUsageMcpBucket),
  bucketCursor: NonNegativeInt,
  bucketNextCursor: Schema.NullOr(NonNegativeInt),
  bucketTotal: NonNegativeInt,
  sources: Schema.Array(EnvironmentUsageMcpSource),
  pricing: Schema.Struct({
    status: UsagePricingStatus,
    source: EnvironmentUsageMcpPricingSource,
    fetchedAt: Schema.NullOr(Schema.String),
    knownModels: NonNegativeInt,
  }),
  scanDurationMs: NonNegativeInt,
  costMeaning: Schema.Literal("api_equivalent_estimate"),
  paginationConsistency: Schema.Literal("live_summary"),
  cacheBehavior: Schema.Literal("may_refresh_existing_usage_caches"),
});
export type EnvironmentUsageMcpResult = typeof EnvironmentUsageMcpResult.Type;

export class EnvironmentUsageMcpFailure extends Schema.TaggedErrorClass<EnvironmentUsageMcpFailure>()(
  "EnvironmentUsageMcpFailure",
  {
    code: Schema.Literals([
      "capability_denied",
      "environment_unavailable",
      "environment_mismatch",
      "invalid_request",
      "usage_unavailable",
    ]),
  },
) {
  override get message(): string {
    switch (this.code) {
      case "capability_denied":
        return "This MCP credential cannot read environment usage.";
      case "environment_unavailable":
        return "The current environment service is unavailable.";
      case "environment_mismatch":
        return "This MCP credential belongs to a different environment.";
      case "invalid_request":
        return "The requested usage window is invalid.";
      case "usage_unavailable":
        return "Environment usage could not be read.";
    }
  }
}
