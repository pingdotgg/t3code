import * as AWS from "@/AWS";
import { AggregationAuthorization } from "@/AWS/Config";
import * as Test from "@/Test/Alchemy";
import * as config from "@distilled.cloud/aws/config-service";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: AWS.providers() });

// A fixed, syntactically valid aggregator identity. The authorization is a
// pure grant — the target account does not need to exist.
const AGGREGATOR_ACCOUNT = "123456789012";

const findAuthorization = (accountId: string, region: string) =>
  config.describeAggregationAuthorizations.items({}).pipe(
    Stream.filter(
      (auth) =>
        auth.AuthorizedAccountId === accountId &&
        auth.AuthorizedAwsRegion === region,
    ),
    Stream.runHead,
    Effect.map((head) => (head._tag === "Some" ? head.value : undefined)),
  );

class AuthorizationStillExists extends Data.TaggedError(
  "AuthorizationStillExists",
)<{ readonly region: string }> {}

const assertAuthorizationDeleted = (accountId: string, region: string) =>
  findAuthorization(accountId, region).pipe(
    Effect.flatMap((auth) =>
      auth === undefined
        ? Effect.void
        : Effect.fail(new AuthorizationStillExists({ region })),
    ),
    Effect.retry({
      while: (e) => e._tag === "AuthorizationStillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
  );

test.provider(
  "create, update tags, replace on region change, delete",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const auth = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AggregationAuthorization("TestAuth", {
            authorizedAccountId: AGGREGATOR_ACCOUNT,
            authorizedAwsRegion: "us-east-1",
            tags: { Environment: "test" },
          });
        }),
      );

      expect(auth.authorizedAccountId).toBe(AGGREGATOR_ACCOUNT);
      expect(auth.authorizedAwsRegion).toBe("us-east-1");
      expect(auth.aggregationAuthorizationArn).toContain(
        ":aggregation-authorization/",
      );

      // Out-of-band verification via distilled.
      const created = yield* findAuthorization(AGGREGATOR_ACCOUNT, "us-east-1");
      expect(created?.AggregationAuthorizationArn).toBe(
        auth.aggregationAuthorizationArn,
      );
      const tags = yield* config
        .listTagsForResource({
          ResourceArn: auth.aggregationAuthorizationArn,
        })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(tags.Environment).toBe("test");
      expect(tags["alchemy::id"]).toBe("TestAuth");

      // Tags update in place (Put ignores tags on an existing authorization,
      // so this exercises the TagResource sync path).
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AggregationAuthorization("TestAuth", {
            authorizedAccountId: AGGREGATOR_ACCOUNT,
            authorizedAwsRegion: "us-east-1",
            tags: { Environment: "prod" },
          });
        }),
      );
      expect(updated.aggregationAuthorizationArn).toBe(
        auth.aggregationAuthorizationArn,
      );
      const updatedTags = yield* config
        .listTagsForResource({
          ResourceArn: auth.aggregationAuthorizationArn,
        })
        .pipe(
          Effect.map((r) =>
            Object.fromEntries((r.Tags ?? []).map((t) => [t.Key, t.Value])),
          ),
        );
      expect(updatedTags.Environment).toBe("prod");

      // Changing the authorized region replaces the authorization.
      const replaced = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* AggregationAuthorization("TestAuth", {
            authorizedAccountId: AGGREGATOR_ACCOUNT,
            authorizedAwsRegion: "us-west-2",
            tags: { Environment: "prod" },
          });
        }),
      );
      expect(replaced.authorizedAwsRegion).toBe("us-west-2");
      expect(replaced.aggregationAuthorizationArn).not.toBe(
        auth.aggregationAuthorizationArn,
      );
      yield* assertAuthorizationDeleted(AGGREGATOR_ACCOUNT, "us-east-1");

      yield* stack.destroy();
      yield* assertAuthorizationDeleted(AGGREGATOR_ACCOUNT, "us-west-2");
    }),
  { timeout: 120_000 },
);
