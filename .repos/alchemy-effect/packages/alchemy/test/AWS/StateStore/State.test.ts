import * as AWS from "@/AWS";
import { makeS3State } from "@/AWS";
import type { ResourceState, StateService } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const STACK = "S3StateStoreTestStack";

/**
 * Guaranteed out-of-band cleanup: `deleteStack` is idempotent (list +
 * batched delete), and `Effect.orDie` collapses the finalizer's error
 * channel to `never` so it is a valid `Effect.ensuring` finalizer.
 * Every test pre-cleans AND finalizes with this so a failing assertion
 * can never leave state objects behind in the bucket.
 */
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

test.provider(
  "set/get/list/delete round-trips state through S3",
  () =>
    Effect.gen(function* () {
      const state = yield* makeS3State({ prefix: "test-state" });
      const stage = "round-trip";

      // start from a clean slate (idempotent)
      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        const a = resource("Parent/ResourceA", { value: "a" });
        const b = resource("ResourceB", { value: "b" });

        yield* state.set({ stack: STACK, stage, fqn: a.fqn, value: a });
        yield* state.set({ stack: STACK, stage, fqn: b.fqn, value: b });

        expect(yield* state.get({ stack: STACK, stage, fqn: a.fqn })).toEqual(
          a,
        );
        expect(
          yield* state.get({ stack: STACK, stage, fqn: "does-not-exist" }),
        ).toBeUndefined();

        const fqns = yield* state.list({ stack: STACK, stage });
        expect([...fqns].sort()).toEqual(["Parent/ResourceA", "ResourceB"]);

        expect(yield* state.listStacks()).toContain(STACK);
        expect(yield* state.listStages(STACK)).toContain(stage);

        yield* state.delete({ stack: STACK, stage, fqn: a.fqn });
        expect(
          yield* state.get({ stack: STACK, stage, fqn: a.fqn }),
        ).toBeUndefined();
        // deleting a missing resource is a no-op
        yield* state.delete({ stack: STACK, stage, fqn: a.fqn });

        yield* state.deleteStack({ stack: STACK, stage });
        expect(yield* state.list({ stack: STACK, stage })).toEqual([]);
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
    }),
  { timeout: 120_000 },
);

test.provider(
  "stack outputs are stored separately from resources",
  () =>
    Effect.gen(function* () {
      const state = yield* makeS3State({ prefix: "test-state" });
      const stage = "outputs";

      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        expect(yield* state.getOutput({ stack: STACK, stage })).toBeUndefined();

        yield* state.setOutput({
          stack: STACK,
          stage,
          value: { url: "https://example.com" },
        });
        expect(yield* state.getOutput({ stack: STACK, stage })).toEqual({
          url: "https://example.com",
        });

        // the output bookkeeping object must not leak into list()
        expect(yield* state.list({ stack: STACK, stage })).toEqual([]);

        yield* state.deleteStack({ stack: STACK, stage });
        expect(yield* state.getOutput({ stack: STACK, stage })).toBeUndefined();
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
    }),
  { timeout: 120_000 },
);

test.provider(
  "getReplacedResources returns only replaced resources",
  () =>
    Effect.gen(function* () {
      const state = yield* makeS3State({ prefix: "test-state" });
      const stage = "replaced";

      yield* state.deleteStack({ stack: STACK, stage });

      yield* Effect.gen(function* () {
        const created = resource("Created", { value: "created" });
        const replaced = {
          ...resource("Replaced", { value: "replaced" }),
          status: "replaced",
        } as ResourceState;

        yield* state.set({
          stack: STACK,
          stage,
          fqn: created.fqn,
          value: created,
        });
        yield* state.set({
          stack: STACK,
          stage,
          fqn: replaced.fqn,
          value: replaced,
        });

        const result = yield* state.getReplacedResources({
          stack: STACK,
          stage,
        });
        expect(result.map((r) => r.fqn)).toEqual(["Replaced"]);
      }).pipe(Effect.ensuring(cleanStage(state, stage)));
    }),
  { timeout: 120_000 },
);
