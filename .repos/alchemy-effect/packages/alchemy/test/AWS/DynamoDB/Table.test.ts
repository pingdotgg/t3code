import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Table } from "@/AWS/DynamoDB";
import { Stream as KinesisStream } from "@/AWS/Kinesis";
import * as Provider from "@/Provider";
import { isResourceState, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import * as CloudWatch from "@distilled.cloud/aws/cloudwatch";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import { describe, expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe.skipIf(!!process.env.FAST)("AWS.DynamoDB.Table", () => {
  const longGlobalSecondaryIndexStabilization = Schedule.max([
    Schedule.fixed("10 seconds"),
    Schedule.recurs(180),
  ]);

  test.provider("create, update, delete table", (stack) =>
    Effect.gen(function* () {
      yield* logTestStep("starting create/update/delete table");
      yield* stack.destroy();

      yield* logTestStep("deploying base table");
      const table = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Table("TestTable", {
            partitionKey: "id",
            attributes: { id: "S" },
          });
        }),
      );

      const actualTable = yield* DynamoDB.describeTable({
        TableName: table.tableName,
      });
      expect(actualTable.Table?.TableArn).toEqual(table.tableArn);

      yield* logTestStep("destroying base table");
      yield* stack.destroy();

      yield* assertTableIsDeleted(table.tableName);
    }),
  );

  test.provider(
    "list enumerates the deployed table",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const table = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("ListTable", {
              partitionKey: "id",
              attributes: { id: "S" },
            });
          }),
        );

        const provider = yield* Provider.findProvider(Table);
        const all = yield* provider.list();

        const found = all.find((t) => t.tableName === table.tableName);
        expect(found).toBeDefined();
        expect(found?.tableArn).toEqual(table.tableArn);

        yield* stack.destroy();
        yield* assertTableIsDeleted(table.tableName);
      }),
    // The testing account accumulates many tables; hydrating each to full
    // Attributes (describe + tags + PITR + TTL) under control-plane throttle
    // limits needs more than the default per-test budget.
    { timeout: 240_000 },
  );

  test.provider(
    "create, update, and disable table stream configuration through bindings",
    (stack) =>
      Effect.gen(function* () {
        yield* logTestStep("starting stream configuration test");
        yield* stack.destroy();

        yield* logTestStep("deploying table with binding-owned stream");
        const table = yield* stack.deploy(
          Effect.gen(function* () {
            const table = yield* Table("StreamTable", {
              partitionKey: "id",
              attributes: { id: "S" },
            });
            yield* table.bind("TestTableStreamBinding", {
              streamSpecification: {
                StreamEnabled: true,
                StreamViewType: "NEW_AND_OLD_IMAGES",
              },
            });
            return table;
          }),
        );

        const created = yield* waitForTableStreamSpecification(
          table.tableName,
          {
            StreamEnabled: true,
            StreamViewType: "NEW_AND_OLD_IMAGES",
          },
        );
        expect(created.Table?.StreamSpecification).toEqual({
          StreamEnabled: true,
          StreamViewType: "NEW_AND_OLD_IMAGES",
        });
        expect(created.Table?.LatestStreamArn).toBeDefined();

        yield* logTestStep("updating stream view type to KEYS_ONLY");
        yield* stack.deploy(
          Effect.gen(function* () {
            const table = yield* Table("StreamTable", {
              partitionKey: "id",
              attributes: { id: "S" },
            });
            yield* table.bind("TestTableStreamBinding", {
              streamSpecification: {
                StreamEnabled: true,
                StreamViewType: "KEYS_ONLY",
              },
            });
            return table;
          }),
        );

        const updated = yield* waitForTableStreamSpecification(
          table.tableName,
          {
            StreamEnabled: true,
            StreamViewType: "KEYS_ONLY",
          },
        );
        expect(updated.Table?.StreamSpecification).toEqual({
          StreamEnabled: true,
          StreamViewType: "KEYS_ONLY",
        });

        yield* logTestStep("removing stream binding");
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("StreamTable", {
              partitionKey: "id",
              attributes: { id: "S" },
            });
          }),
        );

        const disabled = yield* waitForTableStreamSpecification(
          table.tableName,
          undefined,
        );
        expect(disabled.Table?.StreamSpecification).toBeUndefined();

        yield* logTestStep("destroying stream table");
        yield* stack.destroy();

        yield* assertTableIsDeleted(table.tableName);
      }),
  );

  test.provider(
    "create and update table tags and point-in-time recovery",
    (stack) =>
      Effect.gen(function* () {
        yield* logTestStep("starting tags and point-in-time recovery test");
        yield* stack.destroy();

        yield* logTestStep("deploying tagged table with PITR enabled");
        const table = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("TaggedTable", {
              partitionKey: "id",
              attributes: { id: "S" },
              tags: { Environment: "test" },
              pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: true,
                recoveryPeriod: "7 days",
              },
            });
          }),
        );

        const createdTags = yield* waitForTableTags(table.tableArn, {
          Environment: "test",
        });
        expect(createdTags["Environment"]).toEqual("test");
        expect(table.tags?.["Environment"]).toEqual("test");

        const createdBackups = yield* waitForPointInTimeRecovery(
          table.tableName,
          true,
        );
        expect(
          createdBackups.PointInTimeRecoveryDescription
            ?.PointInTimeRecoveryStatus,
        ).toEqual("ENABLED");
        expect(
          createdBackups.PointInTimeRecoveryDescription?.RecoveryPeriodInDays,
        ).toEqual(7);

        yield* logTestStep("updating tags and disabling PITR");
        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("TaggedTable", {
              partitionKey: "id",
              attributes: { id: "S" },
              tags: { Environment: "prod", Team: "platform" },
              pointInTimeRecoverySpecification: {
                pointInTimeRecoveryEnabled: false,
              },
            });
          }),
        );

        const updatedTags = yield* waitForTableTags(updated.tableArn, {
          Environment: "prod",
          Team: "platform",
        });
        expect(updatedTags["Environment"]).toEqual("prod");
        expect(updatedTags["Team"]).toEqual("platform");
        expect(updated.tags?.["Environment"]).toEqual("prod");
        expect(updated.tags?.["Team"]).toEqual("platform");

        const updatedBackups = yield* waitForPointInTimeRecovery(
          updated.tableName,
          false,
        );
        expect(
          updatedBackups.PointInTimeRecoveryDescription
            ?.PointInTimeRecoveryStatus,
        ).toEqual("DISABLED");

        yield* logTestStep("destroying tagged table");
        yield* stack.destroy();

        yield* assertTableIsDeleted(table.tableName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "create, update, and remove the table resource policy",
    (stack) =>
      Effect.gen(function* () {
        yield* logTestStep("starting resource policy test");
        yield* stack.destroy();

        // The policy document references the table ARN, so deploy the table
        // first and add the policy in a second deploy.
        yield* logTestStep("deploying table without a resource policy");
        const table = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("PolicyTable", {
              partitionKey: "id",
              attributes: { id: "S" },
            });
          }),
        );

        const accountId = table.tableArn.split(":")[4];
        const policyFor = (sid: string, action: string) =>
          JSON.stringify({
            Version: "2012-10-17",
            Statement: [
              {
                Sid: sid,
                Effect: "Allow",
                Principal: { AWS: `arn:aws:iam::${accountId}:root` },
                Action: [action],
                Resource: table.tableArn,
              },
            ],
          });

        yield* logTestStep("adding a resource policy");
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("PolicyTable", {
              partitionKey: "id",
              attributes: { id: "S" },
              resourcePolicy: policyFor(
                "AllowSameAccountDescribe",
                "dynamodb:DescribeTable",
              ),
            });
          }),
        );
        const created = yield* waitForResourcePolicy(
          table.tableArn,
          "AllowSameAccountDescribe",
        );
        expect(created).toContain("AllowSameAccountDescribe");

        yield* logTestStep("updating the resource policy");
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("PolicyTable", {
              partitionKey: "id",
              attributes: { id: "S" },
              resourcePolicy: policyFor(
                "AllowSameAccountGet",
                "dynamodb:GetItem",
              ),
            });
          }),
        );
        const updated = yield* waitForResourcePolicy(
          table.tableArn,
          "AllowSameAccountGet",
        );
        expect(updated).toContain("AllowSameAccountGet");
        expect(updated).not.toContain("AllowSameAccountDescribe");

        yield* logTestStep("removing the resource policy");
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("PolicyTable", {
              partitionKey: "id",
              attributes: { id: "S" },
            });
          }),
        );
        const removed = yield* waitForResourcePolicy(table.tableArn, undefined);
        expect(removed).toBeUndefined();

        yield* logTestStep("destroying resource policy test table");
        yield* stack.destroy();
        yield* assertTableIsDeleted(table.tableName);
      }),
    { timeout: 240_000 },
  );

  // NOTE: a live precision UPDATE on an ACTIVE destination
  // (updateKinesisStreamingDestination) is implemented in the provider but
  // not exercised here: the UPDATING→ACTIVE transition takes multiple
  // minutes (vs seconds for enable/disable), which blows the test budget.
  // The enable path below sets an explicit precision, verifying the
  // configuration plumbing out-of-band.
  test.provider(
    "enable and disable the Kinesis streaming destination",
    (stack) =>
      Effect.gen(function* () {
        yield* logTestStep("starting Kinesis streaming destination test");
        yield* stack.destroy();

        const program = (enabled: boolean) =>
          Effect.gen(function* () {
            const stream = yield* KinesisStream("CdcStream", {
              streamMode: "PROVISIONED",
              shardCount: 1,
            });
            const table = yield* Table("CdcTable", {
              partitionKey: "id",
              attributes: { id: "S" },
              kinesisStreamingDestination: enabled
                ? {
                    streamArn: stream.streamArn,
                    approximateCreationDateTimePrecision: "MICROSECOND",
                  }
                : undefined,
            });
            return { table, stream };
          });

        yield* logTestStep(
          "deploying stream + table with streaming destination",
        );
        const { table, stream } = yield* stack.deploy(program(true));

        const enabled = yield* waitForKinesisDestination(
          table.tableName,
          stream.streamArn,
          "ACTIVE",
        );
        expect(enabled?.DestinationStatus).toEqual("ACTIVE");
        expect(enabled?.ApproximateCreationDateTimePrecision).toEqual(
          "MICROSECOND",
        );

        yield* logTestStep(
          "removing the streaming destination (stream stays deployed)",
        );
        yield* stack.deploy(program(false));
        const disabled = yield* waitForKinesisDestination(
          table.tableName,
          stream.streamArn,
          "DISABLED",
        );
        expect(disabled?.DestinationStatus).toEqual("DISABLED");

        yield* logTestStep("destroying Kinesis streaming destination stack");
        yield* stack.destroy();
        yield* assertTableIsDeleted(table.tableName);
      }),
    { timeout: 360_000 },
  );

  test.provider(
    "enable and disable Contributor Insights",
    (stack) =>
      Effect.gen(function* () {
        yield* logTestStep("starting Contributor Insights test");
        yield* stack.destroy();

        yield* logTestStep("deploying table with Contributor Insights");
        const table = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("InsightsTable", {
              partitionKey: "id",
              attributes: { id: "S" },
              contributorInsightsEnabled: true,
            });
          }),
        );

        const enabled = yield* waitForContributorInsights(
          table.tableName,
          true,
        );
        expect(["ENABLING", "ENABLED"]).toContain(enabled);

        yield* logTestStep("disabling Contributor Insights");
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("InsightsTable", {
              partitionKey: "id",
              attributes: { id: "S" },
            });
          }),
        );

        const disabled = yield* waitForContributorInsights(
          table.tableName,
          false,
        );
        expect(["DISABLING", "DISABLED"]).toContain(disabled);

        yield* logTestStep("destroying Contributor Insights test table");
        yield* stack.destroy();
        yield* assertTableIsDeleted(table.tableName);
        yield* assertNoContributorInsightsRules(table.tableName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "destroying a table with Contributor Insights still enabled leaves no CloudWatch rules",
    (stack) =>
      Effect.gen(function* () {
        yield* logTestStep(
          "starting Contributor Insights destroy-while-enabled test",
        );
        yield* stack.destroy();

        yield* logTestStep("deploying table with Contributor Insights");
        const table = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("InsightsDestroyTable", {
              partitionKey: "id",
              attributes: { id: "S" },
              contributorInsightsEnabled: true,
            });
          }),
        );

        const enabled = yield* waitForContributorInsights(
          table.tableName,
          true,
        );
        expect(["ENABLING", "ENABLED"]).toContain(enabled);

        // Destroy WITHOUT disabling insights first. DynamoDB's CloudWatch
        // insight rules can only be removed by DynamoDB's own DISABLE
        // cleanup while the table exists, so the provider's delete must
        // tear insights down before deleteTable — otherwise the rules are
        // stranded forever (CloudWatch rejects direct deletion).
        yield* logTestStep("destroying table while insights are enabled");
        yield* stack.destroy();
        yield* assertTableIsDeleted(table.tableName);
        yield* assertNoContributorInsightsRules(table.tableName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "create table with folded local and global secondary indexes",
    (stack) =>
      Effect.gen(function* () {
        yield* logTestStep("starting folded index create test");
        yield* stack.destroy();

        yield* logTestStep("deploying table with LSI and GSI");
        const table = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("IndexedTable", {
              partitionKey: "pk",
              sortKey: "sk",
              attributes: {
                pk: "S",
                sk: "S",
                gsi1pk: "S",
              },
              localSecondaryIndexes: [
                {
                  IndexName: "lsi-by-sk",
                  KeySchema: [
                    { AttributeName: "pk", KeyType: "HASH" },
                    { AttributeName: "sk", KeyType: "RANGE" },
                  ],
                  Projection: {
                    ProjectionType: "ALL",
                  },
                },
              ],
              globalSecondaryIndexes: [
                {
                  IndexName: "gsi-by-lookup",
                  KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }],
                  Projection: {
                    ProjectionType: "ALL",
                  },
                },
              ],
            });
          }),
        );

        const actualTable = yield* Effect.gen(function* () {
          const current = yield* DynamoDB.describeTable({
            TableName: table.tableName,
          });
          if (
            current.Table?.GlobalSecondaryIndexes?.some(
              (index) => index.IndexStatus !== "ACTIVE",
            )
          ) {
            return yield* Effect.fail(new GlobalSecondaryIndexNotActive());
          }
          return current.Table;
        }).pipe(
          Effect.retry({
            while: (error) => error._tag === "GlobalSecondaryIndexNotActive",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(30),
            ]),
          }),
        );

        expect(
          actualTable?.LocalSecondaryIndexes?.map((index) => index.IndexName),
        ).toContain("lsi-by-sk");
        expect(
          actualTable?.GlobalSecondaryIndexes?.map((index) => index.IndexName),
        ).toContain("gsi-by-lookup");
        expect(
          table.localSecondaryIndexes?.map((index) => index.IndexName),
        ).toContain("lsi-by-sk");
        expect(
          table.globalSecondaryIndexes?.map((index) => index.IndexName),
        ).toContain("gsi-by-lookup");

        yield* logTestStep("destroying indexed table");
        yield* stack.destroy();

        yield* assertTableIsDeleted(table.tableName);
      }),
    { timeout: 180_000 },
  );

  // it's super slow because GSIs are awfully slow to create
  test.provider.skip(
    "update global secondary indexes across multiple deploys",
    (stack) =>
      Effect.gen(function* () {
        yield* logTestStep(
          "starting multi-stage global secondary index update test",
        );
        yield* stack.destroy();

        yield* logTestStep("deploying table without GSIs");
        const table = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("UpdatingIndexedTable", {
              partitionKey: "pk",
              sortKey: "sk",
              attributes: {
                pk: "S",
                sk: "S",
              },
            });
          }),
        );

        yield* expectTableIndexes(table.tableName, {
          local: [],
          global: [],
        });

        yield* logTestStep("adding first GSI");
        const oneAdded = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("UpdatingIndexedTable", {
              partitionKey: "pk",
              sortKey: "sk",
              attributes: {
                pk: "S",
                sk: "S",
                gsi1pk: "S",
              },
              globalSecondaryIndexes: [
                {
                  IndexName: "gsi-by-lookup-1",
                  KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }],
                  Projection: {
                    ProjectionType: "ALL",
                  },
                },
              ],
            });
          }),
        );
        expect(oneAdded.tableName).toEqual(table.tableName);
        yield* expectTableIndexes(oneAdded.tableName, {
          local: [],
          global: ["gsi-by-lookup-1"],
        });

        yield* logTestStep("removing first GSI");
        const oneRemoved = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("UpdatingIndexedTable", {
              partitionKey: "pk",
              sortKey: "sk",
              attributes: {
                pk: "S",
                sk: "S",
                gsi1pk: "S",
                gsi2pk: "S",
              },
            });
          }),
        );
        expect(oneRemoved.tableName).toEqual(table.tableName);
        yield* expectTableIndexes(oneRemoved.tableName, {
          local: [],
          global: [],
        });

        yield* logTestStep("adding two GSIs sequentially through one deploy");
        const twoAdded = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("UpdatingIndexedTable", {
              partitionKey: "pk",
              sortKey: "sk",
              attributes: {
                pk: "S",
                sk: "S",
                gsi1pk: "S",
                gsi2pk: "S",
              },
              globalSecondaryIndexes: [
                {
                  IndexName: "gsi-by-lookup-1",
                  KeySchema: [{ AttributeName: "gsi1pk", KeyType: "HASH" }],
                  Projection: {
                    ProjectionType: "ALL",
                  },
                },
                {
                  IndexName: "gsi-by-lookup-2",
                  KeySchema: [{ AttributeName: "gsi2pk", KeyType: "HASH" }],
                  Projection: {
                    ProjectionType: "ALL",
                  },
                },
              ],
            });
          }),
        );
        expect(twoAdded.tableName).toEqual(table.tableName);
        yield* expectTableIndexes(twoAdded.tableName, {
          local: [],
          global: ["gsi-by-lookup-1", "gsi-by-lookup-2"],
        });

        yield* logTestStep("removing one of two GSIs");
        const oneOfTwoRemoved = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("UpdatingIndexedTable", {
              partitionKey: "pk",
              sortKey: "sk",
              attributes: {
                pk: "S",
                sk: "S",
                gsi1pk: "S",
                gsi2pk: "S",
              },
              globalSecondaryIndexes: [
                {
                  IndexName: "gsi-by-lookup-2",
                  KeySchema: [{ AttributeName: "gsi2pk", KeyType: "HASH" }],
                  Projection: {
                    ProjectionType: "ALL",
                  },
                },
              ],
            });
          }),
        );
        expect(oneOfTwoRemoved.tableName).toEqual(table.tableName);
        yield* expectTableIndexes(oneOfTwoRemoved.tableName, {
          local: [],
          global: ["gsi-by-lookup-2"],
        });

        yield* logTestStep("removing remaining GSI");
        const twoRemoved = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("UpdatingIndexedTable", {
              partitionKey: "pk",
              sortKey: "sk",
              attributes: {
                pk: "S",
                sk: "S",
                gsi1pk: "S",
                gsi2pk: "S",
              },
            });
          }),
        );
        expect(twoRemoved.tableName).toEqual(table.tableName);
        yield* expectTableIndexes(twoRemoved.tableName, {
          local: [],
          global: [],
        });

        yield* logTestStep("destroying GSI update test table");
        yield* stack.destroy();

        yield* assertTableIsDeleted(table.tableName);
      }),
    { timeout: 2_400_000 },
  );

  test.provider(
    "changing local secondary indexes replaces the table",
    (stack) =>
      Effect.gen(function* () {
        yield* logTestStep("starting local secondary index replacement test");
        yield* stack.destroy();

        yield* logTestStep("deploying baseline table without LSIs");
        const original = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("ReplacingIndexedTable", {
              partitionKey: "pk",
              sortKey: "sk",
              attributes: {
                pk: "S",
                sk: "S",
              },
            });
          }),
        );

        yield* expectTableIndexes(original.tableName, {
          local: [],
          global: [],
        });

        yield* logTestStep("deploying replacement with LSI");
        const withLsi = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("ReplacingIndexedTable", {
              partitionKey: "pk",
              sortKey: "sk",
              attributes: {
                pk: "S",
                sk: "S",
              },
              localSecondaryIndexes: [
                {
                  IndexName: "lsi-by-sk",
                  KeySchema: [
                    { AttributeName: "pk", KeyType: "HASH" },
                    { AttributeName: "sk", KeyType: "RANGE" },
                  ],
                  Projection: {
                    ProjectionType: "ALL",
                  },
                },
              ],
            });
          }),
        );

        expect(withLsi.tableName).not.toEqual(original.tableName);
        yield* assertTableIsDeleted(original.tableName);
        yield* expectTableIndexes(withLsi.tableName, {
          local: ["lsi-by-sk"],
          global: [],
        });

        yield* logTestStep("deploying replacement without LSI again");
        const withoutLsiAgain = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("ReplacingIndexedTable", {
              partitionKey: "pk",
              sortKey: "sk",
              attributes: {
                pk: "S",
                sk: "S",
              },
            });
          }),
        );

        expect(withoutLsiAgain.tableName).not.toEqual(withLsi.tableName);
        yield* assertTableIsDeleted(withLsi.tableName);
        yield* expectTableIndexes(withoutLsiAgain.tableName, {
          local: [],
          global: [],
        });

        yield* logTestStep("destroying replacement test table");
        yield* stack.destroy();

        yield* assertTableIsDeleted(withoutLsiAgain.tableName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "changing the key schema replaces the table under a new physical name",
    (stack) =>
      Effect.gen(function* () {
        yield* logTestStep("starting key schema replacement test");
        yield* stack.destroy();

        yield* logTestStep("deploying baseline table (partitionKey=id)");
        const original = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("KeySchemaTable", {
              partitionKey: "id",
              attributes: { id: "S" },
            });
          }),
        );

        yield* logTestStep("deploying replacement (partitionKey=pk)");
        const replaced = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("KeySchemaTable", {
              partitionKey: "pk",
              attributes: { pk: "S" },
            });
          }),
        );

        // Replacement mints a new instance id, so the engine-generated
        // physical name changes: the successor is created under a fresh name
        // (create-before-delete) and the old table is deleted afterwards.
        expect(replaced.tableName).not.toEqual(original.tableName);
        expect(replaced.partitionKey).toEqual("pk");
        yield* assertTableIsDeleted(original.tableName);

        const successor = yield* DynamoDB.describeTable({
          TableName: replaced.tableName,
        });
        expect(successor.Table?.KeySchema).toEqual([
          { AttributeName: "pk", KeyType: "HASH" },
        ]);

        yield* logTestStep("destroying key schema replacement test table");
        yield* stack.destroy();

        yield* assertTableIsDeleted(replaced.tableName);
      }),
    { timeout: 240_000 },
  );

  test.provider(
    "hard-coded table name is replaced in place (delete before create)",
    (stack) =>
      Effect.gen(function* () {
        yield* logTestStep("starting pinned-name replacement test");
        yield* stack.destroy();

        // Deterministic physical name — identical on every run of this case.
        const tableName = "alchemy-test-ddb-pinned-replace";

        yield* logTestStep("deploying pinned-name table without sort key");
        const original = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("PinnedNameTable", {
              tableName,
              partitionKey: "id",
              attributes: { id: "S" },
            });
          }),
        );
        expect(original.tableName).toEqual(tableName);
        expect(original.sortKey).toBeUndefined();

        yield* logTestStep("deploying replacement with a sort key");
        const replaced = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Table("PinnedNameTable", {
              tableName,
              partitionKey: "id",
              sortKey: "sk",
              attributes: { id: "S", sk: "S" },
            });
          }),
        );

        // The pinned name cannot change, so the engine must delete the old
        // generation first and recreate under the same name: same physical
        // name, new physical table (fresh TableId), new key schema.
        expect(replaced.tableName).toEqual(tableName);
        expect(replaced.tableId).not.toEqual(original.tableId);
        expect(replaced.sortKey).toEqual("sk");

        const successor = yield* DynamoDB.describeTable({
          TableName: tableName,
        });
        expect(successor.Table?.TableId).toEqual(replaced.tableId);
        expect(successor.Table?.KeySchema).toEqual([
          { AttributeName: "id", KeyType: "HASH" },
          { AttributeName: "sk", KeyType: "RANGE" },
        ]);

        yield* logTestStep("destroying pinned-name replacement test table");
        yield* stack.destroy();

        yield* assertTableIsDeleted(tableName);
      }),
    { timeout: 240_000 },
  );

  // Engine-level adoption: a table tagged with this stack/stage/id is
  // silently adopted on a fresh state store; a table tagged with a
  // different logical id is rejected unless `adopt(true)` is supplied.
  // Longer timeouts because DynamoDB table create/delete each take ~30s.
  test.provider(
    "owned table (matching alchemy tags) is silently adopted without --adopt",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Deterministic name: a re-run reclaims any orphan left by a
        // previously interrupted run instead of stranding a new random table.
        const tableName = "alchemy-test-ddb-adopt";

        // Pre-clean: the state wipe below hides this table from the scratch
        // stack's automatic teardown, so reclaim any leftover up front.
        yield* reclaimOutOfBandTable(tableName);

        yield* Effect.gen(function* () {
          // Phase 1: deploy normally; alchemy stamps internal tags.
          const initial = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Table("AdoptableTable", {
                tableName,
                partitionKey: "id",
                attributes: { id: "S" },
              });
            }),
          );
          expect(initial.tableName).toEqual(tableName);

          // Phase 2: wipe local state — the table stays in DynamoDB.
          yield* Effect.gen(function* () {
            const state = yield* yield* State;
            yield* state.delete({
              stack: stack.name,
              stage: "test",
              fqn: "AdoptableTable",
            });
          }).pipe(Effect.provide(stack.state));

          // Phase 3: redeploy without `adopt(true)`. Read sees alchemy tags
          // matching this stack/stage/id and returns plain attrs — silent
          // adoption.
          const adopted = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Table("AdoptableTable", {
                tableName,
                partitionKey: "id",
                attributes: { id: "S" },
              });
            }),
          );

          expect(adopted.tableArn).toEqual(initial.tableArn);

          yield* stack.destroy();
          yield* assertTableIsDeleted(tableName);
        }).pipe(
          // After the state wipe the table is out-of-band: guarantee the
          // idempotent delete on success, failure, and interruption.
          Effect.ensuring(reclaimOutOfBandTable(tableName).pipe(Effect.orDie)),
        );
      }),
    { timeout: 360_000 },
  );

  test.provider(
    "foreign-tagged table requires adopt(true) to take over",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        // Deterministic name: a re-run reclaims any orphan left by a
        // previously interrupted run instead of stranding a new random table.
        const tableName = "alchemy-test-ddb-takeover";

        // Pre-clean: the state wipe below hides this table from the scratch
        // stack's automatic teardown, so reclaim any leftover up front.
        yield* reclaimOutOfBandTable(tableName);

        yield* Effect.gen(function* () {
          // Phase 1: deploy under "Original" — table tagged
          // alchemy::id=Original.
          const original = yield* stack.deploy(
            Effect.gen(function* () {
              return yield* Table("Original", {
                tableName,
                partitionKey: "id",
                attributes: { id: "S" },
              });
            }),
          );
          expect(original.tableName).toEqual(tableName);

          // Wipe state for "Original"; table stays in DynamoDB.
          yield* Effect.gen(function* () {
            const state = yield* yield* State;
            yield* state.delete({
              stack: stack.name,
              stage: "test",
              fqn: "Original",
            });
          }).pipe(Effect.provide(stack.state));

          // Phase 2: redeploy under "Different" with `adopt(true)`. Read
          // returns Unowned(attrs) because the table's tags identify a
          // different logical id; with adopt enabled the engine takes over
          // and the update rewrites tags.
          const takenOver = yield* stack
            .deploy(
              Effect.gen(function* () {
                return yield* Table("Different", {
                  tableName,
                  partitionKey: "id",
                  attributes: { id: "S" },
                });
              }),
            )
            .pipe(adopt(true));

          expect(takenOver.tableName).toEqual(tableName);

          // After the update the tags should now identify this stack/stage/id.
          // The takeover update reads tags back from the cloud after writing,
          // so `takenOver.tags` already reflects the rewritten tag set.
          expect(takenOver.tags?.["alchemy::id"]).toEqual("Different");

          yield* stack.destroy();
          yield* assertTableIsDeleted(tableName);
        }).pipe(
          // After the state wipe the table is out-of-band: guarantee the
          // idempotent delete on success, failure, and interruption.
          Effect.ensuring(reclaimOutOfBandTable(tableName).pipe(Effect.orDie)),
        );
      }),
    { timeout: 360_000 },
  );

  // Regression test for https://github.com/alchemy-run/alchemy/issues/736.
  //
  // An interrupted first deploy persists the table as `status: "creating"`
  // with no attributes — and Output-valued props do not survive the state
  // round-trip: they deserialize as `undefined`. Plan's recovery branch first
  // calls `provider.read` with those junk olds; if read misses, it then calls
  // `provider.diff` against the same junk olds, which crashed in
  // `Object.entries(olds.attributes)` when `attributes` was lost.
  //
  // Simulate exactly that state row after a real deploy, then delete the
  // table out-of-band so `read` cannot recover it by name (a live table would
  // be recovered and `diff` would never run against the junk olds), and
  // assert the next deploy falls through diff and recreates the table.
  test.provider(
    "recovers a creating-state row that lost its attributes prop (#736)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const deployTable = () =>
          stack.deploy(
            Effect.gen(function* () {
              return yield* Table("WedgedTable", {
                partitionKey: "id",
                attributes: { id: "S" },
              });
            }),
          );

        const created = yield* deployTable();

        // Rewrite the table's persisted row into the wedged shape an
        // interrupted deploy leaves behind: `creating`, no attributes, and
        // the `attributes` prop lost in the state round-trip.
        const state = yield* yield* State;
        const stage = "test"; // scratch stacks default to the "test" stage
        const fqns = yield* state.list({ stack: stack.name, stage });
        const rows = yield* Effect.forEach(fqns, (fqn) =>
          state
            .get({ stack: stack.name, stage, fqn })
            .pipe(Effect.map((row) => ({ fqn, row }))),
        );
        const wedged = rows.find(
          (r): r is { fqn: string; row: ResourceState } =>
            isResourceState(r.row) &&
            r.row.resourceType === "AWS.DynamoDB.Table",
        );
        if (!wedged) {
          return yield* Effect.die(
            new Error("no AWS.DynamoDB.Table state row found after deploy"),
          );
        }
        yield* state.set({
          stack: stack.name,
          stage,
          fqn: wedged.fqn,
          value: {
            ...wedged.row,
            status: "creating",
            attr: undefined,
            props: {
              ...wedged.row.props,
              attributes: undefined,
            },
          },
        });

        // Delete the table out-of-band so the recovery `read` misses.
        yield* logTestStep(
          `deleting ${created.tableName} out-of-band to force a read miss`,
        );
        yield* DynamoDB.deleteTable({ TableName: created.tableName }).pipe(
          Effect.retry({
            while: (e) => e._tag === "ResourceInUseException",
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(10),
            ]),
          }),
          Effect.catchTag("ResourceNotFoundException", () => Effect.void),
        );
        yield* assertTableIsDeleted(created.tableName);

        // Before the fix this crashed in plan's diff with
        // `TypeError: undefined is not an object (evaluating 'olds.attributes')`.
        const recovered = yield* deployTable();
        expect(recovered.tableName).toEqual(created.tableName);

        const actual = yield* DynamoDB.describeTable({
          TableName: recovered.tableName,
        });
        expect(actual.Table?.TableArn).toEqual(recovered.tableArn);

        yield* stack.destroy();
        yield* assertTableIsDeleted(recovered.tableName);
      }),
    { timeout: 240_000 },
  );

  // Idempotent out-of-band cleanup for the adoption tests, whose state wipe
  // hides the table from the scratch stack's automatic teardown. Safe when
  // the table never existed (not-found is swallowed), is mid create/update
  // (bounded retry on ResourceInUseException), or was already deleted by
  // `stack.destroy()`.
  const reclaimOutOfBandTable = Effect.fn(function* (tableName: string) {
    yield* logTestStep(`reclaiming out-of-band table ${tableName}`);
    yield* DynamoDB.deleteTable({ TableName: tableName }).pipe(
      Effect.retry({
        while: (e) => e._tag === "ResourceInUseException",
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(8),
        ]),
      }),
      Effect.flatMap(() => assertTableIsDeleted(tableName)),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    );
  });

  const assertTableIsDeleted = Effect.fn(function* (tableName: string) {
    yield* Effect.logInfo(
      `DynamoDB Table test: waiting for deletion of ${tableName}`,
    );
    yield* DynamoDB.describeTable({
      TableName: tableName,
    }).pipe(
      Effect.flatMap(() => Effect.fail(new TableStillExists())),
      Effect.retry({
        while: (e) => e._tag === "TableStillExists",
        schedule: Schedule.max([
          Schedule.fixed("1 second"),
          Schedule.recurs(30),
        ]),
      }),
      Effect.catchTag("ResourceNotFoundException", () => Effect.void),
    );
    yield* Effect.logInfo(
      `DynamoDB Table test: confirmed deleted ${tableName}`,
    );
  });

  const waitForTableTags = Effect.fn(function* (
    tableArn: string,
    expected: Record<string, string>,
  ) {
    yield* Effect.logInfo(
      `DynamoDB Table test: waiting for tags on ${tableArn} -> ${JSON.stringify(expected)}`,
    );
    return yield* DynamoDB.listTagsOfResource({
      ResourceArn: tableArn,
    }).pipe(
      Effect.flatMap((result) => {
        const tags = Object.fromEntries(
          (result.Tags ?? []).map((tag) => [tag.Key!, tag.Value!]),
        ) as Record<string, string>;
        const matches = Object.entries(expected).every(
          ([key, value]) => tags[key] === value,
        );
        if (!matches) {
          return Effect.logInfo(
            `DynamoDB Table test: tags not ready on ${tableArn}. expected=${JSON.stringify(expected)} actual=${JSON.stringify(tags)}`,
          ).pipe(Effect.andThen(Effect.fail(new TableTagsNotUpdated())));
        }
        return Effect.logInfo(
          `DynamoDB Table test: tags ready on ${tableArn} -> ${JSON.stringify(tags)}`,
        ).pipe(Effect.andThen(Effect.succeed(tags)));
      }),
      Effect.retry({
        while: (error) => error._tag === "TableTagsNotUpdated",
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(15),
        ]),
      }),
    );
  });

  const waitForPointInTimeRecovery = Effect.fn(function* (
    tableName: string,
    enabled: boolean,
  ) {
    yield* Effect.logInfo(
      `DynamoDB Table test: waiting for PITR on ${tableName} -> ${enabled ? "ENABLED" : "DISABLED"}`,
    );
    return yield* DynamoDB.describeContinuousBackups({
      TableName: tableName,
    }).pipe(
      Effect.flatMap((result) => {
        const status =
          result.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
            ?.PointInTimeRecoveryStatus;
        if (
          (enabled && status !== "ENABLED") ||
          (!enabled && status !== "DISABLED")
        ) {
          return Effect.logInfo(
            `DynamoDB Table test: PITR not ready on ${tableName}. current=${status ?? "undefined"}`,
          ).pipe(
            Effect.andThen(Effect.fail(new PointInTimeRecoveryNotUpdated())),
          );
        }
        if (!result.ContinuousBackupsDescription) {
          return Effect.fail(new PointInTimeRecoveryNotUpdated());
        }
        return Effect.logInfo(
          `DynamoDB Table test: PITR ready on ${tableName} -> ${status}`,
        ).pipe(
          Effect.andThen(Effect.succeed(result.ContinuousBackupsDescription)),
        );
      }),
      Effect.retry({
        while: (error) => error._tag === "PointInTimeRecoveryNotUpdated",
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(15),
        ]),
      }),
    );
  });

  const waitForTableStreamSpecification = Effect.fn(function* (
    tableName: string,
    expected: DynamoDB.StreamSpecification | undefined,
  ) {
    yield* Effect.logInfo(
      `DynamoDB Table test: waiting for stream configuration on ${tableName} -> ${JSON.stringify(expected)}`,
    );
    return yield* DynamoDB.describeTable({
      TableName: tableName,
    }).pipe(
      Effect.flatMap((result) => {
        const actual = result.Table?.StreamSpecification;
        const matches =
          JSON.stringify(actual ?? undefined) === JSON.stringify(expected);
        if (!matches) {
          return Effect.logInfo(
            `DynamoDB Table test: stream configuration not ready on ${tableName}. actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`,
          ).pipe(Effect.andThen(Effect.fail(new StreamSpecNotUpdated())));
        }
        return Effect.logInfo(
          `DynamoDB Table test: stream configuration ready on ${tableName} -> ${JSON.stringify(actual)}`,
        ).pipe(Effect.andThen(Effect.succeed(result)));
      }),
      Effect.retry({
        while: (error) => error._tag === "StreamSpecNotUpdated",
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(20),
        ]),
      }),
    );
  });

  const expectTableIndexes = Effect.fn(function* (
    tableName: string,
    expected: {
      local: string[];
      global: string[];
    },
  ) {
    const expectedLocal = [...expected.local].sort();
    const expectedGlobal = [...expected.global].sort();
    yield* Effect.logInfo(
      `DynamoDB Table test: waiting for indexes on ${tableName}. expectedLocal=${JSON.stringify(expectedLocal)} expectedGlobal=${JSON.stringify(expectedGlobal)}`,
    );

    return yield* DynamoDB.describeTable({
      TableName: tableName,
    }).pipe(
      Effect.flatMap((result) => {
        const table = result.Table;
        const actualLocal = [...(table?.LocalSecondaryIndexes ?? [])]
          .map((index) => index.IndexName!)
          .sort();
        const actualGlobal = [...(table?.GlobalSecondaryIndexes ?? [])]
          .map((index) => index.IndexName!)
          .sort();
        const allGlobalActive = (table?.GlobalSecondaryIndexes ?? []).every(
          (index) => index.IndexStatus === "ACTIVE",
        );

        if (
          JSON.stringify(actualLocal) !== JSON.stringify(expectedLocal) ||
          JSON.stringify(actualGlobal) !== JSON.stringify(expectedGlobal) ||
          !allGlobalActive
        ) {
          return Effect.logInfo(
            `DynamoDB Table test: indexes not ready on ${tableName}. tableStatus=${table?.TableStatus ?? "undefined"} actualLocal=${JSON.stringify(actualLocal)} actualGlobal=${JSON.stringify(actualGlobal)} globalStatuses=${JSON.stringify((table?.GlobalSecondaryIndexes ?? []).map((index) => ({ name: index.IndexName, status: index.IndexStatus })))}`,
          ).pipe(Effect.andThen(Effect.fail(new TableIndexesNotUpdated())));
        }

        return Effect.logInfo(
          `DynamoDB Table test: indexes ready on ${tableName}. actualLocal=${JSON.stringify(actualLocal)} actualGlobal=${JSON.stringify(actualGlobal)}`,
        ).pipe(Effect.andThen(Effect.succeed(table)));
      }),
      Effect.retry({
        while: (error) => error._tag === "TableIndexesNotUpdated",
        schedule: longGlobalSecondaryIndexStabilization,
      }),
    );
  });

  const waitForResourcePolicy = Effect.fn(function* (
    tableArn: string,
    expectedSid: string | undefined,
  ) {
    yield* Effect.logInfo(
      `DynamoDB Table test: waiting for resource policy on ${tableArn} -> ${expectedSid ?? "absent"}`,
    );
    return yield* DynamoDB.getResourcePolicy({
      ResourceArn: tableArn,
    }).pipe(
      Effect.map((result) => result.Policy),
      Effect.catchTag("PolicyNotFoundException", () =>
        Effect.succeed(undefined),
      ),
      Effect.flatMap((policy) => {
        const matches =
          expectedSid === undefined
            ? policy === undefined
            : policy?.includes(expectedSid) === true;
        if (!matches) {
          return Effect.logInfo(
            `DynamoDB Table test: resource policy not ready on ${tableArn}. actual=${policy ?? "absent"}`,
          ).pipe(Effect.andThen(Effect.fail(new ResourcePolicyNotUpdated())));
        }
        return Effect.succeed(policy);
      }),
      Effect.retry({
        while: (error) => error._tag === "ResourcePolicyNotUpdated",
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(15),
        ]),
      }),
    );
  });

  const waitForKinesisDestination = Effect.fn(function* (
    tableName: string,
    streamArn: string,
    expectedStatus: "ACTIVE" | "DISABLED",
  ) {
    yield* Effect.logInfo(
      `DynamoDB Table test: waiting for Kinesis destination ${streamArn} on ${tableName} -> ${expectedStatus}`,
    );
    return yield* DynamoDB.describeKinesisStreamingDestination({
      TableName: tableName,
    }).pipe(
      Effect.flatMap((result) => {
        const destination = (result.KinesisDataStreamDestinations ?? []).find(
          (candidate) => candidate.StreamArn === streamArn,
        );
        if (destination?.DestinationStatus !== expectedStatus) {
          return Effect.logInfo(
            `DynamoDB Table test: Kinesis destination not ready on ${tableName}. actual=${destination?.DestinationStatus ?? "absent"} expected=${expectedStatus}`,
          ).pipe(
            Effect.andThen(Effect.fail(new KinesisDestinationNotUpdated())),
          );
        }
        return Effect.succeed(destination);
      }),
      Effect.retry({
        while: (error) => error._tag === "KinesisDestinationNotUpdated",
        schedule: Schedule.max([
          Schedule.fixed("5 seconds"),
          Schedule.recurs(18),
        ]),
      }),
    );
  });

  const waitForContributorInsights = Effect.fn(function* (
    tableName: string,
    enabled: boolean,
  ) {
    yield* Effect.logInfo(
      `DynamoDB Table test: waiting for Contributor Insights on ${tableName} -> ${enabled ? "enabled" : "disabled"}`,
    );
    return yield* DynamoDB.describeContributorInsights({
      TableName: tableName,
    }).pipe(
      Effect.flatMap((result) => {
        const status = result.ContributorInsightsStatus;
        const isEnabled = status === "ENABLED" || status === "ENABLING";
        if (isEnabled !== enabled) {
          return Effect.logInfo(
            `DynamoDB Table test: Contributor Insights not ready on ${tableName}. actual=${status ?? "undefined"}`,
          ).pipe(
            Effect.andThen(Effect.fail(new ContributorInsightsNotUpdated())),
          );
        }
        return Effect.succeed(status);
      }),
      Effect.retry({
        while: (error) => error._tag === "ContributorInsightsNotUpdated",
        schedule: Schedule.max([
          Schedule.fixed("2 seconds"),
          Schedule.recurs(15),
        ]),
      }),
    );
  });

  // Out-of-band proof that DynamoDB's Contributor Insights cleanup ran:
  // no `DynamoDBContributorInsights-*-<tableName>-*` CloudWatch rules may
  // survive the destroy — stranded rules can only be removed by AWS support.
  const assertNoContributorInsightsRules = Effect.fn(function* (
    tableName: string,
  ) {
    const rules = yield* CloudWatch.describeInsightRules({});
    const leftover = (rules.InsightRules ?? [])
      .map((rule) => rule.Name)
      .filter(
        (name): name is string =>
          name !== undefined && name.includes(`-${tableName}-`),
      );
    expect(leftover).toEqual([]);
  });

  const logTestStep = (message: string) =>
    Effect.logInfo(`DynamoDB Table test: ${message}`);

  class TableStillExists extends Data.TaggedError("TableStillExists") {}

  class StreamSpecNotUpdated extends Data.TaggedError("StreamSpecNotUpdated") {}

  class TableTagsNotUpdated extends Data.TaggedError("TableTagsNotUpdated") {}

  class PointInTimeRecoveryNotUpdated extends Data.TaggedError(
    "PointInTimeRecoveryNotUpdated",
  ) {}

  class GlobalSecondaryIndexNotActive extends Data.TaggedError(
    "GlobalSecondaryIndexNotActive",
  ) {}

  class TableIndexesNotUpdated extends Data.TaggedError(
    "TableIndexesNotUpdated",
  ) {}

  class ResourcePolicyNotUpdated extends Data.TaggedError(
    "ResourcePolicyNotUpdated",
  ) {}

  class KinesisDestinationNotUpdated extends Data.TaggedError(
    "KinesisDestinationNotUpdated",
  ) {}

  class ContributorInsightsNotUpdated extends Data.TaggedError(
    "ContributorInsightsNotUpdated",
  ) {}
});
