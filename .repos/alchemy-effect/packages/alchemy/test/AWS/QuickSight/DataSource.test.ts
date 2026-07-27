import * as AWS from "@/AWS";
import { AWSEnvironment } from "@/AWS/Environment.ts";
import { DataSource } from "@/AWS/QuickSight";
import * as Test from "@/Test/Alchemy";
import * as quicksight from "@distilled.cloud/aws/quicksight";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// The testing account has no QuickSight subscription, so the full lifecycle
// is gated behind AWS_TEST_QUICKSIGHT=1 (run on an entitled account). The
// ungated probe below proves both the distilled patch and the gating.
const SUBSCRIBED = !!process.env.AWS_TEST_QUICKSIGHT;

/**
 * Ungated probe: without an account subscription, QuickSight rejects
 * `CreateDataSource` with `ResourceNotFoundException` whose message is
 * "Directory information for account ... is not found." The distilled patch
 * specializes that into the typed `QuickSightSubscriptionRequired` tag. This
 * test asserts the tag is what surfaces (or, on an entitled account, that the
 * probe data source was created and is cleaned up).
 */
test.provider(
  "createDataSource surfaces typed QuickSightSubscriptionRequired without a subscription",
  () =>
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment.current;
      const dataSourceId = "alchemy-quicksight-subscription-probe";

      const outcome = yield* quicksight
        .createDataSource({
          AwsAccountId: accountId,
          DataSourceId: dataSourceId,
          Name: "AlchemyQuickSightSubscriptionProbe",
          Type: "ATHENA",
          DataSourceParameters: {
            AthenaParameters: { WorkGroup: "primary" },
          },
        })
        .pipe(
          Effect.as("created" as const),
          Effect.catchTag("QuickSightSubscriptionRequired", (e) =>
            Effect.succeed(e._tag),
          ),
          // Tolerate a leftover probe from a prior entitled run.
          Effect.catchTag("ResourceExistsException", () =>
            Effect.succeed("created" as const),
          ),
        );

      // Clean up if the account turned out to be subscribed.
      if (outcome === "created") {
        yield* quicksight
          .deleteDataSource({
            AwsAccountId: accountId,
            DataSourceId: dataSourceId,
          })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
      }

      expect(["QuickSightSubscriptionRequired", "created"]).toContain(outcome);
    }),
  { timeout: 60_000 },
);

class DataSourceStillExists extends Data.TaggedError("DataSourceStillExists")<{
  readonly dataSourceId: string;
}> {}

const findDataSource = (accountId: string, dataSourceId: string) =>
  quicksight
    .describeDataSource({ AwsAccountId: accountId, DataSourceId: dataSourceId })
    .pipe(
      Effect.map((r) => r.DataSource),
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

// Gated lifecycle: requires an entitled QuickSight account.
test.provider.skipIf(!SUBSCRIBED)(
  "create Athena data source, verify out-of-band, delete",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* AWSEnvironment.current;
      yield* stack.destroy();

      const { source } = yield* stack.deploy(
        Effect.gen(function* () {
          const source = yield* DataSource("AthenaSource", {
            name: "Alchemy Athena Source",
            type: "ATHENA",
            dataSourceParameters: {
              AthenaParameters: { WorkGroup: "primary" },
            },
          });
          return { source };
        }),
      );

      expect(source.dataSourceId).toBeDefined();
      expect(source.arn).toContain(":datasource/");

      const observed = yield* findDataSource(accountId, source.dataSourceId);
      expect(observed?.Arn).toBe(source.arn);
      expect(observed?.Type).toBe("ATHENA");

      // internal ownership tags applied
      const tags = yield* quicksight
        .listTagsForResource({ ResourceArn: source.arn })
        .pipe(Effect.map((r) => r.Tags ?? []));
      expect(tags.find((t) => t.Key === "alchemy::id")?.Value).toBe(
        "AthenaSource",
      );

      yield* stack.destroy();

      yield* findDataSource(accountId, source.dataSourceId).pipe(
        Effect.flatMap((ds) =>
          ds === undefined || ds.Status === "DELETED"
            ? Effect.void
            : Effect.fail(
                new DataSourceStillExists({
                  dataSourceId: source.dataSourceId,
                }),
              ),
        ),
        Effect.retry({
          while: (e) => e._tag === "DataSourceStillExists",
          schedule: Schedule.max([
            Schedule.exponential(500),
            Schedule.recurs(8),
          ]),
        }),
      );
    }),
  { timeout: 180_000 },
);
