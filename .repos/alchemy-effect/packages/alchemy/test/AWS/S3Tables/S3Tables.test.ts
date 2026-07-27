import * as AWS from "@/AWS";
import { Namespace, Table, TableBucket } from "@/AWS/S3Tables";
import type { ScopedPlanStatusSession } from "@/Cli/Cli.ts";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as s3tables from "@distilled.cloud/aws/s3tables";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as Result from "effect/Result";

const { test } = Test.make({ providers: AWS.providers() });
const stubSession = {
  note: () => Effect.void,
} as unknown as ScopedPlanStatusSession;

// Auto-generated table-bucket names are `${testNameSlug}-${id}-${stage}-`
// truncated + a random instance-id suffix. A run killed mid-deploy (before
// state persists) leaves buckets that `stack.destroy()` cannot see, and the
// suffix changes on every run so a re-run never reclaims them by name. Sweep
// by the deterministic prefix at test start so a passing run always implies
// a clean account. MUST match the lifecycle test's name slug below.
const LIFECYCLE_BUCKET_PREFIX = "table-bucket-namespace-table-lifecycle-";

const purgeOrphanedTableBuckets = Effect.gen(function* () {
  const buckets = yield* s3tables.listTableBuckets.pages({}).pipe(
    Stream.runCollect,
    Effect.map((chunk) =>
      Array.from(chunk).flatMap((page) => page.tableBuckets ?? []),
    ),
  );
  yield* Effect.forEach(
    buckets.filter((b) => b.name.startsWith(LIFECYCLE_BUCKET_PREFIX)),
    (bucket) =>
      Effect.gen(function* () {
        const tables = yield* s3tables.listTables
          .pages({ tableBucketARN: bucket.arn })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.tables ?? []),
            ),
          );
        yield* Effect.forEach(tables, (t) =>
          s3tables
            .deleteTable({
              tableBucketARN: bucket.arn,
              namespace: t.namespace[0]!,
              name: t.name,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
        );
        const namespaces = yield* s3tables.listNamespaces
          .pages({ tableBucketARN: bucket.arn })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.namespaces ?? []),
            ),
          );
        yield* Effect.forEach(namespaces, (ns) =>
          s3tables
            .deleteNamespace({
              tableBucketARN: bucket.arn,
              namespace: ns.namespace[0]!,
            })
            .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
        );
        yield* s3tables.deleteTableBucket({ tableBucketARN: bucket.arn }).pipe(
          // Child deletes are eventually consistent; ride out the window.
          Effect.retry({
            while: (e) => e._tag === "ConflictException",
            schedule: Schedule.max([
              Schedule.exponential(500),
              Schedule.recurs(8),
            ]),
          }),
          Effect.catchTag("NotFoundException", () => Effect.void),
        );
      }),
  );
});

// Poll a getter until it reports the resource is gone (typed
// NotFoundException), bounded so a stuck delete fails fast.
const waitUntilGone = <A, E extends { _tag: string }, R>(
  read: Effect.Effect<A, E, R>,
) =>
  read.pipe(
    Effect.flatMap(() =>
      Effect.fail({ _tag: "StillExists" as const } as const),
    ),
    Effect.retry({
      while: (e: { _tag: string }) => e._tag === "StillExists",
      schedule: Schedule.max([Schedule.exponential(500), Schedule.recurs(8)]),
    }),
    Effect.catchIf(
      (e): e is E & { _tag: "NotFoundException" } =>
        e._tag === "NotFoundException",
      () => Effect.void,
    ),
  );

test.provider(
  "table bucket → namespace → table lifecycle",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      yield* purgeOrphanedTableBuckets;

      const { bucket, namespace, table } = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* TableBucket("Analytics");
          const namespace = yield* Namespace("Events", {
            tableBucket: bucket.tableBucketArn,
          });
          const table = yield* Table("PageViews", {
            tableBucket: bucket.tableBucketArn,
            namespace: namespace.namespace,
            schema: {
              fields: [
                { name: "id", type: "long", required: true },
                { name: "url", type: "string" },
                { name: "ts", type: "timestamp" },
              ],
            },
          });
          return { bucket, namespace, table };
        }),
      );

      expect(bucket.tableBucketArn).toContain(":bucket/");
      expect(bucket.ownerAccountId).toBeDefined();
      expect(table.tableArn).toContain("/table/");
      expect(table.format).toBe("ICEBERG");
      expect(table.warehouseLocation).toBeDefined();

      // Out-of-band verification via distilled.
      const observedBucket = yield* s3tables.getTableBucket({
        tableBucketARN: bucket.tableBucketArn,
      });
      expect(observedBucket.name).toBe(bucket.name);

      const observedNs = yield* s3tables.getNamespace({
        tableBucketARN: bucket.tableBucketArn,
        namespace: namespace.namespace,
      });
      expect(observedNs.namespace[0]).toBe(namespace.namespace);

      const observedTable = yield* s3tables.getTable({
        tableBucketARN: bucket.tableBucketArn,
        namespace: namespace.namespace,
        name: table.name,
      });
      expect(observedTable.tableARN).toBe(table.tableArn);

      // Idempotent re-deploy: reconciler observes existing cloud state and
      // converges without error.
      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* TableBucket("Analytics");
          const namespace = yield* Namespace("Events", {
            tableBucket: bucket.tableBucketArn,
          });
          yield* Table("PageViews", {
            tableBucket: bucket.tableBucketArn,
            namespace: namespace.namespace,
            schema: {
              fields: [
                { name: "id", type: "long", required: true },
                { name: "url", type: "string" },
                { name: "ts", type: "timestamp" },
              ],
            },
          });
          return { bucket };
        }),
      );

      yield* stack.destroy();

      // The bucket (and everything under it) must be gone.
      yield* waitUntilGone(
        s3tables.getTableBucket({ tableBucketARN: bucket.tableBucketArn }),
      );
    }),
  { timeout: 180_000 },
);

test.provider(
  "table bucket replaces on name change",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const first = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TableBucket("Renamed");
        }),
      );
      expect(first.name).toBeDefined();
      yield* s3tables.getTableBucket({ tableBucketARN: first.tableBucketArn });

      // Derive the replacement name from the engine-generated physical name.
      // Reusing fixed bucket names across test runs races AWS's deletion
      // tombstone and can return Conflict for minutes after Get reports 404.
      const replacementName = `${first.name.slice(0, 55)}-renamed`;
      const second = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TableBucket("Renamed", {
            name: replacementName,
          });
        }),
      );
      expect(second.name).toBe(replacementName);
      expect(second.tableBucketArn).not.toBe(first.tableBucketArn);

      // The old bucket must have been deleted as part of the replacement.
      yield* waitUntilGone(
        s3tables.getTableBucket({ tableBucketARN: first.tableBucketArn }),
      );

      yield* stack.destroy();
      yield* waitUntilGone(
        s3tables.getTableBucket({ tableBucketARN: second.tableBucketArn }),
      );
    }),
  { timeout: 180_000 },
);

test.provider(
  "ordinary bucket delete protects untracked children; force purges them",
  (stack) =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(TableBucket);
      const initialDestroy = yield* Effect.result(stack.destroy());
      if (Result.isFailure(initialDestroy)) {
        // Recover only this test's deterministic leftovers from an interrupted
        // protection assertion. Ordinary destroy intentionally cannot remove
        // them, so use the same explicit force path nuke uses.
        const stale = (yield* provider.list()).filter((bucket) =>
          bucket.name.startsWith(
            "ordinary-bucket-delete-protects-untracked-child",
          ),
        );
        yield* Effect.forEach(
          stale,
          (output) =>
            provider.delete({
              id: "CascadeDeleteRecovery",
              fqn: "CascadeDeleteRecovery",
              instanceId: "force-delete-recovery",
              olds: {},
              output,
              session: stubSession,
              bindings: [],
              force: true,
            }),
          { discard: true },
        );
        yield* stack.destroy();
      }

      const bucket = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* TableBucket("CascadeDelete");
        }),
      );
      // Simulate a run interrupted before child state was persisted. Global
      // nuke can see the bucket but cannot enumerate Namespace providers.
      yield* s3tables.createNamespace({
        tableBucketARN: bucket.tableBucketArn,
        namespace: ["untracked_child"],
      });

      const deleteInput = {
        id: "CascadeDelete",
        fqn: "CascadeDelete",
        instanceId: "force-delete-test",
        olds: {},
        output: bucket,
        session: stubSession,
        bindings: [],
      };
      const protectedDelete = yield* Effect.result(
        provider.delete(deleteInput),
      );
      expect(Result.isFailure(protectedDelete)).toBe(true);
      if (Result.isFailure(protectedDelete)) {
        expect(protectedDelete.failure._tag).toBe("BadRequestException");
      }
      yield* s3tables.getNamespace({
        tableBucketARN: bucket.tableBucketArn,
        namespace: "untracked_child",
      });

      yield* provider.delete({ ...deleteInput, force: true });
      yield* waitUntilGone(
        s3tables.getTableBucket({ tableBucketARN: bucket.tableBucketArn }),
      );
      // Clear the now-stale stack state through the normal idempotent path.
      yield* stack.destroy();
    }),
  { timeout: 120_000 },
);
