import { createHash } from "node:crypto";
import * as AWS from "@alchemy.run/aws";
import { makeDynamoDBState, makeS3State } from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { createOverflowBucketName } from "@alchemy.run/aws/StateStore/DynamoDBState";
import { openLegacyBucket } from "@alchemy.run/aws/StateStore/LegacyLayout";
import { migrateToDynamoDB, rollbackToS3 } from "@alchemy.run/aws/StateStore/Migration";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import type { Credentials } from "@distilled.cloud/aws/Credentials";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as s3 from "@distilled.cloud/aws/s3";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import { StateStoreError, type ResourceState } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";

const { test, deploy, destroy } = Test.make({ providers: AWS.providers() });

const STACK = "StateMigrationTestStack";

const tags = [
  "provider:aws",
  "provider:aws:dynamodb",
  "provider:aws:s3",
  "provider:aws:statestore",
  "live",
];

/** A DynamoDB store's table and overflow bucket, and an S3 store's bucket. */
const Storage = Effect.gen(function* () {
  const table = yield* AWS.DynamoDB.Table("MigrationTable", {
    partitionKey: "PK",
    sortKey: "SK",
    attributes: { PK: "S", SK: "S" },
  });
  const overflow = yield* AWS.S3.Bucket("MigrationOverflow", { forceDestroy: true });
  const legacy = yield* AWS.S3.Bucket("MigrationLegacy", { forceDestroy: true });
  return {
    tableName: table.tableName,
    overflowBucketName: overflow.bucketName,
    legacyBucketName: legacy.bucketName,
  };
});

interface Storage {
  readonly tableName: string;
  readonly overflowBucketName: string;
  readonly legacyBucketName: string;
}

const PREFIX = "legacy";

const stores = (storage: Storage) => ({
  /** The S3 store, as an older alchemy runs it. */
  s3: makeS3State({ bucketName: storage.legacyBucketName, prefix: PREFIX }),
  dynamodb: makeDynamoDBState({
    tableName: storage.tableName,
    overflowBucketName: storage.overflowBucketName,
    migrateFrom: { bucketName: storage.legacyBucketName, prefix: PREFIX },
  }),
});

const resource = (fqn: string, attr: Record<string, unknown>): ResourceState =>
  ({
    resourceType: "test:resource",
    namespace: undefined,
    fqn,
    logicalId: fqn,
    instanceId: `instance-${fqn}`,
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: {},
    attr,
  }) as ResourceState;

const a = resource("Parent/ResourceA", { value: "a" });
const b = resource("ResourceB", { value: "b" });
const output = { url: "https://example.com" };

/** Deploy-like writes through the S3 store, released when done. */
const seedS3 = (storage: Storage, stage: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const state = yield* stores(storage).s3;
      yield* state.set({ stack: STACK, stage, fqn: a.fqn, value: a });
      yield* state.set({ stack: STACK, stage, fqn: b.fqn, value: b });
      yield* state.setOutput({ stack: STACK, stage, value: output });
    }),
  );

/** Lift the bucket policy a migration writes, so the stack can empty and delete the bucket. */
const release = (storage: Storage) =>
  openLegacyBucket(storage.legacyBucketName).pipe(Effect.ignore);

const migrate = (storage: Storage, options?: Parameters<typeof migrateToDynamoDB>[1]) =>
  Effect.scoped(
    Effect.flatMap(stores(storage).dynamodb, (state) => migrateToDynamoDB(state, options)),
  );

const rollback = (storage: Storage, options?: Parameters<typeof rollbackToS3>[1]) =>
  Effect.scoped(Effect.flatMap(stores(storage).dynamodb, (state) => rollbackToS3(state, options)));

const migrateCommand = (stage: string) => `alchemy state migrate --stack ${STACK} --stage ${stage}`;

/**
 * A moved stage, as a version of alchemy from before the S3 store took a
 * lease would see it: the bucket policy denies every access to its
 * objects. Writes and deletes are denied from the fence on, so they are
 * refused at once; the read deny is a later policy update, which S3 can
 * take minutes to enforce everywhere, so it is checked in the policy.
 */
const deniedRawAccess = (storage: Storage, stage: string) =>
  Effect.gen(function* () {
    const Bucket = storage.legacyBucketName;
    const Key = `${PREFIX}/${STACK}/${stage}/${b.fqn}.json`;
    const policy = JSON.parse((yield* s3.getBucketPolicy({ Bucket })).Policy ?? "{}") as {
      Statement?: Array<{
        Sid?: string;
        Effect?: string;
        Action?: string[];
        Resource?: string | string[];
      }>;
    };
    const migrated = (policy.Statement ?? []).find(
      (statement) => statement.Sid === "AlchemyStateMigrated",
    );
    expect(migrated?.Effect).toBe("Deny");
    expect(migrated?.Action).toEqual(["s3:GetObject", "s3:PutObject", "s3:DeleteObject"]);
    expect([migrated?.Resource].flat()).toContain(
      `arn:aws:s3:::${Bucket}/${PREFIX}/${STACK}/${stage}/*`,
    );
    const denied = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.flip, Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 15 }));
    yield* denied(s3.putObject({ Bucket, Key, Body: "{}" }));
    yield* denied(s3.deleteObject({ Bucket, Key }));
  });

const legacyKeys = (storage: Storage, stage: string) =>
  s3
    .listObjectsV2({ Bucket: storage.legacyBucketName, Prefix: `${PREFIX}/${STACK}/${stage}/` })
    .pipe(Effect.map((result) => (result.Contents ?? []).map((object) => object.Key).sort()));

test.provider(
  "a stage still in S3 is refused until it is migrated, then served from DynamoDB",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const stage = "refuse-then-migrate";
      yield* Effect.gen(function* () {
        yield* seedS3(storage, stage);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* stores(storage).dynamodb;
            const refused = yield* state.get({ stack: STACK, stage, fqn: a.fqn }).pipe(Effect.flip);
            expect(refused).toBeInstanceOf(StateStoreError);
            expect(refused.requires?.command).toBe(migrateCommand(stage));
            // Reads that take no lease still see the S3 copy.
            expect(yield* state.getOutput({ stack: STACK, stage })).toEqual(output);
            expect(yield* state.listStages(STACK)).toContain(stage);
          }),
        );

        expect(yield* migrate(storage)).toEqual([
          { stack: STACK, stage, status: "migrated", records: 2 },
        ]);

        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* stores(storage).dynamodb;
            expect(yield* state.get({ stack: STACK, stage, fqn: a.fqn })).toEqual(a);
            expect([...(yield* state.list({ stack: STACK, stage }))].sort()).toEqual([
              "Parent/ResourceA",
              "ResourceB",
            ]);
            expect(yield* state.getOutput({ stack: STACK, stage })).toEqual(output);
          }),
        );

        // The S3 copy is kept, and closed to every older version: the
        // lease-taking ones and the ones from before the lease.
        expect(yield* legacyKeys(storage, stage)).toHaveLength(4);
        yield* deniedRawAccess(storage, stage);
        const older = yield* Effect.scoped(
          Effect.flatMap(stores(storage).s3, (state) =>
            state.set({ stack: STACK, stage, fqn: a.fqn, value: a }),
          ),
        ).pipe(Effect.flip);
        expect(older).toBeInstanceOf(StateStoreError);

        // Running it again finds nothing left to move.
        expect(yield* migrate(storage)).toEqual([
          { stack: STACK, stage, status: "already-migrated" },
        ]);
      }).pipe(Effect.ensuring(release(storage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a migration that stops after fencing or before committing finishes on the next run",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const stage = "interrupted";
      yield* Effect.gen(function* () {
        yield* seedS3(storage, stage);

        for (const failAt of ["fenced", "copied"] as const) {
          const interrupted = yield* migrate(storage, {
            afterStep: (step) =>
              step === failAt
                ? Effect.fail(new StateStoreError({ message: `stopped after ${step}` }))
                : Effect.void,
          });
          expect(interrupted).toEqual([
            { stack: STACK, stage, status: "failed", reason: `stopped after ${failAt}` },
          ]);

          // Not committed: the stage is still refused, and still fenced in S3.
          const refused = yield* Effect.scoped(
            Effect.flatMap(stores(storage).dynamodb, (state) =>
              state.get({ stack: STACK, stage, fqn: a.fqn }),
            ),
          ).pipe(Effect.flip);
          expect(refused.requires?.command).toBe(migrateCommand(stage));
          // The S3 store fails at the lock, or at the bucket policy's
          // write deny once it applies.
          const fenced = yield* Effect.scoped(
            Effect.flatMap(stores(storage).s3, (state) => state.list({ stack: STACK, stage })),
          ).pipe(Effect.flip);
          expect(fenced.message).toMatch(/moved to a DynamoDB state store|explicit deny/);
        }

        expect(yield* migrate(storage)).toEqual([
          { stack: STACK, stage, status: "migrated", records: 2 },
        ]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* stores(storage).dynamodb;
            expect(yield* state.get({ stack: STACK, stage, fqn: b.fqn })).toEqual(b);
          }),
        );
      }).pipe(Effect.ensuring(release(storage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "while a stage is copied, writes to its S3 objects are denied and reads are not",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const stage = "copy-window";
      const Key = `${PREFIX}/${STACK}/${stage}/${b.fqn}.json`;
      const Bucket = storage.legacyBucketName;
      yield* Effect.gen(function* () {
        yield* seedS3(storage, stage);
        const checked = { done: false };
        // The hook runs inside the migration, which provides no AWS context of its own.
        const aws = yield* Effect.context<Credentials | HttpClient.HttpClient>();
        const result = yield* migrate(storage, {
          afterStep: (step) =>
            step !== "fenced"
              ? Effect.void
              : Effect.gen(function* () {
                  // As a version from before the lease would write. The
                  // policy takes a few seconds to apply.
                  yield* s3
                    .putObject({ Bucket, Key, Body: "{}" })
                    .pipe(
                      Effect.flip,
                      Effect.retry({ schedule: Schedule.spaced("2 seconds"), times: 30 }),
                    );
                  yield* s3.deleteObject({ Bucket, Key }).pipe(Effect.flip);
                  yield* s3.getObject({ Bucket, Key });
                  checked.done = true;
                }).pipe(
                  Effect.provideContext(aws),
                  Effect.mapError(
                    (error) => new StateStoreError({ message: `copy window: ${String(error)}` }),
                  ),
                ),
        });
        expect(checked.done).toBe(true);
        // The writes were refused, so the copy is the seeded stage.
        expect(result).toEqual([{ stack: STACK, stage, status: "migrated", records: 2 }]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* stores(storage).dynamodb;
            expect(yield* state.get({ stack: STACK, stage, fqn: b.fqn })).toEqual(b);
          }),
        );
      }).pipe(Effect.ensuring(release(storage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "the store's own migrate moves stages between the table and bucket it is configured with",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const stage = "configured";
      yield* Effect.gen(function* () {
        yield* seedS3(storage, stage);
        // What `alchemy state migrate` calls on the store alchemy.run.ts configures.
        const viaStore = (rollback: boolean) =>
          Effect.scoped(
            Effect.flatMap(stores(storage).dynamodb, (state) =>
              state.migrate === undefined
                ? Effect.die("the DynamoDB store has no migrate")
                : state.migrate({ stack: STACK, stage, rollback }),
            ),
          );

        expect(yield* viaStore(false)).toEqual([
          { stack: STACK, stage, status: "migrated", records: 2 },
        ]);
        // Into the configured table, not the account's default one.
        expect(
          (yield* dynamodb.getItem({
            TableName: storage.tableName,
            Key: { PK: { S: "CATALOG" }, SK: { S: `STAGE#${STACK}#${stage}` } },
            ConsistentRead: true,
          })).Item?.migratedFrom?.S,
        ).toBe(`s3://${storage.legacyBucketName}/${PREFIX}/`);

        expect(yield* viaStore(true)).toEqual([
          { stack: STACK, stage, status: "rolled-back", records: 2 },
        ]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* stores(storage).s3;
            expect(yield* state.get({ stack: STACK, stage, fqn: a.fqn })).toEqual(a);
          }),
        );
      }).pipe(Effect.ensuring(release(storage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a stage an S3 deploy holds is reported as blocked and moves once it is released",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const stage = "blocked";
      yield* Effect.gen(function* () {
        yield* seedS3(storage, stage);

        yield* Effect.scoped(
          Effect.gen(function* () {
            // An older alchemy, mid-deploy.
            const deploying = yield* stores(storage).s3;
            yield* deploying.list({ stack: STACK, stage });
            const result = yield* migrate(storage);
            expect(result).toHaveLength(1);
            expect(result[0]?.status).toBe("blocked");
            // The deploy keeps its lease and can still write.
            yield* deploying.set({
              stack: STACK,
              stage,
              fqn: "ResourceC",
              value: resource("ResourceC", {}),
            });
          }),
        );

        expect(yield* migrate(storage)).toEqual([
          { stack: STACK, stage, status: "migrated", records: 3 },
        ]);
      }).pipe(Effect.ensuring(release(storage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "running the migration again takes no lease on stages already moved",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const stage = "rerun";
      yield* Effect.gen(function* () {
        yield* seedS3(storage, stage);
        expect(yield* migrate(storage)).toEqual([
          { stack: STACK, stage, status: "migrated", records: 2 },
        ]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            // A deploy on DynamoDB holds the stage while the migration runs again.
            const deploying = yield* stores(storage).dynamodb;
            yield* deploying.list({ stack: STACK, stage });
            expect(yield* migrate(storage)).toEqual([
              { stack: STACK, stage, status: "already-migrated" },
            ]);
            yield* deploying.set({ stack: STACK, stage, fqn: b.fqn, value: b });
          }),
        );
      }).pipe(Effect.ensuring(release(storage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a migrated stage that is destroyed stays destroyed instead of reverting to its S3 copy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const stage = "destroyed";
      yield* Effect.gen(function* () {
        yield* seedS3(storage, stage);
        yield* migrate(storage);

        // What `alchemy destroy` ends with.
        yield* Effect.scoped(
          Effect.flatMap(stores(storage).dynamodb, (state) =>
            state.deleteStack({ stack: STACK, stage }),
          ),
        );

        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* stores(storage).dynamodb;
            expect(yield* state.listStages(STACK)).not.toContain(stage);
            expect(yield* state.getOutput({ stack: STACK, stage })).toBeUndefined();
            // Deploying the stage again starts it empty, not refused.
            expect(yield* state.list({ stack: STACK, stage })).toEqual([]);
            yield* state.set({ stack: STACK, stage, fqn: b.fqn, value: b });
          }),
        );

        expect(yield* migrate(storage)).toEqual([
          { stack: STACK, stage, status: "already-migrated" },
        ]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* stores(storage).dynamodb;
            expect(yield* state.list({ stack: STACK, stage })).toEqual([b.fqn]);
            expect(yield* state.listStages(STACK)).toContain(stage);
          }),
        );
      }).pipe(Effect.ensuring(release(storage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a stage that starts in DynamoDB is fenced in S3 against teammates still on the S3 store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const stage = "native-fenced";
      yield* Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.flatMap(stores(storage).dynamodb, (state) =>
            state.set({ stack: STACK, stage, fqn: a.fqn, value: a }),
          ),
        );
        const older = yield* Effect.scoped(
          Effect.flatMap(stores(storage).s3, (state) => state.list({ stack: STACK, stage })),
        ).pipe(Effect.flip);
        expect(older.message).toContain("moved to a DynamoDB state store");
      }).pipe(Effect.ensuring(release(storage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "rollback moves stages, including ones written since, back to the S3 store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const moved = "moved";
      const native = "native";
      yield* Effect.gen(function* () {
        yield* seedS3(storage, moved);
        yield* migrate(storage);

        // Writes after the migration, and a stage that started in DynamoDB.
        const c = resource("ResourceC", { value: "c" });
        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* stores(storage).dynamodb;
            yield* state.delete({ stack: STACK, stage: moved, fqn: b.fqn });
            yield* state.set({ stack: STACK, stage: moved, fqn: c.fqn, value: c });
            yield* state.set({ stack: STACK, stage: native, fqn: a.fqn, value: a });
          }),
        );

        const rolledBack = yield* rollback(storage);
        expect([...rolledBack].sort((x, y) => x.stage.localeCompare(y.stage))).toEqual([
          { stack: STACK, stage: moved, status: "rolled-back", records: 2 },
          { stack: STACK, stage: native, status: "rolled-back", records: 1 },
        ]);

        // An older alchemy has its stages back, with the writes it missed.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* stores(storage).s3;
            expect([...(yield* state.list({ stack: STACK, stage: moved }))].sort()).toEqual([
              "Parent/ResourceA",
              "ResourceC",
            ]);
            expect(yield* state.get({ stack: STACK, stage: moved, fqn: c.fqn })).toEqual(c);
            expect(yield* state.getOutput({ stack: STACK, stage: moved })).toEqual(output);
            expect(yield* state.get({ stack: STACK, stage: native, fqn: a.fqn })).toEqual(a);
            yield* state.set({ stack: STACK, stage: native, fqn: b.fqn, value: b });
          }),
        );

        // And the DynamoDB store refuses them until they are migrated again.
        const refused = yield* Effect.scoped(
          Effect.flatMap(stores(storage).dynamodb, (state) =>
            state.list({ stack: STACK, stage: native }),
          ),
        ).pipe(Effect.flip);
        expect(refused.requires?.command).toBe(migrateCommand(native));
        const items = yield* dynamodb.query({
          TableName: storage.tableName,
          ConsistentRead: true,
          KeyConditionExpression: "PK = :pk",
          ExpressionAttributeValues: { ":pk": { S: `STAGE#${STACK}#${moved}` } },
        });
        expect(items.Items ?? []).toEqual([]);
      }).pipe(Effect.ensuring(release(storage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a rollback that stops after switching a stage back finishes on the next run",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(Storage);
      const stage = "rollback-interrupted";
      yield* Effect.gen(function* () {
        yield* seedS3(storage, stage);
        expect(yield* migrate(storage)).toEqual([
          { stack: STACK, stage, status: "migrated", records: 2 },
        ]);

        const interrupted = yield* rollback(storage, {
          afterStep: () => Effect.fail(new StateStoreError({ message: "stopped after switching" })),
        });
        expect(interrupted).toEqual([
          { stack: STACK, stage, status: "failed", reason: "stopped after switching" },
        ]);
        // Switched back, but still fenced until the cleanup runs.
        const fenced = yield* Effect.scoped(
          Effect.flatMap(stores(storage).s3, (state) => state.list({ stack: STACK, stage })),
        ).pipe(Effect.flip);
        expect(fenced.message).toContain("moved to a DynamoDB state store");

        expect(yield* rollback(storage)).toEqual([{ stack: STACK, stage, status: "rolled-back" }]);
        yield* Effect.scoped(
          Effect.gen(function* () {
            const state = yield* stores(storage).s3;
            expect([...(yield* state.list({ stack: STACK, stage }))].sort()).toEqual([
              "Parent/ResourceA",
              "ResourceB",
            ]);
          }),
        );
      }).pipe(Effect.ensuring(release(storage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 180_000 },
);

test.provider(
  "a Stack deployed on the S3 store redeploys from DynamoDB after `alchemy state migrate`",
  (stack) =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      // A named store per stage, so runs never touch the account's default.
      const name = `mig-${yield* Effect.sync(() =>
        createHash("sha256").update(stack.stage).digest("hex").slice(0, 8),
      )}`;
      const program = Effect.gen(function* () {
        const secret = yield* Alchemy.Random("Secret");
        return { secret: secret.text };
      });
      const OnS3 = Alchemy.Stack(
        "StateMigrationStack",
        { providers: AWS.providers(), state: AWS.state({ backend: "s3", name }) },
        program,
      );
      const OnDynamoDB = Alchemy.Stack(
        "StateMigrationStack",
        { providers: AWS.providers(), state: AWS.state({ name }) },
        program,
      );
      const alchemist = Alchemist.layer();
      const awsStore = { type: "provider", backend: "aws", name } as const;
      const s3Store = { type: "provider", backend: "aws-s3", name } as const;
      const teardown = Effect.all(
        [Alchemist.State.teardown(awsStore), Alchemist.State.teardown(s3Store)],
        { discard: true },
      ).pipe(Effect.provide(alchemist));

      yield* teardown;
      const first = yield* deploy(OnS3);

      // The upgraded config refuses the stage instead of redeploying it fresh.
      const refused = yield* Effect.exit(deploy(OnDynamoDB));
      expect(Exit.isFailure(refused)).toBe(true);
      if (Exit.isFailure(refused)) {
        expect(Cause.pretty(refused.cause)).toContain(
          "alchemy state migrate --stack StateMigrationStack --stage",
        );
      }

      const result = yield* Alchemist.State.migrate(awsStore).pipe(Effect.provide(alchemist));
      expect(
        result.stages.map(({ stack, status, records }) => ({ stack, status, records })),
      ).toEqual([{ stack: "StateMigrationStack", status: "migrated", records: 1 }]);

      // Same resource, same secret: the state moved rather than starting over.
      const second = yield* deploy(OnDynamoDB);
      expect(Redacted.value(second.secret)).toBe(Redacted.value(first.secret));

      yield* destroy(OnDynamoDB);
      // Tearing down the DynamoDB store keeps the S3 store it replaced.
      const torn = yield* Alchemist.State.teardown(awsStore).pipe(Effect.provide(alchemist));
      expect([...torn.deleted].sort()).toEqual(
        [`alchemy-state-${name}`, createOverflowBucketName(accountId, region, name)].sort(),
      );
      const tornS3 = yield* Alchemist.State.teardown(s3Store).pipe(Effect.provide(alchemist));
      expect(tornS3.deleted).toEqual([`alchemy-state-${name}-${accountId}-${region}-an`]);
    }),
  { tags, timeout: 300_000 },
);
