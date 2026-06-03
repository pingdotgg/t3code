import { adopt } from "@/AdoptPolicy";
import * as AWS from "@/AWS";
import { Table } from "@/AWS/DynamoDB";
import { State } from "@/State";
import * as Test from "@/Test/Vitest";
import * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import { describe, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

describe("AWS.DynamoDB.Table", () => {
  const longGlobalSecondaryIndexStabilization = Schedule.fixed(
    "10 seconds",
  ).pipe(Schedule.both(Schedule.recurs(180)));

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
                PointInTimeRecoveryEnabled: true,
                RecoveryPeriodInDays: 7,
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
                PointInTimeRecoveryEnabled: false,
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
            schedule: Schedule.fixed("2 seconds").pipe(
              Schedule.both(Schedule.recurs(30)),
            ),
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

  // Engine-level adoption: a table tagged with this stack/stage/id is
  // silently adopted on a fresh state store; a table tagged with a
  // different logical id is rejected unless `adopt(true)` is supplied.
  // Longer timeouts because DynamoDB table create/delete each take ~30s.
  test.provider(
    "owned table (matching alchemy tags) is silently adopted without --adopt",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const tableName = `alchemy-test-ddb-adopt-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

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
      }),
    { timeout: 360_000 },
  );

  test.provider(
    "foreign-tagged table requires adopt(true) to take over",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();

        const tableName = `alchemy-test-ddb-takeover-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

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
      }),
    { timeout: 360_000 },
  );

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
        schedule: Schedule.fixed("1 second").pipe(
          Schedule.both(Schedule.recurs(30)),
        ),
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
        schedule: Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(15)),
        ),
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
        schedule: Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(15)),
        ),
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
        schedule: Schedule.fixed("2 seconds").pipe(
          Schedule.both(Schedule.recurs(20)),
        ),
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
});
