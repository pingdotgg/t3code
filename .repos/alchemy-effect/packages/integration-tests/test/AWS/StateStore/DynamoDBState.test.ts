import { createHash } from "node:crypto";
import * as AWS from "@alchemy.run/aws";
import { makeDynamoDBState } from "@alchemy.run/aws";
import { AWSEnvironment } from "@alchemy.run/aws/Environment";
import { createOverflowBucketName } from "@alchemy.run/aws/StateStore/DynamoDBState";
import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Core from "@alchemy.run/test/Core";
import * as dynamodb from "@distilled.cloud/aws/dynamodb";
import * as s3 from "@distilled.cloud/aws/s3";
import * as sqs from "@distilled.cloud/aws/sqs";
import * as Alchemy from "alchemy";
import * as Alchemist from "alchemy/Alchemist";
import { StateStoreError, type ResourceState, type StateService } from "alchemy/State";
import * as Cause from "effect/Cause";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Logger from "effect/Logger";
import * as Redacted from "effect/Redacted";
import * as References from "effect/References";

const { test } = Test.make({ providers: AWS.providers() });

const STACK = "DynamoDBStateStoreTestStack";

const tags = ["provider:aws", "provider:aws:dynamodb", "provider:aws:statestore", "live"];

/** A table with the store's key schema, and a bucket for overflow records. */
const StateStorage = Effect.gen(function* () {
  const table = yield* AWS.DynamoDB.Table("StateTable", {
    partitionKey: "PK",
    sortKey: "SK",
    attributes: { PK: "S", SK: "S" },
  });
  const bucket = yield* AWS.S3.Bucket("OverflowBucket", { forceDestroy: true });
  return {
    tableName: table.tableName,
    overflowBucketName: bucket.bucketName,
    // These cases exercise the store alone; Migration.test.ts covers the S3 handover.
    migrateFrom: false as const,
  };
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

/** Idempotent cleanup that can't fail an `Effect.ensuring`. */
const cleanStage = (state: StateService, stage: string) =>
  state.deleteStack({ stack: STACK, stage }).pipe(Effect.orDie);

const partitionItems = (tableName: string, stage: string) =>
  dynamodb
    .query({
      TableName: tableName,
      ConsistentRead: true,
      KeyConditionExpression: "PK = :pk",
      ExpressionAttributeValues: { ":pk": { S: `STAGE#${STACK}#${stage}` } },
    })
    .pipe(Effect.map((result) => result.Items ?? []));

const objectKeys = (bucketName: string) =>
  s3
    .listObjectsV2({ Bucket: bucketName })
    .pipe(Effect.map((result) => (result.Contents ?? []).map((object) => object.Key)));

test.provider(
  "set/get/list/delete round-trips state through DynamoDB",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(StateStorage);
      const state = yield* makeDynamoDBState(storage);
      const stage = "round-trip";

      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        const a = resource("Parent/ResourceA", { value: "a" });
        const b = resource("ResourceB", { value: "b" });

        yield* state.set({ stack: STACK, stage, fqn: a.fqn, value: a });
        yield* state.set({ stack: STACK, stage, fqn: b.fqn, value: b });

        expect(yield* state.get({ stack: STACK, stage, fqn: a.fqn })).toEqual(a);
        expect(yield* state.get({ stack: STACK, stage, fqn: "does-not-exist" })).toBeUndefined();

        const fqns = yield* state.list({ stack: STACK, stage });
        expect([...fqns].sort()).toEqual(["Parent/ResourceA", "ResourceB"]);

        expect(yield* state.listStacks()).toContain(STACK);
        expect(yield* state.listStages(STACK)).toContain(stage);

        yield* state.delete({ stack: STACK, stage, fqn: a.fqn });
        expect(yield* state.get({ stack: STACK, stage, fqn: a.fqn })).toBeUndefined();
        // deleting a missing resource is a no-op
        yield* state.delete({ stack: STACK, stage, fqn: a.fqn });

        yield* state.deleteStack({ stack: STACK, stage });
        expect(yield* state.list({ stack: STACK, stage })).toEqual([]);
        expect(yield* state.listStages(STACK)).not.toContain(stage);
        // Only the lease, which the store deletes when it closes, is left.
        expect((yield* partitionItems(storage.tableName, stage)).map((item) => item.SK?.S)).toEqual(
          ["LEASE"],
        );
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a new store loads the state another store wrote",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(StateStorage);
      const stage = "reload";
      const a = resource("ResourceA", { value: "a" });
      const replaced = {
        ...resource("Replaced", { value: "r" }),
        status: "replaced",
      } as ResourceState;

      yield* Effect.scoped(
        Effect.gen(function* () {
          const writer = yield* makeDynamoDBState(storage);
          yield* writer.set({ stack: STACK, stage, fqn: a.fqn, value: a });
          yield* writer.set({ stack: STACK, stage, fqn: replaced.fqn, value: replaced });
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const reader = yield* makeDynamoDBState(storage);
          expect(yield* reader.get({ stack: STACK, stage, fqn: a.fqn })).toEqual(a);
          expect([...(yield* reader.list({ stack: STACK, stage }))].sort()).toEqual([
            "Replaced",
            "ResourceA",
          ]);
          const result = yield* reader.getReplacedResources({ stack: STACK, stage });
          expect(result.map((r) => r.fqn)).toEqual(["Replaced"]);
          yield* reader.deleteStack({ stack: STACK, stage });
        }),
      );

      // Closing the store deleted its lease, so the stage is gone.
      expect(yield* partitionItems(storage.tableName, stage)).toEqual([]);
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "records above the overflow threshold are stored in S3",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(StateStorage);
      const options = { ...storage, overflowThreshold: 1024 };
      const stage = "overflow";
      const large = resource("Large", { blob: "x".repeat(4096) });
      const small = resource("Large", { blob: "small" });
      const output = { html: "y".repeat(4096) };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeDynamoDBState(options);
          yield* state.set({ stack: STACK, stage, fqn: large.fqn, value: large });
          yield* state.setOutput({ stack: STACK, stage, value: output });

          // The items hold references, and the bodies are in the bucket.
          const items = yield* partitionItems(storage.tableName, stage);
          const record = items.find((item) => item.fqn?.S === large.fqn);
          expect(record?.data).toBeUndefined();
          expect(record?.ref?.S).toBeDefined();
          expect(items.find((item) => item.SK?.S === "OUTPUT")?.ref?.S).toBeDefined();
          expect(yield* objectKeys(storage.overflowBucketName)).toHaveLength(2);

          expect(yield* state.get({ stack: STACK, stage, fqn: large.fqn })).toEqual(large);
          expect(yield* state.getOutput({ stack: STACK, stage })).toEqual(output);
        }),
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          // A fresh store reads the overflow bodies back.
          const state = yield* makeDynamoDBState(options);
          expect(yield* state.get({ stack: STACK, stage, fqn: large.fqn })).toEqual(large);

          // Shrinking the record stores it inline and deletes its old body.
          yield* state.set({ stack: STACK, stage, fqn: small.fqn, value: small });
          const record = (yield* partitionItems(storage.tableName, stage)).find(
            (item) => item.fqn?.S === small.fqn,
          );
          expect(record?.ref).toBeUndefined();
          expect(record?.data?.S).toBeDefined();
          expect(yield* objectKeys(storage.overflowBucketName)).toHaveLength(1);
          expect(yield* state.get({ stack: STACK, stage, fqn: small.fqn })).toEqual(small);

          // Deleting the stage deletes the output's body too.
          yield* state.deleteStack({ stack: STACK, stage });
          expect(yield* objectKeys(storage.overflowBucketName)).toEqual([]);
          expect(yield* state.getOutput({ stack: STACK, stage })).toBeUndefined();
        }),
      );
      yield* stack.destroy();
    }),
  { tags: [...tags, "provider:aws:s3"], timeout: 120_000 },
);

test.provider(
  "a record whose overflow body is missing fails instead of reading as absent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(StateStorage);
      const options = { ...storage, overflowThreshold: 1024 };
      const stage = "missing-body";
      const large = resource("Large", { blob: "x".repeat(4096) });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeDynamoDBState(options);
          yield* state.set({ stack: STACK, stage, fqn: large.fqn, value: large });
        }),
      );
      for (const key of yield* objectKeys(storage.overflowBucketName)) {
        yield* s3.deleteObject({ Bucket: storage.overflowBucketName, Key: key! });
      }

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeDynamoDBState(options);
          const error = yield* state.get({ stack: STACK, stage, fqn: large.fqn }).pipe(Effect.flip);
          expect(error).toBeInstanceOf(StateStoreError);
          expect(error.message).toContain("references missing overflow object");
        }),
      );

      yield* stack.destroy();
    }),
  { tags: [...tags, "provider:aws:s3"], timeout: 120_000 },
);

test.provider(
  "stack outputs are stored separately from resources",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(StateStorage);
      const state = yield* makeDynamoDBState(storage);
      const stage = "outputs";

      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        expect(yield* state.getOutput({ stack: STACK, stage })).toBeUndefined();
        yield* state.setOutput({ stack: STACK, stage, value: { url: "https://example.com" } });
        expect(yield* state.getOutput({ stack: STACK, stage })).toEqual({
          url: "https://example.com",
        });
        // the output item must not leak into list()
        expect(yield* state.list({ stack: STACK, stage })).toEqual([]);

        yield* state.deleteStack({ stack: STACK, stage });
        expect(yield* state.getOutput({ stack: STACK, stage })).toBeUndefined();
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a second DynamoDB state store cannot write a stage another deploy holds",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(StateStorage);
      const stage = "race";
      const created = resource("Vpc", { vpcId: "vpc-aaaa" });
      const request = { stack: STACK, stage, fqn: created.fqn, value: created };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* makeDynamoDBState(storage);
          yield* held.set(request);
          const other = yield* makeDynamoDBState(storage);
          const error = yield* other
            .set({ ...request, value: { ...created, attr: { vpcId: "vpc-bbbb" } } })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(StateStoreError);
          expect(error.message).toContain("another deploy holds the DynamoDB state lock");
          expect(yield* held.get({ stack: STACK, stage, fqn: created.fqn })).toMatchObject({
            attr: { vpcId: "vpc-aaaa" },
          });
          // The lease item is not a resource row.
          expect(yield* held.list({ stack: STACK, stage })).toEqual([created.fqn]);
        }),
      );

      // The first store's scope has closed and released the lease.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const next = yield* makeDynamoDBState(storage);
          yield* next.set({ ...request, value: { ...created, attr: { vpcId: "vpc-cccc" } } });
          expect(yield* next.get({ stack: STACK, stage, fqn: created.fqn })).toMatchObject({
            attr: { vpcId: "vpc-cccc" },
          });
          yield* next.deleteStack({ stack: STACK, stage });
        }),
      );

      const after = yield* makeDynamoDBState(storage);
      expect(yield* after.listStages(STACK)).not.toContain(stage);
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an expired DynamoDB state lease can be taken and a live one cannot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(StateStorage);
      const state = yield* makeDynamoDBState(storage);
      const expiredStage = "expired";
      const heldStage = "held";
      const leaseKey = (stage: string) => ({
        PK: { S: `STAGE#${STACK}#${stage}` },
        SK: { S: "LEASE" },
      });
      const putLease = (stage: string, expiresAt: number) =>
        dynamodb.putItem({
          TableName: storage.tableName,
          Item: {
            ...leaseKey(stage),
            token: { S: "foreign" },
            expiresAt: { N: String(expiresAt) },
          },
        });

      yield* putLease(expiredStage, 0);
      const created = resource("Group", { groupId: "sg-aaaa" });
      yield* state.set({ stack: STACK, stage: expiredStage, fqn: created.fqn, value: created });
      expect(yield* state.list({ stack: STACK, stage: expiredStage })).toEqual([created.fqn]);

      yield* putLease(heldStage, Date.now() + 60_000);
      const blocked = yield* state
        .set({ stack: STACK, stage: heldStage, fqn: created.fqn, value: created })
        .pipe(Effect.flip);
      expect(blocked).toBeInstanceOf(StateStoreError);
      expect(blocked.message).toContain("another deploy holds the DynamoDB state lock");

      yield* dynamodb.deleteItem({ TableName: storage.tableName, Key: leaseKey(heldStage) });
      yield* state.deleteStack({ stack: STACK, stage: expiredStage });
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

// A large deploy can queue its lease refresh behind thousands of state
// writes until the lease lapses. Nobody else took it, so the deploy keeps
// going; a deploy that did take it wins.
test.provider(
  "a lease that lapsed while still held is taken back unless another deploy took it",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(StateStorage);
      const stage = "lapse";
      const created = resource("Queue", { queueUrl: "a" });
      const request = { stack: STACK, stage, fqn: created.fqn, value: created };
      const lapse = dynamodb.updateItem({
        TableName: storage.tableName,
        Key: { PK: { S: `STAGE#${STACK}#${stage}` }, SK: { S: "LEASE" } },
        UpdateExpression: "SET expiresAt = :zero",
        ExpressionAttributeValues: { ":zero": { N: "0" } },
      });
      // Past the store's 5s trust in its last lease check.
      const pastCheck = Effect.sleep("6 seconds");

      yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* makeDynamoDBState(storage);
          yield* held.set(request);
          yield* lapse;
          yield* pastCheck;
          yield* held.set({ ...request, value: { ...created, attr: { queueUrl: "b" } } });
          expect(yield* held.get({ stack: STACK, stage, fqn: created.fqn })).toMatchObject({
            attr: { queueUrl: "b" },
          });

          // Lapsed again, and this time another deploy takes it.
          yield* lapse;
          yield* Effect.scoped(
            Effect.gen(function* () {
              const other = yield* makeDynamoDBState(storage);
              yield* other.list({ stack: STACK, stage });
              yield* pastCheck;
              const lost = yield* held.set(request).pipe(Effect.flip);
              expect(lost.message).toContain("was lost mid-run");
              yield* other.deleteStack({ stack: STACK, stage });
            }),
          );
        }),
      );
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

// State holds generated secrets, and the AWS client logs request payloads
// and parsed responses at Debug.
test.provider(
  "state contents stay out of Debug logs",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(StateStorage);
      const secret = "dynamodb-state-logging-secret-0123456789";
      const stage = "logging";

      const lines: string[] = [];
      const logger = Logger.make<unknown, void>((options) => {
        lines.push(JSON.stringify(options.message, (_, v) => (typeof v === "bigint" ? `${v}` : v)));
      });
      const atDebug = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.provide(Logger.layer([logger])),
          Effect.provideService(References.MinimumLogLevel, "Debug"),
        );

      yield* atDebug(
        Effect.scoped(
          Effect.gen(function* () {
            const state = yield* makeDynamoDBState(storage);
            const value = resource("SecretHolder", { token: secret });
            yield* state.set({ stack: STACK, stage, fqn: value.fqn, value });
            expect(yield* state.get({ stack: STACK, stage, fqn: value.fqn })).toEqual(value);
            yield* state.deleteStack({ stack: STACK, stage });
          }),
        ),
      );
      expect(lines.join("\n")).not.toContain(secret);

      // Control: the same payload sent directly is logged at Debug, so the
      // capture above is real.
      lines.length = 0;
      yield* atDebug(
        dynamodb.putItem({
          TableName: storage.tableName,
          Item: { PK: { S: "control" }, SK: { S: "control" }, data: { S: secret } },
        }),
      );
      expect(lines.join("\n")).toContain(secret);

      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

/** Run with `CI` set to `value`, or unset. */
const withCI =
  (value: string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const previous = process.env.CI;
        if (value === undefined) delete process.env.CI;
        else process.env.CI = value;
        return previous;
      }),
      () => effect,
      (previous) =>
        Effect.sync(() => {
          if (previous === undefined) delete process.env.CI;
          else process.env.CI = previous;
        }),
    );

/** Run as a CI deploy would. */
const inCI = withCI("true");

/**
 * Build and use a store with `CI` set to `ci` in its config. The store
 * reads `CI` through the config it is built with, not `process.env`.
 */
const withCIConfig =
  (ci: boolean) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.gen(function* () {
      const ambient = yield* ConfigProvider.ConfigProvider;
      return yield* effect.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.orElse(ConfigProvider.fromUnknown({ CI: String(ci) }), ambient),
        ),
      );
    });

const bucketExists = (bucketName: string) =>
  s3.headBucket({ Bucket: bucketName }).pipe(
    Effect.as(true),
    Effect.catchTag(["NotFound", "NoSuchBucket"], () => Effect.succeed(false)),
  );

/** A deterministic name per test stage, so runs never collide or touch the account's default store. */
const stageName = (prefix: string, stage: string) =>
  Effect.sync(() => `${prefix}-${createHash("sha256").update(stage).digest("hex").slice(0, 8)}`);

const tableExists = (tableName: string) =>
  dynamodb.describeTable({ TableName: tableName }).pipe(
    Effect.as(true),
    Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(false)),
  );

test(
  "overflow bucket names fit S3's 63-character limit for every valid store name",
  Effect.sync(() => {
    const accountId = "123456789012";
    for (const region of ["us-east-1", "ap-southeast-2"]) {
      expect(createOverflowBucketName(accountId, region)).toBe(
        `alchemy-state-overflow-${accountId}-${region}-an`,
      );
      expect(createOverflowBucketName(accountId, region, "team-a")).toBe(
        `alchemy-state-overflow-team-a-${accountId}-${region}-an`,
      );
      const seen = new Set<string>();
      // Store names are 1-20 characters.
      for (let length = 1; length <= 20; length++) {
        for (const name of ["a".repeat(length), `${"b".repeat(length - 1)}c`]) {
          const bucket = createOverflowBucketName(accountId, region, name);
          expect(bucket.length).toBeLessThanOrEqual(63);
          expect(bucket).toMatch(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/);
          expect(bucket).not.toContain("--");
          expect(bucket.endsWith(`-${accountId}-${region}-an`)).toBe(true);
          seen.add(bucket);
        }
      }
      // Shortened names stay unique.
      expect(seen.size).toBe(40);
    }
  }),
  { tags: ["unit", "provider:aws", "provider:aws:statestore", "local"] },
);

// A deploy that stalls past its lease (a paused laptop, a GC pause) and
// lost it to another deploy may still believe its last lease check. The
// catalog write that enters its stage checks the lease in the same
// transaction, so the stall can't register a stage it no longer holds.
test.provider(
  "a deploy that lost its lease can't enter its stage in the catalog",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const storage = yield* stack.deploy(StateStorage);
      const stage = "lost-lease";
      const created = resource("Topic", { topicArn: "a" });
      const leaseKey = { PK: { S: `STAGE#${STACK}#${stage}` }, SK: { S: "LEASE" } };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const stalled = yield* makeDynamoDBState(storage);
          // Takes the lease; its check is now trusted for a few seconds.
          yield* stalled.list({ stack: STACK, stage });
          // Another deploy takes the lease over.
          yield* dynamodb.putItem({
            TableName: storage.tableName,
            Item: {
              ...leaseKey,
              token: { S: "another-deploy" },
              expiresAt: { N: String(Date.now() + 60_000) },
            },
          });
          const lost = yield* stalled
            .set({ stack: STACK, stage, fqn: created.fqn, value: created })
            .pipe(Effect.flip);
          expect(lost.message).toContain("was lost mid-run");
        }),
      );

      const catalog = yield* dynamodb.getItem({
        TableName: storage.tableName,
        Key: { PK: { S: "CATALOG" }, SK: { S: `STAGE#${STACK}#${stage}` } },
        ConsistentRead: true,
      });
      expect(catalog.Item).toBeUndefined();
      expect((yield* partitionItems(storage.tableName, stage)).map((item) => item.SK?.S)).toEqual([
        "LEASE",
      ]);
      expect(
        (yield* dynamodb.getItem({ TableName: storage.tableName, Key: leaseKey })).Item?.token?.S,
      ).toBe("another-deploy");
      yield* dynamodb.deleteItem({ TableName: storage.tableName, Key: leaseKey });
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a missing overflow bucket is created on first use, and in CI fails before any state is written",
  (stack) =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* stack.destroy();
      const storage = yield* stack.deploy(StateStorage);
      const overflowBucketName = `${yield* stageName("alchemy-test-ovf", stack.stage)}-${accountId}-${region}-an`;
      const options = { ...storage, overflowBucketName };
      const stage = "overflow-up-front";
      const small = resource("Small", { value: "small" });
      const write = Effect.scoped(
        Effect.flatMap(makeDynamoDBState(options), (state) =>
          state.set({ stack: STACK, stage, fqn: small.fqn, value: small }),
        ),
      );
      const removeBucket = s3.deleteBucket({ Bucket: overflowBucketName }).pipe(Effect.ignore);

      yield* removeBucket;
      yield* Effect.gen(function* () {
        const inCi = yield* withCIConfig(true)(Effect.exit(write));
        expect(Exit.isFailure(inCi)).toBe(true);
        if (Exit.isFailure(inCi)) {
          expect(Cause.pretty(inCi.cause)).toContain(
            `DynamoDB state overflow bucket '${overflowBucketName}'`,
          );
        }
        expect(yield* partitionItems(storage.tableName, stage)).toEqual([]);
        expect(yield* bucketExists(overflowBucketName)).toBe(false);

        // Outside CI the first write creates it, though this record doesn't overflow.
        yield* withCIConfig(false)(write);
        expect(yield* bucketExists(overflowBucketName)).toBe(true);
        yield* Effect.scoped(
          Effect.flatMap(makeDynamoDBState(options), (state) =>
            state.deleteStack({ stack: STACK, stage }),
          ),
        );
      }).pipe(Effect.ensuring(removeBucket));
      yield* stack.destroy();
    }),
  { tags: [...tags, "provider:aws:s3"], timeout: 120_000 },
);

test.provider(
  "a store created on first use has deletion protection and the given KMS key",
  (stack) =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      yield* stack.destroy();
      const { keyArn } = yield* stack.deploy(
        Effect.gen(function* () {
          const key = yield* AWS.KMS.Key("StateKey", { description: "DynamoDB state store test" });
          return { keyArn: key.keyArn };
        }),
      );
      const name = yield* stageName("kms", stack.stage);
      const table = `alchemy-state-${name}`;
      const bucket = createOverflowBucketName(accountId, region, name);
      const target = { type: "provider", backend: "aws", name } as const;
      const alchemist = Alchemist.layer();
      const teardown = Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));

      yield* teardown;
      yield* Effect.gen(function* () {
        yield* withCIConfig(false)(
          Effect.scoped(
            Effect.flatMap(
              makeDynamoDBState({ name, kmsKeyId: keyArn, migrateFrom: false }),
              (state) => state.listStacks(),
            ),
          ),
        );
        const described = (yield* dynamodb.describeTable({ TableName: table })).Table;
        expect(described?.DeletionProtectionEnabled).toBe(true);
        expect(described?.SSEDescription?.SSEType).toBe("KMS");
        expect(described?.SSEDescription?.KMSMasterKeyArn).toBe(keyArn);
        const encryption = yield* s3.getBucketEncryption({ Bucket: bucket });
        const rule = encryption.ServerSideEncryptionConfiguration?.Rules?.[0];
        expect(rule?.ApplyServerSideEncryptionByDefault?.SSEAlgorithm).toBe("aws:kms");
        const keyId = rule?.ApplyServerSideEncryptionByDefault?.KMSMasterKeyID;
        expect(Redacted.isRedacted(keyId) ? Redacted.value(keyId) : keyId).toBe(keyArn);

        // Teardown lifts the protection to delete it.
        const torn = yield* teardown;
        expect([...torn.deleted].sort()).toEqual([table, bucket].sort());
        expect(yield* tableExists(table)).toBe(false);
      }).pipe(Effect.ensuring(teardown.pipe(Effect.ignore)));
      yield* stack.destroy();
    }),
  { tags: [...tags, "provider:aws:s3", "provider:aws:kms"], timeout: 240_000 },
);

test.provider(
  "a named DynamoDB state store bootstraps, serves state and tears down",
  (stack) =>
    Effect.gen(function* () {
      const { accountId, region } = yield* AWSEnvironment.current;
      // Never the default store, which every other run on the account uses.
      const name = `ddb-${yield* Effect.sync(() =>
        createHash("sha256").update(stack.stage).digest("hex").slice(0, 8),
      )}`;
      const table = `alchemy-state-${name}`;
      const bucket = `alchemy-state-overflow-${name}-${accountId}-${region}-an`;
      const target = { type: "provider", backend: "aws", name } as const;
      const alchemist = Alchemist.layer();

      yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));

      const created = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(created.status).toBe("created");
      expect(created.store).toBe(table);
      expect(yield* tableExists(table)).toBe(true);
      const backups = yield* dynamodb.describeContinuousBackups({ TableName: table });
      expect(
        backups.ContinuousBackupsDescription?.PointInTimeRecoveryDescription
          ?.PointInTimeRecoveryStatus,
      ).toBe("ENABLED");
      expect((yield* s3.getBucketVersioning({ Bucket: bucket })).Status).toBe("Enabled");

      const adopted = yield* Alchemist.State.bootstrap(target).pipe(Effect.provide(alchemist));
      expect(adopted.status).toBe("adopted");

      const store = yield* Alchemist.State.store(target).pipe(Effect.provide(alchemist));
      expect(yield* store.listStacks()).toEqual([]);

      const torn = yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      expect([...torn.deleted].sort()).toEqual([table, bucket].sort());
      expect(yield* tableExists(table)).toBe(false);

      const again = yield* Alchemist.State.teardown(target).pipe(Effect.provide(alchemist));
      expect(again.deleted).toEqual([]);

      // In CI, a missing store fails instead of being created on first use.
      const inCi = yield* inCI(
        Effect.exit(
          Alchemist.State.store(target).pipe(
            Effect.flatMap((store) => store.listStacks()),
            Effect.provide(alchemist),
          ),
        ),
      );
      expect(Exit.isFailure(inCi)).toBe(true);
      if (Exit.isFailure(inCi)) {
        expect(Cause.pretty(inCi.cause)).toContain(
          `Run 'alchemy state bootstrap --backend aws --name ${name}`,
        );
      }
      expect(yield* tableExists(table)).toBe(false);
    }),
  // Exclusive: sets `CI` on the process.
  { tags: [...tags, "provider:aws:s3"], timeout: 240_000, exclusive: true },
);

// Each deploy/destroy of a Stack declaring the DynamoDB state store releases
// its lease when it finishes, so a file can redeploy and destroy that Stack.
const ddbStack = { providers: AWS.providers(), state: AWS.state() };
const ddbHarness = Test.make(ddbStack);

const DynamoDBStateStack = Alchemy.Stack(
  "DynamoDBStateHarness",
  ddbStack,
  Effect.gen(function* () {
    const queue = yield* AWS.SQS.Queue("HarnessQueue");
    return { queueUrl: queue.queueUrl };
  }),
);

describe(
  "a Stack with the DynamoDB state store",
  { tags: ["provider:aws", "provider:aws:sqs", "provider:aws:statestore", "live"] },
  () => {
    const deployed = ddbHarness.beforeAll(ddbHarness.deploy(DynamoDBStateStack), {
      timeout: 120_000,
    });

    ddbHarness.afterAll.skipIf(!!process.env.NO_DESTROY)(
      Effect.gen(function* () {
        const { queueUrl } = yield* deployed;
        yield* ddbHarness.destroy(DynamoDBStateStack);
        const gone = yield* Core.withProviders(
          sqs.getQueueAttributes({ QueueUrl: queueUrl, AttributeNames: ["QueueArn"] }).pipe(
            Effect.as(false),
            Effect.catchTag("QueueDoesNotExist", () => Effect.succeed(true)),
          ),
          ddbStack,
          "DynamoDBStateHarness",
        );
        expect(gone).toBe(true);
      }),
      { timeout: 120_000 },
    );

    ddbHarness.test(
      "redeploys from the state the file's first deploy wrote",
      Effect.gen(function* () {
        const { queueUrl } = yield* deployed;
        const redeployed = yield* ddbHarness.deploy(DynamoDBStateStack);
        expect(redeployed.queueUrl).toBe(queueUrl);
      }),
      { timeout: 120_000 },
    );
  },
);
