import * as Cloudflare from "@/Cloudflare";
import { STATE_STORE_VERSION } from "@/Cloudflare/StateStore/Api.ts";
import { State } from "@/State/State.ts";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
/**
 * Live-API tests for the deployed Cloudflare State Store at
 * `alchemy-state-store`. The State service is wired up via
 * `Cloudflare.state()` so each test body just `yield* State` and
 * exercises the typed interface — same code path users hit in
 * production.
 *
 * Tests share a single (stack, stage) pair so they can be reasoned
 * about as a sequence: the first test wipes the namespace, the
 * remainder build state up and tear it down.
 */

const STACK = "alchemy_tests";
const STAGE = "alchemy_tests";

const { test } = Test.make({
  providers: Cloudflare.providers(),
  state: Cloudflare.state(),
});

const sampleState = (fqn: string, instanceId: string) => ({
  kind: "resource" as const,
  resourceType: "Test.Resource",
  namespace: undefined,
  fqn,
  logicalId: fqn.split("/").pop()!,
  instanceId,
  providerVersion: 1,
  status: "created" as const,
  downstream: [],
  bindings: [],
  props: { hello: "world" },
  attr: { id: instanceId },
});

const replacedState = (fqn: string) => ({
  kind: "resource" as const,
  resourceType: "Test.Resource",
  namespace: undefined,
  fqn,
  logicalId: fqn.split("/").pop()!,
  instanceId: "replaced-new",
  providerVersion: 1,
  status: "replaced" as const,
  downstream: [],
  bindings: [],
  deleteFirst: false,
  props: { hello: "world-new" },
  attr: { id: "replaced-new" },
  old: {
    kind: "resource",
    resourceType: "Test.Resource",
    namespace: undefined,
    fqn,
    logicalId: fqn.split("/").pop()!,
    instanceId: "replaced-old",
    providerVersion: 1,
    status: "created",
    downstream: [],
    bindings: [],
    props: { hello: "world-old" },
    attr: { id: "replaced-old" },
  },
});

// These cases share a single (stack, stage) namespace and are written to be
// read as one sequence (first case wipes it, the rest build it up and tear it
// down). They must run serially under the global concurrent test config.
describe.sequential("State", () => {
  test(
    "getVersion returns the current STATE_STORE_VERSION",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const version = yield* store.getVersion();
      expect(version).toBe(STATE_STORE_VERSION);
    }),
    { timeout: 60_000 },
  );

  test(
    "DELETE /state/stacks/:stack wipes the test namespace (cleanup)",
    Effect.gen(function* () {
      const store = yield* yield* State;
      yield* store.deleteStack({ stack: STACK });
      const fqns = yield* store.list({ stack: STACK, stage: STAGE });
      expect(fqns).toEqual([]);
    }),
    { timeout: 60_000 },
  );

  test(
    "PUT /resources/:fqn (setState) persists a resource",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const fqn = "stack/scope/resource-a";
      const value = sampleState(fqn, "inst-a");
      const echoed = yield* store.set({
        stack: STACK,
        stage: STAGE,
        fqn,
        value,
      });
      expect(echoed.fqn).toBe(fqn);
      expect(echoed.instanceId).toBe("inst-a");
    }),
    { timeout: 60_000 },
  );

  test(
    "GET /resources/:fqn (getState) reads back the persisted value",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const fqn = "stack/scope/resource-a";
      const got = yield* store.get({ stack: STACK, stage: STAGE, fqn });
      expect(got).toBeDefined();
      expect(got!.fqn).toBe(fqn);
      expect((got as any).props).toEqual({ hello: "world" });
    }),
    { timeout: 60_000 },
  );

  test(
    "GET /resources/:fqn returns undefined for a missing fqn",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const got = yield* store.get({
        stack: STACK,
        stage: STAGE,
        fqn: "stack/scope/does-not-exist",
      });
      expect(got).toBeUndefined();
    }),
    { timeout: 60_000 },
  );

  test(
    "GET /resources (listResources) returns the FQNs in the stage",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const fqnB = "stack/scope/resource-b";
      yield* store.set({
        stack: STACK,
        stage: STAGE,
        fqn: fqnB,
        value: sampleState(fqnB, "inst-b"),
      });
      const fqns = yield* store.list({ stack: STACK, stage: STAGE });
      expect([...fqns].sort()).toEqual([
        "stack/scope/resource-a",
        "stack/scope/resource-b",
      ]);
    }),
    { timeout: 60_000 },
  );

  test(
    "GET /stacks (listStacks) includes the registered test stack",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const stacks = yield* store.listStacks();
      expect(stacks).toContain(STACK);
    }),
    { timeout: 60_000 },
  );

  test(
    "GET /stacks/:stack/stages (listStages) includes the test stage",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const stages = yield* store.listStages(STACK);
      expect([...stages]).toContain(STAGE);
    }),
    { timeout: 60_000 },
  );

  test(
    "PUT /output (setStackOutput) persists a stack output",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const out = yield* store.setOutput({
        stack: STACK,
        stage: STAGE,
        value: { url: "https://example.com", count: 42 },
      });
      expect(out).toEqual({ url: "https://example.com", count: 42 });
    }),
    { timeout: 60_000 },
  );

  test(
    "GET /output (getStackOutput) reads back the persisted output",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const out = yield* store.getOutput({ stack: STACK, stage: STAGE });
      expect(out).toEqual({ url: "https://example.com", count: 42 });
    }),
    { timeout: 60_000 },
  );

  test(
    "GET /output returns undefined for an un-deployed stage",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const out = yield* store.getOutput({
        stack: STACK,
        stage: "never-deployed",
      });
      expect(out).toBeUndefined();
    }),
    { timeout: 60_000 },
  );

  test(
    "GET /replaced-resources (getReplacedResources) returns status===replaced rows",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const fqn = "stack/scope/resource-replaced";
      yield* store.set({
        stack: STACK,
        stage: STAGE,
        fqn,
        value: replacedState(fqn) as any,
      });
      const replaced = yield* store.getReplacedResources({
        stack: STACK,
        stage: STAGE,
      });
      const fqns = replaced.map((r) => (r as any).fqn);
      expect(fqns).toContain(fqn);
    }),
    { timeout: 60_000 },
  );

  test(
    "DELETE /resources/:fqn (deleteState) removes a single resource",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const fqn = "stack/scope/resource-a";
      yield* store.delete({ stack: STACK, stage: STAGE, fqn });
      const got = yield* store.get({ stack: STACK, stage: STAGE, fqn });
      expect(got).toBeUndefined();
      const fqns = yield* store.list({ stack: STACK, stage: STAGE });
      expect([...fqns]).not.toContain(fqn);
    }),
    { timeout: 60_000 },
  );

  test(
    "DELETE /stacks/:stack?stage=... clears one stage but leaves the stack registered",
    Effect.gen(function* () {
      const store = yield* yield* State;
      yield* store.deleteStack({ stack: STACK, stage: STAGE });
      const fqns = yield* store.list({ stack: STACK, stage: STAGE });
      expect(fqns).toEqual([]);
      const out = yield* store.getOutput({ stack: STACK, stage: STAGE });
      expect(out).toBeUndefined();
      // Per Api.ts: stage-scoped deletes do NOT unregister the stack.
      const stacks = yield* store.listStacks();
      expect(stacks).toContain(STACK);
    }),
    { timeout: 60_000 },
  );

  test(
    "DELETE /stacks/:stack (no stage) removes the stack from listStacks",
    Effect.gen(function* () {
      const store = yield* yield* State;
      yield* store.deleteStack({ stack: STACK });
      const stacks = yield* store.listStacks();
      expect(stacks).not.toContain(STACK);
    }),
    { timeout: 60_000 },
  );

  /**
   * Stress test for transient `setState` failures (the reported 415 / etc.
   * symptoms). 100 sequential PUTs against the same `(stack, stage, fqn)`
   * — if the worker is racy under repeated writes (cold-start layer
   * memoization, edge propagation, intermediary content-type munging)
   * one of these calls should surface it.
   */
  test(
    "setState 100x sequential — surfaces transient failures",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const stack = STACK;
      const stage = `${STAGE}-stress-seq`;
      const fqn = "stack/scope/stress-seq";

      yield* store.deleteStack({ stack, stage });

      yield* Effect.forEach(
        Array.from({ length: 100 }, (_, i) => i),
        (i) =>
          store
            .set({
              stack,
              stage,
              fqn,
              value: sampleState(fqn, `inst-${i}`),
            })
            .pipe(Effect.asVoid),
        { discard: true },
      );

      const got = yield* store.get({ stack, stage, fqn });
      expect(got).toBeDefined();
      expect((got as any).instanceId).toBe("inst-99");

      yield* store.deleteStack({ stack, stage });
    }),
    { timeout: 300_000 },
  );

  /**
   * Same shape as the sequential stress test, but fires all 100 PUTs
   * concurrently. Designed to catch races inside the Durable Object
   * (`Store.getByName(stack)`) and the HttpApiBuilder layer
   * initialization that wouldn't show up serially.
   */
  test(
    "setState 100x concurrent — surfaces racy transient failures",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const stack = STACK;
      const stage = `${STAGE}-stress-par`;

      yield* store.deleteStack({ stack, stage });

      yield* Effect.forEach(
        Array.from({ length: 100 }, (_, i) => i),
        (i) => {
          const fqn = `stack/scope/stress-par-${i}`;
          return store
            .set({
              stack,
              stage,
              fqn,
              value: sampleState(fqn, `inst-${i}`),
            })
            .pipe(Effect.asVoid);
        },
        { concurrency: "unbounded", discard: true },
      );

      const fqns = yield* store.list({ stack, stage });
      expect(fqns.length).toBe(100);

      yield* store.deleteStack({ stack, stage });
    }),
    { timeout: 300_000 },
  );

  /**
   * Engine-shape traffic pattern: for each resource, the apply loop reads
   * the previous state (`GET /resources/:fqn`) and then writes the new
   * state (`PUT /resources/:fqn`). When the engine deploys many
   * resources in parallel, the worker sees interleaved GET+PUT pairs
   * sharing the same connection / isolate.
   *
   * The 30×5 shape (30 sequential batches, 5 GET+PUT pairs in flight per
   * batch) reproduces a transient 415 the engine surfaces under that
   * pattern. The test fails on the first non-2xx so any regression of
   * the underlying issue is caught immediately.
   */
  test(
    "GET+PUT interleaved 30x5 — engine traffic pattern",
    Effect.gen(function* () {
      const store = yield* yield* State;
      const stack = STACK;
      const stage = `${STAGE}-interleaved`;

      yield* store.deleteStack({ stack, stage });

      yield* Effect.forEach(
        Array.from({ length: 30 }, (_, b) => b),
        (b) =>
          Effect.forEach(
            Array.from({ length: 5 }, (_, i) => `M${b}_${i}`),
            (fqn) =>
              Effect.all(
                [
                  store.get({ stack, stage, fqn }).pipe(Effect.asVoid),
                  store
                    .set({
                      stack,
                      stage,
                      fqn,
                      value: sampleState(fqn, `inst-${fqn}`),
                    })
                    .pipe(Effect.asVoid),
                ],
                { concurrency: "unbounded", discard: true },
              ),
            { concurrency: "unbounded", discard: true },
          ),
        { discard: true },
      );

      const fqns = yield* store.list({ stack, stage });
      expect(fqns.length).toBe(30 * 5);

      yield* store.deleteStack({ stack, stage });
    }),
    { timeout: 300_000 },
  );
});
