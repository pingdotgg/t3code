/**
 * `--force` must refresh stale bound attributes.
 *
 * A forced deploy upgrades every noop to an update, so each upstream's
 * `reconcile` re-runs and may produce FRESH attributes (that is the point of
 * `--force`: re-converge against real cloud state). Consumers referencing an
 * upstream's attrs — through props or binding data — must therefore observe
 * the forced reconcile's output, not the attribute snapshot persisted in
 * state. Previously `resolveResource` still treated forced-noop upstreams as
 * stable and baked their persisted attrs into consumers' plan props, so a
 * consumer kept stale values even under `--force`.
 */
import { apply } from "@/Apply";
import { provideFreshArtifactStore } from "@/Artifacts";
import * as Plan from "@/Plan";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { InMemoryService, State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { BindingTarget, TestLayers, TestResource } from "./test.resources.ts";

const { test } = Test.make({
  providers: TestLayers(),
  state: Layer.effect(
    State,
    Effect.sync(() => InMemoryService({})),
  ),
});

const STAGE = "test";

const makeHarness = (name: string) => {
  const store: Record<string, Record<string, Record<string, any>>> = {};
  const stateLayer = Layer.effect(
    State,
    Effect.sync(() => InMemoryService(store)),
  );
  const compile = (effect: Effect.Effect<any, any, any>) =>
    (effect as Effect.Effect<any, any, never>).pipe(
      Stack.make({
        name,
        providers: TestLayers() as Layer.Layer<any, never, any>,
        state: stateLayer,
      }),
    );
  const deploy = (
    effect: Effect.Effect<any, any, any>,
    options?: Plan.MakePlanOptions,
  ): Effect.Effect<any, any, never> =>
    compile(effect).pipe(
      Effect.flatMap((compiled: any) =>
        Plan.make(compiled, options).pipe(
          Effect.flatMap(apply),
          Effect.provide(compiled.services),
        ),
      ),
      Effect.provide(Layer.succeed(Stage, STAGE)),
      provideFreshArtifactStore,
    ) as unknown as Effect.Effect<any, any, never>;
  const plan = (
    effect: Effect.Effect<any, any, any>,
    options?: Plan.MakePlanOptions,
  ): Effect.Effect<any, any, never> =>
    compile(effect).pipe(
      Effect.flatMap((compiled: any) =>
        Plan.make(compiled, options).pipe(Effect.provide(compiled.services)),
      ),
      Effect.provide(Layer.succeed(Stage, STAGE)),
      provideFreshArtifactStore,
    ) as unknown as Effect.Effect<any, any, never>;
  const getRow = (fqn: string) =>
    Effect.sync(() => store[name]?.[STAGE]?.[fqn] as ResourceState);
  const setRow = (fqn: string, value: ResourceState) =>
    Effect.sync(() => void (store[name][STAGE][fqn] = value));
  return { deploy, plan, getRow, setRow };
};

describe("--force refreshes stale bound attrs", () => {
  test(
    "a consumer's props observe the forced upstream reconcile, not stale state",
    Effect.gen(function* () {
      const { deploy, getRow, setRow } = makeHarness("force-props");
      const program = Effect.gen(function* () {
        const upstream = yield* TestResource("Upstream", { string: "fresh" });
        const consumer = yield* TestResource("Consumer", {
          string: upstream.string,
        });
        return consumer;
      });

      yield* deploy(program);

      // Simulate drift: the persisted attr snapshot is stale relative to
      // what the provider's reconcile would produce today.
      const row = yield* getRow("Upstream");
      yield* setRow("Upstream", {
        ...row,
        attr: { ...(row.attr as any), string: "stale" },
      } as ResourceState);

      yield* deploy(program, { force: true });

      // The forced upstream reconcile produced "fresh" again...
      expect(((yield* getRow("Upstream")).attr as any).string).toBe("fresh");
      // ...and the consumer observed IT — not the stale persisted snapshot.
      expect(((yield* getRow("Consumer")).attr as any).string).toBe("fresh");
      expect(((yield* getRow("Consumer")).props as any).string).toBe("fresh");
    }),
  );

  test(
    "binding data observes the forced upstream reconcile, not stale state",
    Effect.gen(function* () {
      const { deploy, getRow, setRow } = makeHarness("force-bindings");
      const program = Effect.gen(function* () {
        const upstream = yield* TestResource("Upstream", { string: "fresh" });
        const host = yield* BindingTarget("Host", { name: "host" });
        yield* host.bind("Cap", { env: { UP: upstream.string } });
        return host;
      });

      yield* deploy(program);

      const row = yield* getRow("Upstream");
      yield* setRow("Upstream", {
        ...row,
        attr: { ...(row.attr as any), string: "stale" },
      } as ResourceState);

      yield* deploy(program, { force: true });

      // BindingTarget's reconcile merges binding env into its attrs — the
      // bound value must come from the forced reconcile's fresh output.
      expect(((yield* getRow("Host")).attr as any).env).toEqual({
        UP: "fresh",
      });
      // The persisted binding row carries the fresh payload too.
      expect((yield* getRow("Host")).bindings).toEqual([
        { sid: "Cap", data: { env: { UP: "fresh" } } },
      ]);
    }),
  );

  test(
    "an unforced no-change redeploy stays all-noop (control)",
    Effect.gen(function* () {
      const { deploy, plan } = makeHarness("force-control");
      const program = Effect.gen(function* () {
        const upstream = yield* TestResource("Upstream", { string: "fresh" });
        const host = yield* BindingTarget("Host", { name: "host" });
        yield* host.bind("Cap", { env: { UP: upstream.string } });
        return host;
      });
      yield* deploy(program);

      // The force fix must not destabilize ordinary planning.
      const p: any = yield* plan(program);
      expect(p.resources.Upstream.action).toBe("noop");
      expect(p.resources.Host.action).toBe("noop");

      // And a forced plan upgrades everything to an update.
      const forced: any = yield* plan(program, { force: true });
      expect(forced.resources.Upstream.action).toBe("update");
      expect(forced.resources.Host.action).toBe("update");
    }),
  );
});
