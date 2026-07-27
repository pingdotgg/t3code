/**
 * Destroy robustness: a destroy (or the GC phase of a deploy) must delete
 * everything it can, aggregate every failure, and never let one bad row
 * block the rest of the teardown.
 *
 *  - a failing provider `delete` must not interrupt sibling deletions
 *  - an upstream's delete is skipped (state retained) when a dependent fails
 *  - a "zombie" state row whose resource type has no registered provider
 *    (the type was removed/renamed without an alias) is FATAL at plan time:
 *    the plan dies with a typed `MissingProviderError` and nothing is
 *    deployed or destroyed — the program and state disagree, and without
 *    the provider the row cannot be deleted anyway
 *  - an attr-less row whose `read` recovery fails must not block siblings
 */
import { MissingProviderError } from "@/Provider";
import { Stack } from "@/Stack";
import { State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  TestLayers,
  TestResource,
  TestResourceHooks,
} from "./test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

const getState = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return yield* state.get({ stack: stk.name, stage: stk.stage, fqn });
});

const clearState = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  yield* state.delete({ stack: stk.name, stage: stk.stage, fqn });
});

const seed = Effect.fn(function* (fqn: string, value: ResourceState) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  yield* state.set({ stack: stk.name, stage: stk.stage, fqn, value });
});

const instanceId = "852f6ec2e19b66589825efe14dca2971";

const hooks = (impl: {
  delete?: (id: string) => Effect.Effect<void, any>;
  read?: (id: string) => Effect.Effect<any, any>;
}): Layer.Layer<TestResourceHooks> => Layer.succeed(TestResourceHooks, impl);

const failsWith = (exit: Exit.Exit<unknown, unknown>, tag: string): boolean =>
  Exit.isFailure(exit) &&
  exit.cause.reasons.some(
    (r) =>
      Cause.isFailReason(r) &&
      (r.error as { _tag?: string } | undefined)?._tag === tag,
  );

describe("destroy aggregates failures", () => {
  test.provider(
    "a failing delete does not interrupt sibling deletions",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("A", { string: "a" });
            yield* TestResource("B", { string: "b" });
            yield* TestResource("C", { string: "c" });
          }),
        );

        const exit = yield* stack.destroy().pipe(
          Effect.provide(
            hooks({
              delete: (id) =>
                id === "A"
                  ? Effect.fail(new Error("A refuses to die"))
                  : id === "B"
                    ? // Slow sibling: before aggregation, A's failure
                      // interrupted B mid-delete and left its row behind.
                      Effect.sleep("150 millis")
                    : Effect.void,
            }),
          ),
          Effect.exit,
        );

        // The destroy still fails overall...
        expect(Exit.isFailure(exit)).toBe(true);
        // ...but every deletable resource was deleted.
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
        // The failed row keeps its state for the next attempt.
        expect((yield* getState("A"))?.status).toBe("deleting");
      }),
  );

  test.provider(
    "an upstream's delete is skipped when a dependent fails",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            const a = yield* TestResource("A", { string: "a" });
            yield* TestResource("B", { string: a.string });
          }),
        );

        const deleted: string[] = [];
        const exit = yield* stack.destroy().pipe(
          Effect.provide(
            hooks({
              delete: (id) =>
                id === "B"
                  ? Effect.fail(new Error("B refuses to die"))
                  : Effect.sync(() => void deleted.push(id)),
            }),
          ),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        // A still has a dependent in the cloud — its physical delete must
        // not have been attempted and its state must be retained.
        expect(deleted).not.toContain("A");
        expect(yield* getState("A")).toBeDefined();
        expect(yield* getState("B")).toBeDefined();
      }),
  );

  test.provider(
    "an attr-less row with failing read recovery does not block siblings",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("A", { string: "a" });
          }),
        );
        // An interrupted create: `creating` with no attr snapshot.
        yield* seed("Zombie", {
          instanceId,
          providerVersion: 0,
          logicalId: "Zombie",
          fqn: "Zombie",
          namespace: undefined,
          resourceType: "Test.TestResource",
          status: "creating",
          props: { string: "z" },
          attr: undefined,
          bindings: [],
          downstream: [],
        });

        const exit = yield* stack.destroy().pipe(
          Effect.provide(
            hooks({
              read: () => Effect.fail(new Error("read exploded")),
              // Slow sibling so a fail-fast interruption would be observable.
              delete: () => Effect.sleep("150 millis"),
            }),
          ),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* getState("A")).toBeUndefined();
        // The unrecoverable row is retained, not silently dropped.
        expect(yield* getState("Zombie")).toBeDefined();
      }),
  );
});

describe("zombie rows (no registered provider)", () => {
  const ghostRow = (fqn: string): ResourceState => ({
    instanceId,
    providerVersion: 0,
    logicalId: fqn,
    fqn,
    namespace: undefined,
    resourceType: "Test.Vanished",
    status: "created",
    props: { name: "ghost" },
    attr: { name: "ghost" },
    bindings: [],
    downstream: [],
  });

  const diesWithMissingProvider = (
    exit: Exit.Exit<unknown, unknown>,
  ): MissingProviderError | undefined => {
    if (!Exit.isFailure(exit)) return undefined;
    const reason = exit.cause.reasons.find(
      (r) => Cause.isDieReason(r) && r.defect instanceof MissingProviderError,
    );
    return reason && Cause.isDieReason(reason)
      ? (reason.defect as MissingProviderError)
      : undefined;
  };

  test.provider("destroy dies at plan time and destroys nothing", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* TestResource("A", { string: "a" });
        }),
      );
      yield* seed("Ghost", ghostRow("Ghost"));

      const exit = yield* stack.destroy().pipe(Effect.exit);

      const defect = diesWithMissingProvider(exit);
      expect(defect?.resourceType).toBe("Test.Vanished");
      expect(defect?.fqn).toBe("Ghost");
      // Fatal at plan time: NOTHING was destroyed — A's state is intact.
      expect((yield* getState("A"))?.status).toBe("created");
      expect(yield* getState("Ghost")).toBeDefined();

      // Remediation path: clear the zombie row (as the error message
      // instructs), then destroy proceeds normally.
      yield* clearState("Ghost");
      yield* stack.destroy();
      expect(yield* getState("A")).toBeUndefined();
    }),
  );

  test.provider(
    "a deploy with a zombie orphan dies at plan time and applies nothing",
    (stack) =>
      Effect.gen(function* () {
        yield* seed("Ghost", ghostRow("Ghost"));

        const exit = yield* stack
          .deploy(
            Effect.gen(function* () {
              const a = yield* TestResource("A", { string: "a" });
              return a.string;
            }),
          )
          .pipe(Effect.exit);

        expect(diesWithMissingProvider(exit)?.resourceType).toBe(
          "Test.Vanished",
        );
        // Fatal at plan time: the program was NOT applied.
        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("Ghost")).toBeDefined();

        yield* clearState("Ghost");
      }),
  );
});
