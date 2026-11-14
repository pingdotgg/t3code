import { createHash } from "node:crypto";
import * as GCP from "@alchemy.run/gcp";
import { makeGcsState } from "@alchemy.run/gcp";
import { createStateBucketName } from "@alchemy.run/gcp/StateStore/State";
import { makeObjectMedia } from "@alchemy.run/gcp/Storage/ObjectMedia";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as storage from "@distilled.cloud/gcp/storage_v1";
import { StateStoreError, type ResourceState, type StateService } from "alchemy/State";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

const { test } = Test.make({ providers: GCP.providers() });

const STACK = "GcsStateStoreTestStack";

const tags = ["provider:gcp", "provider:gcp:storage", "provider:gcp:statestore", "live"];

const cleanStage = (state: StateService, stage: string) =>
  state.deleteStack({ stack: STACK, stage }).pipe(Effect.orDie);

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

/** Delete every object generation, then the bucket. Missing is fine. */
const deleteBucket = (bucket: string) =>
  Effect.gen(function* () {
    yield* storage.listObjects.pages({ bucket, versions: true }).pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.items ?? [])),
      Stream.runForEach((object) =>
        storage
          .deleteObjects({ bucket, object: object.name!, generation: object.generation })
          .pipe(Effect.catchTag("NotFound", () => Effect.void)),
      ),
    );
    yield* storage.deleteBuckets({ bucket }).pipe(
      Effect.catchTag("NotFound", () => Effect.void),
      Effect.retry({
        while: (error) => error._tag === "Conflict",
        schedule: Schedule.spaced("1 second"),
        times: 8,
      }),
    );
  }).pipe(Effect.catchTag("NotFound", () => Effect.void));

test.provider(
  "set/get/list/delete round-trips state through Cloud Storage",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(GCP.Storage.Bucket("StateBucket", { forceDestroy: true }));
      const state = yield* makeGcsState({ bucketName: bucket.bucketName, prefix: "test-state" });
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

        yield* state.setOutput({ stack: STACK, stage, value: { url: "https://example.com" } });
        expect(yield* state.getOutput({ stack: STACK, stage })).toEqual({
          url: "https://example.com",
        });
        // the output bookkeeping object must not leak into list()
        expect(yield* state.list({ stack: STACK, stage })).toEqual(["ResourceB"]);

        yield* state.deleteStack({ stack: STACK, stage });
        expect(yield* state.list({ stack: STACK, stage })).toEqual([]);
        expect(yield* state.getOutput({ stack: STACK, stage })).toBeUndefined();
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "a second Cloud Storage state store cannot write a stage another deploy holds",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(GCP.Storage.Bucket("StateBucket", { forceDestroy: true }));
      const options = { bucketName: bucket.bucketName, prefix: "lease" };
      const stage = "race";
      const created = resource("Vpc", { vpcId: "vpc-aaaa" });
      const request = { stack: STACK, stage, fqn: created.fqn, value: created };

      yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* makeGcsState(options);
          yield* held.set(request);
          const other = yield* makeGcsState(options);
          const error = yield* other
            .set({ ...request, value: { ...created, attr: { vpcId: "vpc-bbbb" } } })
            .pipe(Effect.flip);
          expect(error).toBeInstanceOf(StateStoreError);
          expect(error.message).toContain("another deploy holds the Cloud Storage state lock");
          expect(yield* held.get({ stack: STACK, stage, fqn: created.fqn })).toMatchObject({
            attr: { vpcId: "vpc-aaaa" },
          });
          // The lease object is not a resource row.
          expect(yield* held.list({ stack: STACK, stage })).toEqual([created.fqn]);
        }),
      );

      // The first store's scope has closed and released the lease.
      yield* Effect.scoped(
        Effect.gen(function* () {
          const next = yield* makeGcsState(options);
          yield* next.set({ ...request, value: { ...created, attr: { vpcId: "vpc-cccc" } } });
          expect(yield* next.get({ stack: STACK, stage, fqn: created.fqn })).toMatchObject({
            attr: { vpcId: "vpc-cccc" },
          });
          yield* next.deleteStack({ stack: STACK, stage });
        }),
      );

      // Closing the store deletes its lease, so a destroyed stage is no
      // longer listed.
      const after = yield* makeGcsState(options);
      expect(yield* after.listStages(STACK)).not.toContain(stage);
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "an expired Cloud Storage state lease can be taken and a live one cannot",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const bucket = yield* stack.deploy(GCP.Storage.Bucket("StateBucket", { forceDestroy: true }));
      const prefix = "lease-expiry";
      const state = yield* makeGcsState({ bucketName: bucket.bucketName, prefix });
      const expiredStage = "expired";
      const heldStage = "held";
      const leaseKey = (stage: string) => `${prefix}/${STACK}/${stage}/__lease__.json`;
      const writer = yield* makeObjectMedia;
      const putLease = (stage: string, expiresAt: number) =>
        writer.upload(bucket.bucketName, {
          name: leaseKey(stage),
          body: JSON.stringify({ token: "foreign", expiresAt }),
          contentType: "application/json",
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
      expect(blocked.message).toContain("another deploy holds the Cloud Storage state lock");

      yield* storage
        .deleteObjects({ bucket: bucket.bucketName, object: leaseKey(heldStage) })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* state.deleteStack({ stack: STACK, stage: expiredStage });
      yield* stack.destroy();
    }),
  { tags, timeout: 120_000 },
);

test.provider(
  "first use creates the state bucket with secure defaults",
  (stack) =>
    Effect.gen(function* () {
      const { project } = yield* GCP.GcpEnvironment.current;
      // A store name unique to this test and stage, so runs never share a
      // bucket.
      const name = `it-${createHash("sha256").update(stack.stage).digest("hex").slice(0, 10)}`;
      const bucketName = createStateBucketName(project, name);
      yield* deleteBucket(bucketName);

      yield* Effect.gen(function* () {
        const state = yield* makeGcsState({ name });
        expect(yield* state.listStacks()).toEqual([]);

        const created = yield* storage.getBuckets({ bucket: bucketName });
        expect(created.iamConfiguration?.uniformBucketLevelAccess?.enabled).toBe(true);
        expect(created.iamConfiguration?.publicAccessPrevention).toBe("enforced");
        expect(created.versioning?.enabled).toBe(true);

        // Uniform access leaves project owners unable to read objects, so
        // the store grants them (and editors) object access.
        const policy = yield* storage.getIamPolicyBuckets({ bucket: bucketName });
        const objectAdmin = policy.bindings?.find(
          (binding) => binding.role === "roles/storage.objectAdmin",
        );
        expect(objectAdmin?.members).toEqual(
          expect.arrayContaining([`projectOwner:${project}`, `projectEditor:${project}`]),
        );

        // Drift is converged on the next first use.
        yield* storage.patchBuckets({
          bucket: bucketName,
          body: { versioning: { enabled: false } },
        });
        const again = yield* makeGcsState({ name });
        expect(yield* again.listStacks()).toEqual([]);
        expect((yield* storage.getBuckets({ bucket: bucketName })).versioning?.enabled).toBe(true);
      }).pipe(Effect.ensuring(deleteBucket(bucketName).pipe(Effect.orDie)));

      const gone = yield* storage.getBuckets({ bucket: bucketName }).pipe(
        Effect.as(false),
        Effect.catchTag("NotFound", () => Effect.succeed(true)),
      );
      expect(gone).toBe(true);
    }),
  { tags, timeout: 120_000 },
);
