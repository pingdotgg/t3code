import * as Schema from "effect/Schema";

export const MarginStatsInput = Schema.Struct({
  since: Schema.optional(Schema.String),
});
export type MarginStatsInput = typeof MarginStatsInput.Type;

export const MarginTokenCounts = Schema.Struct({
  input: Schema.Number,
  output: Schema.Number,
  cache_read: Schema.Number,
  cache_creation: Schema.Number,
});
export type MarginTokenCounts = typeof MarginTokenCounts.Type;

export const MarginSavingsEstimate = Schema.Struct({
  tokens_est: Schema.Number,
  cost_usd_est: Schema.Number,
  pct_est: Schema.Number,
});
export type MarginSavingsEstimate = typeof MarginSavingsEstimate.Type;

export const MarginSummaryTotals = Schema.Struct({
  requests: Schema.Number,
  tokens: MarginTokenCounts,
  cost_usd: Schema.Number,
  cost_unknown: Schema.Number,
  tier2_blocks_skipped: Schema.Number,
  tier2_chars_before: Schema.Number,
  tier2_chars_reduced: Schema.Number,
  tier2c_chars_reduced: Schema.Number,
  checkpoint_chars_reduced: Schema.Number,
  pruning_chars_reduced: Schema.Number,
  secrets_redacted: Schema.Number,
});
export type MarginSummaryTotals = typeof MarginSummaryTotals.Type;

export const MarginModelSummary = Schema.Struct({
  model: Schema.String,
  requests: Schema.Number,
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  cache_read_tokens: Schema.Number,
  cache_creation_tokens: Schema.Number,
  cost_usd: Schema.Number,
});
export type MarginModelSummary = typeof MarginModelSummary.Type;

export const MarginCacheBreakSummary = Schema.Struct({
  count: Schema.Number,
  tokens_lost: Schema.Number,
});
export type MarginCacheBreakSummary = typeof MarginCacheBreakSummary.Type;

export const MarginStatsPayload = Schema.Struct({
  since: Schema.String,
  savings: MarginSavingsEstimate,
  totals: MarginSummaryTotals,
  by_model: Schema.Array(MarginModelSummary),
  cache_breaks: Schema.Record(Schema.String, MarginCacheBreakSummary),
});
export type MarginStatsPayload = typeof MarginStatsPayload.Type;

export const MarginStatsResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("unconfigured"),
  }),
  Schema.Struct({
    status: Schema.Literal("unavailable"),
    endpoint: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    endpoint: Schema.String,
    stats: MarginStatsPayload,
  }),
]);
export type MarginStatsResult = typeof MarginStatsResult.Type;
