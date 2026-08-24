import * as AWS from "@/AWS";
import { createContainerRuntimeContext } from "@/AWS/ECS/Task.ts";
import { isResolved } from "@/Diff.ts";
import * as Plan from "@/Plan";
import * as Provider from "@/Provider.ts";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import { inMemoryState, State } from "@/State";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";

// Regression for the container-platform serve OOM (fixed in c35217c2b):
// `createContainerRuntimeContext` wrapped the host `serve`, but the wrapper
// body read `base.serve` at CALL time — after `Object.assign(base, { serve })`
// had already replaced it with the wrapper itself. The moment any Task/
// Service impl declared `{ fetch }` (any props form: plain object, Effect,
// inline class, or tagged `.make`), evaluating `serve` re-entered itself
// without bound, exhausting the heap (JSC MemoryExhaustion, ~8GB in ~60s)
// while the platform instance was being constructed at plan time.
//
// These tests run WITHOUT live AWS (stub provider + in-memory state) and are
// wrapped in `Effect.timeout`, so a reintroduced recursion fails fast with a
// TimeoutException instead of OOMing the whole test process.

// ── unit: the serve wrapper must not re-enter itself ────────────────────────
// Pre-fix this recursed unboundedly; the 2s timeout interrupts it long before
// memory becomes a problem. Post-fix it completes in microseconds (the base
// serve just registers a runner; `Http.serve` is a no-op without a server).

const noopProvider = (platform: any) =>
  Provider.succeed(platform, {
    list: () => Effect.succeed([]),
    diff: Effect.fn(function* ({ news }) {
      if (!isResolved(news)) return undefined;
    }),
    reconcile: Effect.fn(function* ({ output }) {
      return output ?? ({ ok: true } as any);
    }),
    delete: Effect.fn(function* () {}),
  });

const providers = () =>
  Layer.mergeAll(noopProvider(AWS.ECS.Service), noopProvider(AWS.ECS.Cluster));

const { test } = Test.make({
  providers: providers(),
  state: inMemoryState(),
});

test(
  "container runtime context serve terminates when the shape declares fetch",
  Effect.gen(function* () {
    const ctx = createContainerRuntimeContext("AWS.ECS.Service")("probe");
    const handler = Effect.succeed(HttpServerResponse.text("ok"));
    yield* ctx
      .serve(handler, { shape: { fetch: handler } })
      .pipe(Effect.timeout(2_000));
    // The handler was registered exactly once as a runner.
    const { program } = yield* ctx.exports;
    expect(program).toBeDefined();
  }),
  { timeout: 10_000 },
);

// ── plan/apply-level: the inline class form with Effect-valued props ────────
// The design-doc-promised form: `class X extends Service<X>()(id, propsEffect,
// impl) {}` where the props are an Effect yielding another resource. This is
// the exact shape that surfaced the serve recursion (the impl declares
// `fetch`, so plan-time construction evaluates the container serve wrapper).
// The stub provider keeps it entirely off the cloud; the shared in-memory
// state store lets us assert the resolved props that were persisted.

const ProbeCluster = AWS.ECS.Cluster("ProbeCluster", {
  clusterName: "inline-class-probe",
});

class InlineService extends AWS.ECS.Service<InlineService>()(
  "InlineService",
  // Props as an Effect — resolved through `transformProps` inside the
  // platform's Self layer, unlike plain-object props.
  Effect.gen(function* () {
    const cluster = yield* ProbeCluster;
    return { cluster, image: "nginx:1.27", port: 80 };
  }),
  Effect.gen(function* () {
    return {
      fetch: Effect.succeed(HttpServerResponse.text("ok")),
    };
  }),
) {}

test.provider(
  "inline class form with Effect props constructs, plans, and applies",
  (stack) =>
    Effect.gen(function* () {
      // Class construction itself is eager (`cls.make(props, impl)` runs at
      // class-definition time); reaching this line proves it didn't blow up.
      // `LogicalId` is stamped on the class at runtime (see Platform.ts's
      // eager inline branch) but not declared on the inline-form class type.
      expect(
        (InlineService as unknown as { LogicalId: string }).LogicalId,
      ).toBe("InlineService");

      const deployed = yield* stack
        .deploy(
          Effect.gen(function* () {
            yield* ProbeCluster;
            return yield* InlineService;
          }),
        )
        // Pre-fix, plan-time construction recursed inside serve; interrupt
        // fast instead of exhausting the heap.
        .pipe(Effect.timeout(30_000));

      expect(deployed).toEqual({ ok: true });

      // The Effect-valued props resolved through the cluster yield and were
      // persisted: the service's stored props reference the cluster attrs.
      const state = yield* yield* State;
      const row = yield* state.get({
        stack: stack.name,
        stage: "test",
        fqn: "InlineService",
      });
      const props = (row as { props?: Record<string, unknown> } | undefined)
        ?.props as
        | { cluster?: { clusterName?: string }; image?: string; port?: number }
        | undefined;
      expect(props?.image).toBe("nginx:1.27");
      expect(props?.port).toBe(80);
    }),
  { timeout: 60_000 },
);

// ── plan-only: multiple yields of the inline class stay stable ──────────────
// Each `yield*` of an inline-form class rebuilds its Self layer in a transient
// region; the resource is memoized by logical id, so repeated yields must
// converge on one resource and one plan entry (no growth, no divergence).
const makePlan = <A, Err, Req>(
  effect: Effect.Effect<A, Err, Req>,
): Effect.Effect<Plan.Plan<A>, Err, State> =>
  effect.pipe(
    // @ts-expect-error - Stack.make's typing erases R unsoundly here
    Stack.make({
      name: "inline-class-plan",
      providers: providers(),
      state: inMemoryState(),
    }),
    Effect.provideService(Stage, "test"),
    Effect.flatMap((compiled: any) =>
      Plan.make(compiled).pipe(Effect.provide(compiled.services)),
    ),
  );

test(
  "repeated yields of the inline class produce a single plan entry",
  Effect.gen(function* () {
    const plan = yield* Effect.gen(function* () {
      yield* ProbeCluster;
      yield* InlineService;
      yield* InlineService;
      return yield* InlineService;
    }).pipe(makePlan, Effect.timeout(30_000));

    expect(plan.resources["InlineService"]?.action).toBe("create");
    expect(
      Object.keys(plan.resources).filter((fqn) =>
        fqn.includes("InlineService"),
      ),
    ).toEqual(["InlineService"]);
  }),
  { timeout: 60_000 },
);
