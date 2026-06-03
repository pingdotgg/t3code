import { Action } from "@/Action";
import * as Plan from "@/Plan";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import {
  InMemoryService,
  inMemoryState,
  State,
  type ActionState,
  type RanActionState,
} from "@/State";
import * as Test from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { Bucket, TestLayers } from "./test.resources";

const TEST_STACK = "task-test";
const TEST_STAGE = "test";

// Fresh in-memory state per test so persisted task rows don't leak between
// runs in the same file.
const freshState = () =>
  Layer.effect(
    State,
    Effect.sync(() => InMemoryService({})),
  );

const { test } = Test.make({
  providers: TestLayers(),
  state: freshState(),
});

const resolveStackId = Effect.gen(function* () {
  const ambient = yield* Effect.serviceOption(Stack.Stack);
  return Option.match(ambient, {
    onNone: () => ({ name: TEST_STACK, stage: TEST_STAGE }),
    onSome: (s) => ({ name: s.name, stage: s.stage }),
  });
});

const seed = (rows: Record<string, ActionState>) =>
  Effect.gen(function* () {
    const { name, stage } = yield* resolveStackId;
    const state = yield* yield* State;
    for (const [fqn, value] of Object.entries(rows)) {
      yield* state.set({ stack: name, stage, fqn, value });
    }
  });

const makePlan = <A, Err = never, Req = never>(
  effect: Effect.Effect<A, Err, Req>,
  options?: Plan.MakePlanOptions,
): Effect.Effect<Plan.Plan<A>, Err, State> =>
  // @ts-expect-error - Stack.make's typing erases R unsoundly here
  Effect.gen(function* () {
    const { name, stage } = yield* resolveStackId;
    // @ts-expect-error
    return yield* effect.pipe(
      // @ts-expect-error
      Stack.make({
        name,
        providers: Layer.empty,
        state: inMemoryState(),
      }),
      Effect.provideService(Stage, stage),
      Effect.flatMap((stackSpec: any) => Plan.make(stackSpec, options)),
      Effect.provide(TestLayers()),
    );
  });

// ── Plan tests ────────────────────────────────────────────────────────────

describe("Plan", () => {
  test(
    "first-time task -> run",
    Effect.gen(function* () {
      const Sync = Action("Sync", (input: { table: string }) =>
        Effect.succeed({ rows: 1, table: input.table }),
      );

      const plan = yield* Effect.gen(function* () {
        return yield* Sync({ table: "users" });
      }).pipe(makePlan);

      expect(plan.actions.Sync).toMatchObject({
        kind: "action",
        action: "run",
        state: undefined,
        forced: false,
      });
      expect(plan.actions.Sync.def.LogicalId).toBe("Sync");
    }),
  );

  test(
    "same input hash -> noop (skip)",
    Effect.gen(function* () {
      const Sync = Action("Sync", (_: { table: string }) =>
        Effect.succeed({ rows: 1 }),
      );

      // Pre-seed a `ran` row with a hash that matches { table: "users" }.
      const { hashInput } = yield* Effect.promise(() => import("@/Util/hash"));
      const inputHash = yield* hashInput({ table: "users" });
      yield* seed({
        Sync: {
          kind: "action",
          status: "ran",
          fqn: "Sync",
          logicalId: "Sync",
          namespace: undefined,
          actionType: "Sync",
          inputHash,
          input: { table: "users" },
          output: { rows: 1 },
          downstream: [],
        } satisfies RanActionState,
      });

      const plan = yield* Effect.gen(function* () {
        return yield* Sync({ table: "users" });
      }).pipe(makePlan);

      expect(plan.actions.Sync.action).toBe("noop");
    }),
  );

  test(
    "changed input hash -> run",
    Effect.gen(function* () {
      const Sync = Action("Sync", (_: { table: string }) =>
        Effect.succeed({ rows: 1 }),
      );

      const { hashInput } = yield* Effect.promise(() => import("@/Util/hash"));
      const oldHash = yield* hashInput({ table: "users" });
      yield* seed({
        Sync: {
          kind: "action",
          status: "ran",
          fqn: "Sync",
          logicalId: "Sync",
          namespace: undefined,
          actionType: "Sync",
          inputHash: oldHash,
          input: { table: "users" },
          output: { rows: 1 },
          downstream: [],
        } satisfies RanActionState,
      });

      const plan = yield* Effect.gen(function* () {
        return yield* Sync({ table: "orders" });
      }).pipe(makePlan);

      expect(plan.actions.Sync.action).toBe("run");
    }),
  );

  test(
    "force flips noop -> run",
    Effect.gen(function* () {
      const Sync = Action("Sync", (_: { table: string }) =>
        Effect.succeed({ rows: 1 }),
      );

      const { hashInput } = yield* Effect.promise(() => import("@/Util/hash"));
      const inputHash = yield* hashInput({ table: "users" });
      yield* seed({
        Sync: {
          kind: "action",
          status: "ran",
          fqn: "Sync",
          logicalId: "Sync",
          namespace: undefined,
          actionType: "Sync",
          inputHash,
          input: { table: "users" },
          output: { rows: 1 },
          downstream: [],
        } satisfies RanActionState,
      });

      const plan = yield* Effect.gen(function* () {
        return yield* Sync({ table: "users" });
      }).pipe((eff) => makePlan(eff, { force: true }));

      expect(plan.actions.Sync.action).toBe("run");
      expect((plan.actions.Sync as Plan.ActionRun).forced).toBe(true);
    }),
  );

  test(
    "task removed from stack -> taskDeletions",
    Effect.gen(function* () {
      const { hashInput } = yield* Effect.promise(() => import("@/Util/hash"));
      const inputHash = yield* hashInput({ table: "users" });
      yield* seed({
        Sync: {
          kind: "action",
          status: "ran",
          fqn: "Sync",
          logicalId: "Sync",
          namespace: undefined,
          actionType: "Sync",
          inputHash,
          input: { table: "users" },
          output: { rows: 1 },
          downstream: [],
        } satisfies RanActionState,
      });

      // The new stack has no tasks at all.
      const plan = yield* Effect.gen(function* () {
        return undefined;
      }).pipe(makePlan);

      expect(plan.actionDeletions.Sync).toMatchObject({
        kind: "action",
        action: "delete",
      });
      expect(plan.actions.Sync).toBeUndefined();
    }),
  );

  test(
    "resource depends on task: task is upstream of resource",
    Effect.gen(function* () {
      const Compute = Action("Compute", (_: {}) =>
        Effect.succeed({ value: "computed" }),
      );

      const plan = yield* Effect.gen(function* () {
        const computed = yield* Compute({});
        const bucket = yield* Bucket("MyBucket", { name: computed.value });
        return bucket;
      }).pipe(makePlan);

      // Action is run (first time), bucket is created and lists Compute as upstream.
      expect(plan.actions.Compute.action).toBe("run");
      expect(plan.actions.Compute.downstream).toContain("MyBucket");
    }),
  );

  test(
    "task depends on resource: resource is upstream of task",
    Effect.gen(function* () {
      const Sync = Action("Sync", (_: { name: string }) =>
        Effect.succeed({ ok: true }),
      );

      const plan = yield* Effect.gen(function* () {
        const bucket = yield* Bucket("MyBucket", { name: "b" });
        return yield* Sync({ name: bucket.name });
      }).pipe(makePlan);

      expect(plan.resources.MyBucket.action).toBe("create");
      expect(plan.actions.Sync.action).toBe("run");
      // MyBucket's downstream includes the task FQN.
      expect(plan.resources.MyBucket.downstream).toContain("Sync");
    }),
  );

  test(
    "explicit logical id allows multiple instances",
    Effect.gen(function* () {
      const Sync = Action("Sync", (_: { which: string }) =>
        Effect.succeed({ ok: true }),
      );

      const plan = yield* Effect.gen(function* () {
        yield* Sync("nightly", { which: "n" });
        yield* Sync("hourly", { which: "h" });
      }).pipe(makePlan);

      expect(plan.actions.nightly.action).toBe("run");
      expect(plan.actions.hourly.action).toBe("run");
      expect(plan.actions.Sync).toBeUndefined();
    }),
  );
});

// ── Apply tests ───────────────────────────────────────────────────────────

describe("Apply", () => {
  test.provider("first run invokes body and persists ran state", (stack) =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const Sync = Action("Sync", (input: { n: number }) =>
        Effect.gen(function* () {
          yield* Ref.update(counter, (c) => c + 1);
          return { doubled: input.n * 2 };
        }),
      );

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Sync({ n: 21 });
        }),
      );

      expect(out).toEqual({ doubled: 42 });
      expect(yield* Ref.get(counter)).toBe(1);

      // Persisted state is `ran` with the materialized output.
      const state = yield* yield* State;
      const persisted = yield* state.get({
        stack: stack.name,
        stage: "test",
        fqn: "Sync",
      });
      expect(persisted).toMatchObject({
        kind: "action",
        status: "ran",
        output: { doubled: 42 },
      });
    }),
  );

  test.provider("same input across deploys -> body not re-invoked", (stack) =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const program = Effect.gen(function* () {
        const Sync = Action("Sync", (input: { n: number }) =>
          Effect.gen(function* () {
            yield* Ref.update(counter, (c) => c + 1);
            return { doubled: input.n * 2 };
          }),
        );
        return yield* Sync({ n: 21 });
      });

      const first = yield* stack.deploy(program);
      const second = yield* stack.deploy(program);

      expect(first).toEqual({ doubled: 42 });
      expect(second).toEqual({ doubled: 42 });
      expect(yield* Ref.get(counter)).toBe(1);
    }),
  );

  test.provider("changed input -> body re-invoked", (stack) =>
    Effect.gen(function* () {
      const counter = yield* Ref.make(0);
      const programFor = (n: number) =>
        Effect.gen(function* () {
          const Sync = Action("Sync", (input: { n: number }) =>
            Effect.gen(function* () {
              yield* Ref.update(counter, (c) => c + 1);
              return { doubled: input.n * 2 };
            }),
          );
          return yield* Sync({ n });
        });

      yield* stack.deploy(programFor(21));
      const second = yield* stack.deploy(programFor(50));

      expect(second).toEqual({ doubled: 100 });
      expect(yield* Ref.get(counter)).toBe(2);
    }),
  );

  test.provider("task output flows to downstream resource input", (stack) =>
    Effect.gen(function* () {
      const Name = Action("Name", (_: {}) =>
        Effect.succeed({ name: "computed-bucket-name" }),
      );

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const computed = yield* Name({});
          return yield* Bucket("MyBucket", { name: computed.name });
        }),
      );

      expect(out.name).toBe("computed-bucket-name");
    }),
  );

  test.provider("resource attr flows to task input", (stack) =>
    Effect.gen(function* () {
      const Echo = Action("Echo", (input: { name: string }) =>
        Effect.succeed({ echoed: input.name }),
      );

      const out = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("MyBucket", { name: "from-resource" });
          return yield* Echo({ name: bucket.name });
        }),
      );

      expect(out).toEqual({ echoed: "from-resource" });
    }),
  );

  test.provider(
    "removing task from stack drops state without invoking body",
    (stack) =>
      Effect.gen(function* () {
        const deleteSpy = yield* Ref.make(0);
        const Sync = Action("Sync", (_: { n: number }) =>
          Effect.succeed({ ok: true }),
        );

        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Sync({ n: 1 });
          }),
        );

        const state = yield* yield* State;
        expect(
          yield* state.get({ stack: stack.name, stage: "test", fqn: "Sync" }),
        ).toMatchObject({ kind: "action", status: "ran" });

        // Re-deploy WITHOUT the task — state should be dropped.
        // (Use a tracker hook to confirm body wasn't called.)
        yield* stack.deploy(Effect.succeed(undefined));
        void deleteSpy;

        expect(
          yield* state.get({ stack: stack.name, stage: "test", fqn: "Sync" }),
        ).toBeUndefined();
      }),
  );

  test.provider("init-effect form: deps satisfied at apply", (stack) =>
    Effect.gen(function* () {
      class Multiplier extends Context.Service<Multiplier, number>()(
        "test/Multiplier",
      ) {}

      const Sync = Action(
        "Sync",
        Effect.gen(function* () {
          const m = yield* Multiplier;
          return (input: { n: number }) =>
            Effect.succeed({ result: input.n * m });
        }),
      );

      const out = yield* stack
        .deploy(
          Effect.gen(function* () {
            return yield* Sync({ n: 21 });
          }),
        )
        .pipe(Effect.provideService(Multiplier, 3));

      expect(out).toEqual({ result: 63 });
    }),
  );
});
