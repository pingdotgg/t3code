import { describe, expect, test } from "@alchemy.run/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import { Action } from "@/Action";
import * as Alchemist from "@/Alchemist/index.ts";
import { Stack } from "@/index.ts";
import { inMemoryState } from "@/State/index.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

type Output = { readonly url: string };

const stack = Stack(
  "AlchemistRuntime",
  { providers: Layer.empty, state: inMemoryState() },
  Effect.succeed({ url: "https://example.com" } as Output),
);

const run = <A, E>(program: Effect.Effect<A, E, Alchemist.Services | Scope.Scope>) =>
  Effect.runPromise(program.pipe(Effect.provide(Alchemist.layer()), Effect.scoped));

describe("Alchemist runtime", { tags: ["unit", "local"] }, () => {
  test("deploys and destroys a stack value under Alchemist.layer() alone", async () => {
    // Each operation closes its own scope, releasing the stage's lease.
    const program = Effect.gen(function* () {
      const output = yield* Effect.scoped(
        Effect.flatMap(
          Alchemist.plan({ stack, operation: "deploy", stage: "test" }),
          Alchemist.apply,
        ),
      );
      const changes = yield* Effect.scoped(
        Effect.gen(function* () {
          const destroy = yield* Alchemist.plan({ stack, operation: "destroy", stage: "test" });
          yield* Alchemist.apply(destroy);
          return Alchemist.hasChanges(destroy);
        }),
      );
      return { output, changes };
    });
    const runnable: Effect.Effect<unknown, unknown, never> = program.pipe(
      Effect.provide(Alchemist.layer()),
    );
    expect(await Effect.runPromise(runnable)).toEqual({
      output: { url: "https://example.com" },
      changes: false,
    });
  });

  test("destroy and drift never run the stack's program", async () => {
    let runs = 0;
    const counted = Stack(
      "AlchemistProgramRuns",
      { providers: Layer.empty, state: inMemoryState() },
      Effect.sync(() => ++runs),
    );
    await run(
      Effect.gen(function* () {
        yield* Effect.scoped(
          Effect.flatMap(
            Alchemist.plan({ stack: counted, operation: "deploy", stage: "test" }),
            Alchemist.apply,
          ),
        );
        yield* Effect.scoped(
          Effect.flatMap(
            Alchemist.Drift.scan({ stack: counted, stage: "test" }),
            Alchemist.Drift.execute,
          ),
        );
        yield* Effect.scoped(
          Effect.flatMap(
            Alchemist.plan({ stack: counted, operation: "destroy", stage: "test" }),
            Alchemist.apply,
          ),
        );
      }),
    );
    expect(runs).toBe(1);
  });

  test("apply reports to its own subscriber, and actions count as changes", async () => {
    const Sync = Action("Sync", (_: { n: number }) => Effect.succeed({ ok: true }));
    const withAction = Stack(
      "AlchemistActionOnly",
      { providers: Layer.empty, state: inMemoryState() },
      Effect.gen(function* () {
        yield* Sync({ n: 1 });
        return {};
      }),
    );
    const seen: Array<string> = [];
    const changes = await run(
      Effect.gen(function* () {
        // Planned under one subscriber, applied under another: the plan's
        // captured services must not carry the planning loggers along.
        const plan = yield* Alchemist.plan({
          stack: withAction,
          operation: "deploy",
          stage: "test",
        }).pipe(Alchemist.onEvent(() => Effect.void));
        yield* Alchemist.apply(plan).pipe(
          Alchemist.onEvent((event) => Effect.sync(() => seen.push(event.type))),
        );
        return Alchemist.hasChanges(plan);
      }),
    );
    expect(changes).toBe(true);
    expect(seen).toContain("apply.resource.status");
  });

  test("infers the deploy output from the stack and selection", () => {
    const full = Alchemist.plan({ stack, operation: "deploy", stage: "prod" });
    const included = Alchemist.plan({
      stack,
      operation: "deploy",
      stage: "prod",
      include: ["Branch"],
    });
    const excluded = Alchemist.plan({
      stack,
      operation: "deploy",
      stage: "prod",
      exclude: ["Other"],
    });
    const optional = (options: Alchemist.PlanOptions) => Alchemist.plan({ ...options, stack });
    const fullApply = Effect.flatMap(full, Alchemist.apply);
    const includedApply = Effect.flatMap(included, Alchemist.apply);
    const destroyApply = Effect.flatMap(
      Alchemist.plan({ stack, operation: "destroy", stage: "prod" }),
      Alchemist.apply,
    );

    type PlanOutput<T> =
      T extends Effect.Effect<Alchemist.StackPlan<infer O>, any, any> ? O : never;
    const assertions: [
      Equal<PlanOutput<typeof full>, Output>,
      Equal<PlanOutput<typeof included>, undefined>,
      Equal<PlanOutput<typeof excluded>, undefined>,
      Equal<PlanOutput<ReturnType<typeof optional>>, Output | undefined>,
      Equal<Effect.Success<typeof fullApply>, Output>,
      Equal<Effect.Success<typeof includedApply>, undefined>,
      Equal<Effect.Success<typeof destroyApply>, undefined>,
    ] = [true, true, true, true, true, true, true];
    expect(assertions.every(Boolean)).toBe(true);
  });
});
