/**
 * Binding-diff stability: a deploy with NO changes must produce an all-noop
 * plan for resources that carry bindings — regardless of the binding data's
 * shape and regardless of the state store kind.
 *
 * The engine's default diff marks a resource "update" whenever any of its
 * binding rows compares non-noop (`diffBindings` in Diff.ts), so any
 * asymmetry between what apply persists and what the next plan resolves
 * re-updates every bound resource on every deploy, forever.
 *
 * Two store kinds are exercised:
 *  - the in-memory store used by the engine tests (retains live values), and
 *  - a JSON round-tripping store mirroring every durable store (local file,
 *    S3/R2, HTTP), which serializes state through
 *    `JSON.stringify(encodeState(...))` + `reviveState`.
 */
import { apply } from "@/Apply";
import { provideFreshArtifactStore } from "@/Artifacts";
import * as Output from "@/Output";
import * as Plan from "@/Plan";
import type { ResourceBinding } from "@/Resource";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { encodeState, InMemoryService, reviveState, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import {
  BindingTarget,
  TestLayers,
  TestResource,
  TestResourceHooks,
} from "./test.resources.ts";

const { test } = Test.make({
  providers: TestLayers(),
  state: Layer.effect(
    State,
    Effect.sync(() => InMemoryService({})),
  ),
});

/**
 * In-memory state that JSON round-trips every write, mirroring what durable
 * state stores do to persisted state (function-valued leaves are dropped,
 * `toJSON`-carrying objects — e.g. Effects — are replaced by their JSON
 * form, `undefined` keys vanish).
 */
const jsonRoundTripState = () => {
  const roundTrip = <T>(v: T): T =>
    JSON.parse(JSON.stringify(encodeState(v)), reviveState);
  const store: Record<string, Record<string, Record<string, any>>> = {};
  return Layer.effect(
    State,
    Effect.sync(() =>
      State.of(
        (InMemoryService(store) as Effect.Effect<any>).pipe(
          Effect.map((svc: any) => ({
            ...svc,
            set: (req: any) => svc.set({ ...req, value: roundTrip(req.value) }),
          })),
        ) as any,
      ),
    ),
  );
};

type StoreKind = "in-memory" | "json";

/** Minimal deploy/plan harness over a private state store. */
const makeHarness = (name: string, kind: StoreKind) => {
  // One store per harness, shared across the deploy and the follow-up plan
  // (the layer itself is rebuilt for every Stack.make).
  const store: Record<string, Record<string, Record<string, any>>> = {};
  const stateLayer =
    kind === "json"
      ? jsonRoundTripState()
      : Layer.effect(
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
  ): Effect.Effect<any, any, never> =>
    compile(effect).pipe(
      Effect.flatMap((compiled: any) =>
        Plan.make(compiled).pipe(
          Effect.flatMap(apply),
          Effect.provide(compiled.services),
        ),
      ),
      Effect.provide(Layer.succeed(Stage, "test")),
      provideFreshArtifactStore,
    ) as unknown as Effect.Effect<any, any, never>;
  const plan = (
    effect: Effect.Effect<any, any, any>,
  ): Effect.Effect<any, any, never> =>
    compile(effect).pipe(
      Effect.flatMap((compiled: any) =>
        Plan.make(compiled).pipe(Effect.provide(compiled.services)),
      ),
      Effect.provide(Layer.succeed(Stage, "test")),
      provideFreshArtifactStore,
    ) as unknown as Effect.Effect<any, any, never>;
  return { deploy, plan };
};

const expectAllNoop = (plan: any) => {
  for (const [fqn, node] of Object.entries<any>(plan.resources)) {
    expect(`${fqn}:${node.action}`).toBe(`${fqn}:noop`);
    for (const row of node.bindings ?? []) {
      expect(`${fqn}:${row.sid}:${row.action}`).toBe(`${fqn}:${row.sid}:noop`);
    }
  }
};

/** Each shape deploys once, then asserts the second plan is entirely noop. */
const shapes: Record<string, () => Effect.Effect<any, any, any>> = {
  "PropExpr data": () =>
    Effect.gen(function* () {
      const upstream = yield* TestResource("Upstream", { string: "up-value" });
      const target = yield* BindingTarget("Host", { name: "host" });
      yield* target.bind("Cap", { env: { UPSTREAM: upstream.string } });
      return target;
    }),
  "whole-resource data": () =>
    Effect.gen(function* () {
      const upstream = yield* TestResource("Upstream", { string: "up-value" });
      const target = yield* BindingTarget("Host", { name: "host" });
      yield* target.bind("Cap", {
        env: { NAME: upstream.string },
        resource: upstream,
      } as any);
      return target;
    }),
  "self-referential data": () =>
    Effect.gen(function* () {
      const target = yield* BindingTarget("Host", { name: "host" });
      yield* target.bind("Self", { env: { ME: target.string } });
      return target;
    }),
  "mapped Output data": () =>
    Effect.gen(function* () {
      const upstream = yield* TestResource("Upstream", { string: "up-value" });
      const target = yield* BindingTarget("Host", { name: "host" });
      yield* target.bind("Cap", {
        env: { MAPPED: upstream.string.pipe(Output.map((s) => `${s}-sfx`)) },
      });
      return target;
    }),
  "Effect-valued data": () =>
    Effect.gen(function* () {
      const target = yield* BindingTarget("Host", { name: "host" });
      yield* target.bind("Cap", {
        env: { NAME: Effect.succeed("x") },
      } as any);
      return target;
    }),
  // A tagged Resource class is a function-typed Effect — the standard
  // circular-binding pattern (`env: { WORKER: WorkerClass }`). It passes
  // through plan/apply resolution untouched, and a JSON store persists it
  // via its `toJSON` as an `{"_id":"Effect",...}` relic. Without stripping
  // at the commit boundary, `diffBindings` compares that relic against the
  // live class (stripped to `undefined`) — a phantom "update" on every
  // deploy, forever.
  "class-valued (Effectable) data": () =>
    Effect.gen(function* () {
      const target = yield* BindingTarget("Host", { name: "host" });
      yield* target.bind("Cap", { env: { PEER: TestResource } } as any);
      return target;
    }),
  "Redacted data": () =>
    Effect.gen(function* () {
      const target = yield* BindingTarget("Host", { name: "host" });
      yield* target.bind("Cap", {
        env: { SECRET: Redacted.make("shh") },
      } as any);
      return target;
    }),
  "Duration data": () =>
    Effect.gen(function* () {
      const target = yield* BindingTarget("Host", { name: "host" });
      yield* target.bind("Cap", {
        env: { TIMEOUT: Duration.seconds(30) },
      } as any);
      return target;
    }),
  "mutual bindings": () =>
    Effect.gen(function* () {
      const A = yield* BindingTarget("A", { name: "a" });
      const B = yield* BindingTarget("B", { name: "b" });
      yield* A.bind("FromB", { env: { PEER: B.string } });
      yield* B.bind("FromA", { env: { PEER: A.string } });
      return { A, B };
    }),
};

for (const kind of ["in-memory", "json"] as StoreKind[]) {
  describe(`no-change redeploy is all-noop (${kind} state)`, () => {
    for (const [shape, program] of Object.entries(shapes)) {
      test(
        shape,
        Effect.gen(function* () {
          const { deploy, plan } = makeHarness(
            `bind-${kind}-${shape.replaceAll(/[^a-zA-Z0-9]/g, "-")}`,
            kind,
          );
          yield* deploy(program());
          expectAllNoop(yield* plan(program()));
        }),
      );
    }
  });
}

describe("binding rows are deterministically ordered", () => {
  // Bindings are registered by concurrently-built layers doing real IO before
  // `host.bind`, so registration order is not stable across deploys. The
  // engine sorts rows by sid at every boundary (dedupeBindings/diffBindings)
  // so provider diff/reconcile inputs and persisted state never churn on a
  // registration-order flip.
  test(
    "a registration-order flip stays noop and providers observe sorted rows",
    Effect.gen(function* () {
      const { deploy, plan } = makeHarness("bind-order", "in-memory");

      const program = (flipped: boolean) =>
        Effect.gen(function* () {
          const target = yield* BindingTarget("Host", { name: "host" });
          const bindA = target.bind("CapA", { env: { A: "1" } });
          const bindB = target.bind("CapB", { env: { B: "2" } });
          if (flipped) {
            yield* bindB;
            yield* bindA;
          } else {
            yield* bindA;
            yield* bindB;
          }
          return target;
        });

      yield* deploy(program(false));

      const observed: ResourceBinding[][] = [];
      const p: any = yield* plan(program(true)).pipe(
        Effect.provide(
          Layer.succeed(TestResourceHooks, {
            diff: (_id, newBindings) =>
              Effect.sync(() => void observed.push(newBindings)),
          }),
        ),
      );

      expectAllNoop(p);
      // The provider's diff observed the sid-sorted row order even though
      // registration order was flipped between deploys.
      expect(observed.length).toBeGreaterThan(0);
      for (const rows of observed) {
        expect(rows.map((r) => r.sid)).toEqual(["CapA", "CapB"]);
      }
      // The plan node's rows are sorted too.
      expect(p.resources.Host.bindings.map((r: any) => r.sid)).toEqual([
        "CapA",
        "CapB",
      ]);
    }),
  );
});

describe("persisted binding rows are plain data", () => {
  // Mirror of the "interrupted create persists no unresolved Output exprs"
  // apply test, for bindings: even non-terminal commits must not persist live
  // Output proxies or Effect leaves into the state store.
  test(
    "terminal state holds no live Effect leaves in binding data",
    Effect.gen(function* () {
      const store: Record<string, any> = {};
      const stateLayer = Layer.effect(
        State,
        Effect.sync(() => InMemoryService(store)),
      );
      const program = Effect.gen(function* () {
        const target = yield* BindingTarget("Host", { name: "host" });
        yield* target.bind("Cap", {
          env: { PEER: TestResource, NAME: Effect.succeed("x") },
        } as any);
        return target;
      });
      yield* (program as unknown as Effect.Effect<any, any, never>).pipe(
        Stack.make({
          name: "bind-plain",
          providers: TestLayers() as Layer.Layer<any, never, any>,
          state: stateLayer,
        }),
        Effect.flatMap((compiled: any) =>
          Plan.make(compiled).pipe(
            Effect.flatMap(apply),
            Effect.provide(compiled.services),
          ),
        ),
        Effect.provide(Layer.succeed(Stage, "test")),
        provideFreshArtifactStore,
      ) as unknown as Effect.Effect<any, any, never>;

      const persisted = store["bind-plain"].test.Host;
      const hasLiveEffect = (value: unknown): boolean => {
        if (Effect.isEffect(value)) return true;
        if (Array.isArray(value)) return value.some(hasLiveEffect);
        if (value && typeof value === "object") {
          return Object.values(value).some(hasLiveEffect);
        }
        return false;
      };
      expect(hasLiveEffect(persisted.bindings)).toBe(false);
    }),
  );
});
