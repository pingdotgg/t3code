import * as Schema from "effect/Schema";

export const RateLimitProps = Schema.Struct({
  binding: Schema.String,
  namespaceId: Schema.String,
  simple: Schema.Struct({
    limit: Schema.Number.check(Schema.isGreaterThan(0)),
    period: Schema.Number.check(Schema.isGreaterThan(0)),
  }),
});
export type RateLimitProps = typeof RateLimitProps.Type;
