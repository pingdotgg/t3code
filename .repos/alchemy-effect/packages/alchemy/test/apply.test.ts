import { Action } from "@/Action";
import { adopt, AdoptPolicy, OwnedBySomeoneElse, Unowned } from "@/AdoptPolicy";
import { apply, DestroyError } from "@/Apply";
import { isResolved } from "@/Diff";
import * as ProviderLayer from "@/Local/ProviderLayer";
import { Resource } from "@/Resource";
import * as Context from "effect/Context";
import { Cli } from "@/Report.ts";
import * as Namespace from "@/Namespace.ts";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import * as RemovalPolicy from "@/RemovalPolicy.ts";
import { renamedFrom } from "@/Rename.ts";
import { remote } from "@/ProviderMode.ts";
import * as Plan from "@/Plan";
import { Stage } from "@/Stage";
import { Stack, make as makeStack } from "@/Stack";
import {
  type ActionState,
  type CreatingResourceState,
  type ReplacedResourceState,
  type ReplacingResourceState,
  type ResourceState,
  State,
  StateStoreError,
} from "@/State";
import * as Test from "@/Test/Alchemy";
import { assert, describe, expect } from "alchemy-test";
import { Data, Layer } from "effect";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  AliasedWidget,
  aliasedWidgetDeletes,
  aliasedWidgetProvider,
  ArtifactProbe,
  BindingTarget,
  capturedConfigHost,
  CollisionRegistry,
  DeleteFirstResource,
  DeletedBindingRegressionTarget,
  DurationResource,
  FqnProbe,
  Function,
  inDev,
  KindStablesResource,
  ModalResource,
  modalCalls,
  type ModalResourceProps,
  PhasedTarget,
  ProbeBinding,
  StaticStablesResource,
  TestLayers,
  TestResource,
  TestResourceHooks,
  type TestResourceProps,
} from "./test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

const getState = Effect.fn(function* <S = ResourceState>(resourceId: string) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return (yield* state.get({
    stack: stk.name,
    stage: stk.stage,
    fqn: resourceId,
  })) as S;
});
/** The planned action for a logical id, or `undefined` if it isn't planned. */
const actionOfPlan = (plan: any, logicalId: string) =>
  (Object.values(plan.resources) as any[]).find(
    (node: any) => node.resource.LogicalId === logicalId,
  )?.action;

const listState = Effect.fn(function* () {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return yield* state.list({ stack: stk.name, stage: stk.stage });
});

const recordingCli = (events: Array<{ id: string; status: string }>) =>
  Cli.of({
    startPlanningSession: () =>
      Effect.succeed({
        update: () => Effect.void,
        succeed: () => Effect.void,
        fail: () => Effect.void,
        close: Effect.void,
      }),
    approvePlan: () => Effect.succeed(true),
    displayPlan: () => Effect.void,
    startApplySession: () =>
      Effect.succeed({
        done: () => Effect.void,
        emit: (event) =>
          Effect.sync(() => {
            if (event._tag === "apply.resource.status") {
              events.push({ id: event.id, status: event.status });
            }
          }),
      }),
  });

const expectConvergedStatus = (status: ResourceState["status"] | undefined) => {
  expect(["created", "updated"]).toContain(status);
};

// Graceful failure handling means downstream resources of a failed upstream
// may have committed an intermediate "creating"/"replacing" status before
// their `waitForDeps` discovered the upstream failure - or may have fully
// converged using a stable previous output of the failed upstream (e.g. a
// replacement whose old generation is still live). This helper tolerates any
// of those outcomes; the corresponding recovery deploy validates terminal
// state.
const expectNotStarted = (state: ResourceState | undefined) => {
  expect([undefined, "creating", "replacing", "created", "updated"]).toContain(
    state?.status,
  );
};

export class ResourceFailure extends Data.TaggedError("ResourceFailure")<{
  message: string;
}> {
  constructor() {
    super({ message: `Failed to create` });
  }
}

const hook =
  (hooks?: {
    create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
    update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
    delete?: (id: string) => Effect.Effect<void, any>;
    read?: (id: string) => Effect.Effect<any, any>;
  }) =>
  <A, Err, Req>(test: Effect.Effect<A, Err, Req>) =>
    test.pipe(
      Effect.provide(
        Layer.succeed(
          TestResourceHooks,
          hooks ?? {
            create: () => Effect.fail(new ResourceFailure()),
            update: () => Effect.fail(new ResourceFailure()),
            delete: () => Effect.fail(new ResourceFailure()),
            read: () => Effect.succeed(undefined),
          },
        ),
      ),
      // Phase-1 (create/update) failures surface as the raw ResourceFailure;
      // Phase-2 (GC/destroy) delete failures are aggregated into DestroyError.
      // @ts-expect-error - catchTag changes the return type
      Effect.catchTag(["ResourceFailure", "DestroyError"], () =>
        Effect.succeed(true),
      ),
    ) as Effect.Effect<A, Err, Req | State>;

// Helper to fail on specific resource IDs
const failOn = (
  resourceId: string,
  hook: "create" | "update" | "delete",
): {
  create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  delete?: (id: string) => Effect.Effect<void, any>;
} => ({
  [hook]: (id: string) =>
    id === resourceId
      ? Effect.fail(new ResourceFailure())
      : Effect.succeed(undefined),
});

// Helper to fail on multiple resource IDs for different hooks
const failOnMultiple = (
  failures: Array<{ id: string; hook: "create" | "update" | "delete" }>,
): {
  create?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  update?: (id: string, props: TestResourceProps) => Effect.Effect<void, any>;
  delete?: (id: string) => Effect.Effect<void, any>;
} => {
  const createFailures = failures
    .filter((f) => f.hook === "create")
    .map((f) => f.id);
  const updateFailures = failures
    .filter((f) => f.hook === "update")
    .map((f) => f.id);
  const deleteFailures = failures
    .filter((f) => f.hook === "delete")
    .map((f) => f.id);

  return {
    create: (id: string) =>
      createFailures.includes(id)
        ? Effect.fail(new ResourceFailure())
        : Effect.succeed(undefined),
    update: (id: string) =>
      updateFailures.includes(id)
        ? Effect.fail(new ResourceFailure())
        : Effect.succeed(undefined),
    delete: (id: string) =>
      deleteFailures.includes(id)
        ? Effect.fail(new ResourceFailure())
        : Effect.succeed(undefined),
  };
};

describe("Action output convergence", { tags: ["unit", "local"] }, () => {
  for (const consumer of ["prop", "binding"] as const) {
    test.provider(
      `unchanged Action ${consumer} consumers stop reconciling after the first deploy`,
      (stack) =>
        Effect.gen(function* () {
          let runs = 0;
          const reconciled: string[] = [];
          const Compute = Action("Compute", (_: {}) =>
            Effect.sync(() => {
              runs++;
              return { value: "v1" };
            }),
          );
          const program = Effect.gen(function* () {
            const result = yield* Compute({});
            if (consumer === "prop") {
              const host = yield* TestResource("Host", {
                string: result.value,
              });
              return host.string;
            }
            const host = yield* BindingTarget("Host", {});
            yield* host.bind("Result", { env: { RESULT: result.value } });
            return host.env.RESULT;
          });
          yield* Effect.gen(function* () {
            for (const _ of [1, 2, 3]) {
              expect(yield* stack.deploy(program)).toBe("v1");
            }
            expect(runs).toBe(1);
            expect(reconciled).toEqual(["create"]);
            const plan = yield* stack.plan(program);
            expect(actionOfPlan(plan, "Host")).toBe("noop");
          }).pipe(
            Effect.provideService(TestResourceHooks, {
              create: () =>
                Effect.sync(() => {
                  reconciled.push("create");
                }),
              update: () =>
                Effect.sync(() => {
                  reconciled.push("update");
                }),
            }),
          );
        }),
    );
  }

  for (const sameOutput of [false, true]) {
    test.provider(
      `changed Action input ${sameOutput ? "with the same output" : "with a fresh output"} converges after the rerun`,
      (stack) =>
        Effect.gen(function* () {
          let runs = 0;
          const reconciled: (string | undefined)[] = [];
          const Compute = Action("Compute", (input: { revision: string }) =>
            Effect.sync(() => {
              runs++;
              return { value: sameOutput ? "constant" : input.revision };
            }),
          );
          const program = (revision: string) =>
            Effect.gen(function* () {
              const result = yield* Compute({ revision });
              const host = yield* TestResource("Host", {
                string: result.value,
              });
              return host.string;
            });
          const record = (_: string, props: TestResourceProps) =>
            Effect.sync(() => {
              reconciled.push(props.string);
            });
          yield* Effect.gen(function* () {
            expect(yield* stack.deploy(program("v1"))).toBe(
              sameOutput ? "constant" : "v1",
            );
            expect(yield* stack.deploy(program("v2"))).toBe(
              sameOutput ? "constant" : "v2",
            );
            expect(runs).toBe(2);
            if (sameOutput) {
              expect([1, 2]).toContain(reconciled.length);
              expect(reconciled.every((value) => value === "constant")).toBe(
                true,
              );
            } else {
              expect(reconciled).toEqual(["v1", "v2"]);
            }
            const settledCount = reconciled.length;
            expect(actionOfPlan(yield* stack.plan(program("v2")), "Host")).toBe(
              "noop",
            );
            yield* stack.deploy(program("v2"));
            expect(runs).toBe(2);
            expect(reconciled).toHaveLength(settledCount);
          }).pipe(
            Effect.provideService(TestResourceHooks, {
              create: record,
              update: record,
            }),
          );
        }),
    );
  }

  test.provider(
    "changed Action binding data reaches the host before subsequent deploys converge",
    (stack) =>
      Effect.gen(function* () {
        let runs = 0;
        let reconciles = 0;
        const Compute = Action("Compute", (input: { value: string }) =>
          Effect.sync(() => {
            runs++;
            return input;
          }),
        );
        const program = (value: string) =>
          Effect.gen(function* () {
            const result = yield* Compute({ value });
            const host = yield* BindingTarget("Host", {});
            yield* host.bind("Result", { env: { RESULT: result.value } });
            return host.env.RESULT;
          });
        const record = () =>
          Effect.sync(() => {
            reconciles++;
          });
        yield* Effect.gen(function* () {
          expect(yield* stack.deploy(program("v1"))).toBe("v1");
          expect(yield* stack.deploy(program("v2"))).toBe("v2");
          expect(runs).toBe(2);
          expect(reconciles).toBe(2);
          expect(actionOfPlan(yield* stack.plan(program("v2")), "Host")).toBe(
            "noop",
          );
          expect(yield* stack.deploy(program("v2"))).toBe("v2");
          expect(runs).toBe(2);
          expect(reconciles).toBe(2);
        }).pipe(
          Effect.provideService(TestResourceHooks, {
            create: record,
            update: record,
          }),
        );
      }),
  );

  test.provider(
    "Action chains propagate fresh outputs and stop rerunning once unchanged",
    (stack) =>
      Effect.gen(function* () {
        const runs: string[] = [];
        const Compute = Action("Compute", (input: { value: string }) =>
          Effect.sync(() => {
            runs.push(input.value);
            return { value: `${input.value}!` };
          }),
        );
        const program = (value: string) =>
          Effect.gen(function* () {
            const first = yield* Compute("First", { value });
            const second = yield* Compute("Second", { value: first.value });
            const host = yield* Function("Host", {
              env: { RESULT: second.value },
            });
            return host.env.RESULT;
          });
        expect(yield* stack.deploy(program("v1"))).toBe("v1!!");
        expect(yield* stack.deploy(program("v2"))).toBe("v2!!");
        expect(yield* stack.deploy(program("v2"))).toBe("v2!!");
        expect(runs).toEqual(["v1", "v1!", "v2", "v2!"]);
        expect(actionOfPlan(yield* stack.plan(program("v2")), "Host")).toBe(
          "noop",
        );
      }),
  );

  test.provider(
    "binding-only changes to an upstream resource invalidate Action inputs and consumer outputs",
    (stack) =>
      Effect.gen(function* () {
        const seen: string[] = [];
        const Compute = Action("Compute", (input: { value: string }) =>
          Effect.sync(() => {
            seen.push(input.value);
            return input;
          }),
        );
        const program = (value: string) =>
          Effect.gen(function* () {
            const source = yield* BindingTarget("Source", {});
            yield* source.bind("Value", { env: { RESULT: value } });
            const result = yield* Compute({ value: source.env.RESULT });
            const host = yield* Function("Host", {
              env: { RESULT: result.value },
            });
            return host.env.RESULT;
          });
        expect(yield* stack.deploy(program("v1"))).toBe("v1");
        const changed = yield* stack.plan(program("v2"));
        expect(changed.resources.Source.action).toBe("update");
        expect(changed.actions.Compute.action).toBe("run");
        expect(changed.resources.Host.action).toBe("update");
        expect(yield* stack.deploy(program("v2"))).toBe("v2");
        expect(yield* stack.deploy(program("v2"))).toBe("v2");
        expect(seen).toEqual(["v1", "v2"]);
        expect(actionOfPlan(yield* stack.plan(program("v2")), "Host")).toBe(
          "noop",
        );
      }),
  );

  test.provider(
    "an Action planned to run skips its body when upstream resolves to the same input",
    (stack) =>
      Effect.gen(function* () {
        let firstRuns = 0;
        let secondRuns = 0;
        const First = Action("First", (_: { revision: string }) =>
          Effect.sync(() => {
            firstRuns++;
            return { value: "constant" };
          }),
        );
        const Second = Action("Second", (input: { value: string }) =>
          Effect.sync(() => {
            secondRuns++;
            return { value: `${input.value}!` };
          }),
        );
        const program = (revision: string) =>
          Effect.gen(function* () {
            const first = yield* First({ revision });
            const second = yield* Second({ value: first.value });
            const host = yield* Function("Host", {
              env: { RESULT: second.value },
            });
            return host.env.RESULT;
          });
        expect(yield* stack.deploy(program("v1"))).toBe("constant!");
        const changed = yield* stack.plan(program("v2"));
        expect(changed.actions.First.action).toBe("run");
        expect(changed.actions.Second.action).toBe("run");
        expect(yield* stack.deploy(program("v2"))).toBe("constant!");
        expect(firstRuns).toBe(2);
        expect(secondRuns).toBe(1);
        const forced = yield* program("v2").pipe(
          makeStack({
            name: stack.name,
            providers: TestLayers(),
            state: stack.state,
          }),
          Effect.flatMap((spec) =>
            Plan.make(spec, { force: true }).pipe(
              Effect.flatMap(apply),
              Effect.provide(spec.services),
            ),
          ),
          Effect.provideService(Stage, stack.stage),
        );
        expect(forced).toBe("constant!");
        expect(firstRuns).toBe(3);
        expect(secondRuns).toBe(2);
        expect(actionOfPlan(yield* stack.plan(program("v2")), "Host")).toBe(
          "noop",
        );
      }),
  );

  test.provider(
    "changed Action output replaces the whole environment without retaining removed keys",
    (stack) =>
      Effect.gen(function* () {
        const Compute = Action("Compute", (input: { revision: number }) =>
          Effect.succeed<Record<string, string>>(
            input.revision === 1
              ? { KEEP: "old", REMOVE: "old" }
              : { KEEP: "new" },
          ),
        );
        const program = (revision: number) =>
          Effect.gen(function* () {
            const env = yield* Compute({ revision });
            const host = yield* Function("Host", { env });
            return host.env;
          });
        expect(yield* stack.deploy(program(1))).toEqual({
          KEEP: "old",
          REMOVE: "old",
        });
        expect(yield* stack.deploy(program(2))).toEqual({ KEEP: "new" });
        expect(actionOfPlan(yield* stack.plan(program(2)), "Host")).toBe(
          "noop",
        );
      }),
  );

  test.provider(
    "a failed Action rerun blocks its value consumer and recovery uses the new output",
    (stack) =>
      Effect.gen(function* () {
        let fail = false;
        const reconciled: (string | undefined)[] = [];
        const Compute = Action("Compute", (input: { revision: string }) =>
          Effect.gen(function* () {
            if (fail) return yield* Effect.fail(new ResourceFailure());
            return { value: input.revision };
          }),
        );
        const program = (revision: string) =>
          Effect.gen(function* () {
            const result = yield* Compute({ revision });
            const host = yield* TestResource("Host", { string: result.value });
            return host.string;
          });
        const record = (_: string, props: TestResourceProps) =>
          Effect.sync(() => {
            reconciled.push(props.string);
          });
        yield* Effect.gen(function* () {
          expect(yield* stack.deploy(program("v1"))).toBe("v1");
          fail = true;
          const failed = yield* Effect.exit(stack.deploy(program("v2")));
          assert(Exit.isFailure(failed));
          expect(
            failed.cause.reasons.find(Cause.isFailReason)?.error,
          ).toBeInstanceOf(ResourceFailure);
          expect(reconciled).toEqual(["v1"]);
          fail = false;
          expect(yield* stack.deploy(program("v2"))).toBe("v2");
          expect(reconciled).toEqual(["v1", "v2"]);
        }).pipe(
          Effect.provideService(TestResourceHooks, {
            create: record,
            update: record,
          }),
        );
      }),
  );

  for (const value of [undefined, null, false, 0, ""] as const) {
    test.provider(
      `persisted ${String(value)} Action output remains reusable after apply`,
      (stack) =>
        Effect.gen(function* () {
          let runs = 0;
          const Compute = Action("Compute", (_: {}) =>
            Effect.sync(() => {
              runs++;
              return value;
            }),
          );
          const program = Effect.gen(function* () {
            const result = yield* Compute({});
            const host = yield* Function("Host", {
              env: { RESULT: Output.map(result, String) },
            });
            return host.env.RESULT;
          });
          expect(yield* stack.deploy(program)).toBe(String(value));
          expect(yield* stack.deploy(program)).toBe(String(value));
          expect(runs).toBe(1);
          expect(actionOfPlan(yield* stack.plan(program), "Host")).toBe("noop");
        }),
    );
  }

  test.provider(
    "a forced Action rerun publishes fresh output instead of its persisted result",
    (stack) =>
      Effect.gen(function* () {
        let runs = 0;
        const Compute = Action("Compute", (_: {}) =>
          Effect.sync(() => ({ value: String(++runs) })),
        );
        const program = Effect.gen(function* () {
          const result = yield* Compute({});
          const host = yield* Function("Host", {
            env: { RESULT: result.value },
          });
          return host.env.RESULT;
        });
        expect(yield* stack.deploy(program)).toBe("1");
        const forced = yield* program.pipe(
          makeStack({
            name: stack.name,
            providers: TestLayers(),
            state: stack.state,
          }),
          Effect.flatMap((spec) =>
            Plan.make(spec, { force: true }).pipe(
              Effect.flatMap(apply),
              Effect.provide(spec.services),
            ),
          ),
          Effect.provideService(Stage, stack.stage),
        );
        expect(forced).toBe("2");
        expect(yield* stack.deploy(program)).toBe("2");
        expect(runs).toBe(2);
      }),
  );

  test.provider(
    "an Action migration marker in the environment converges without removing its dependency",
    (stack) =>
      Effect.gen(function* () {
        let runs = 0;
        const Compute = Action("Compute", (_: {}) =>
          Effect.sync(() => {
            runs++;
            return { migrated: true };
          }),
        );
        const program = Effect.gen(function* () {
          const result = yield* Compute({});
          const host = yield* Function("Host", {
            name: "host",
            env: { MIGRATION: Output.map(result, JSON.stringify) },
          });
          return host.name;
        });
        expect(yield* stack.deploy(program)).toBe("host");
        expect(yield* stack.deploy(program)).toBe("host");
        expect(runs).toBe(1);
        const plan = yield* stack.plan(program);
        expect(plan.actions.Compute.action).toBe("noop");
        expect(actionOfPlan(plan, "Host")).toBe("noop");
      }),
  );

  for (const operation of ["create", "update", "replace"] as const) {
    test.provider(
      `Action completion precedes bound host ${operation}`,
      (stack) =>
        Effect.gen(function* () {
          const events: string[] = [];
          const Compute = Action("Compute", (_: { revision: string }) =>
            Effect.gen(function* () {
              yield* Effect.yieldNow;
              events.push("action completed");
              return { migrated: true };
            }),
          );
          const program = (revision: string) =>
            Effect.gen(function* () {
              const result = yield* Compute({ revision });
              const host = yield* BindingTarget("Host", {
                string: revision,
                replaceString: operation === "replace" ? revision : "fixed",
              });
              yield* host.bind("Migration", {
                env: { MIGRATION: Output.map(result, JSON.stringify) },
              });
              return host.string;
            });
          const record = () =>
            Effect.sync(() => {
              events.push("host reconciled");
            });
          yield* Effect.gen(function* () {
            if (operation !== "create") yield* stack.deploy(program("v1"));
            events.length = 0;
            expect(actionOfPlan(yield* stack.plan(program("v2")), "Host")).toBe(
              operation,
            );
            expect(yield* stack.deploy(program("v2"))).toBe("v2");
            expect(events).toEqual(["action completed", "host reconciled"]);
          }).pipe(
            Effect.provideService(TestResourceHooks, {
              create: record,
              update: record,
            }),
          );
        }),
    );

    test.provider(`Action failure prevents bound host ${operation}`, (stack) =>
      Effect.gen(function* () {
        let fail = false;
        const reconciled: string[] = [];
        const Compute = Action("Compute", (_: { revision: string }) =>
          fail ? Effect.fail(new ResourceFailure()) : Effect.succeed("done"),
        );
        const program = (revision: string) =>
          Effect.gen(function* () {
            const result = yield* Compute({ revision });
            const host = yield* BindingTarget("Host", {
              string: revision,
              replaceString: operation === "replace" ? revision : "fixed",
            });
            yield* host.bind("Migration", {
              env: { MIGRATION: Output.map(result, JSON.stringify) },
            });
            return host.string;
          });
        const record = (id: string) =>
          Effect.sync(() => {
            reconciled.push(id);
          });
        yield* Effect.gen(function* () {
          if (operation !== "create") yield* stack.deploy(program("v1"));
          reconciled.length = 0;
          fail = true;
          expect(actionOfPlan(yield* stack.plan(program("v2")), "Host")).toBe(
            operation,
          );
          const failed = yield* Effect.exit(stack.deploy(program("v2")));
          assert(Exit.isFailure(failed));
          expect(
            failed.cause.reasons.find(Cause.isFailReason)?.error,
          ).toBeInstanceOf(ResourceFailure);
          expect(reconciled).toEqual([]);
        }).pipe(
          Effect.provideService(TestResourceHooks, {
            create: record,
            update: record,
          }),
        );
      }),
    );
  }
});

// #1831: a changed value read by a Platform's Init must reach the provider,
// even though `CapturedConfigHost`'s diff always returns `noop`.
describe("Platform Init-captured config", { tags: ["unit", "local"] }, () => {
  test.provider("a changed captured value deploys and converges", (stack) =>
    Effect.gen(function* () {
      expect((yield* stack.deploy(capturedConfigHost("a"))).mode).toBe("a");
      expect(
        actionOfPlan(yield* stack.plan(capturedConfigHost("a")), "Host"),
      ).toBe("noop");
      expect((yield* stack.deploy(capturedConfigHost("b"))).mode).toBe("b");
      expect(
        actionOfPlan(yield* stack.plan(capturedConfigHost("b")), "Host"),
      ).toBe("noop");
    }),
  );
});

describe("basic operations", { tags: ["unit", "local"] }, () => {
  test.provider("should create, update, and delete resources", (stack) =>
    Effect.gen(function* () {
      expect(
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string",
          });
          return A.string;
        }).pipe(stack.deploy),
      ).toEqual("test-string");

      expect(
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string-new",
          });
          return A.string;
        }).pipe(stack.deploy),
      ).toEqual("test-string-new");

      yield* stack.destroy();

      expect(yield* getState("A")).toBeUndefined();
      expect(yield* listState()).toEqual([]);
    }),
  );

  test.provider("should resolve output properties", (stack) =>
    Effect.gen(function* () {
      expect(
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string",
            stringArray: ["test-string-array"],
          });
          const B = yield* TestResource("B", {
            string: A.string,
          });
          return B.string;
        }).pipe(stack.deploy),
      ).toEqual("test-string");

      expect(
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string",
            stringArray: ["test-string-array"],
          });
          const B = yield* TestResource("B", {
            string: A.string.pipe(Output.map((string) => string.toUpperCase())),
          });
          return B.string;
        }).pipe(stack.deploy),
      ).toEqual("TEST-STRING");

      expect(
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string",
            stringArray: ["test-string-array"],
          });
          const B = yield* TestResource("B", {
            string: A.string.pipe(
              Output.map((string) => string.toUpperCase() + "-NEW"),
            ),
          });
          return B.string;
        }).pipe(stack.deploy),
      ).toEqual("TEST-STRING-NEW");

      expect(
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string",
            stringArray: ["test-string-array"],
          });
          const B = yield* TestResource("B", {
            string: A.string.pipe(
              Output.flatMap((string) =>
                Output.literal(string.toUpperCase() + "-FLAT"),
              ),
            ),
          });
          return B.string;
        }).pipe(stack.deploy),
      ).toEqual("TEST-STRING-FLAT");
    }),
  );

  test.provider(
    "should apply downstream resources when a stable kind shadows an output discriminator",
    (stack) =>
      Effect.gen(function* () {
        yield* KindStablesResource("Database", {
          value: "v1",
        }).pipe(stack.deploy);

        const output = yield* Effect.gen(function* () {
          const database = yield* KindStablesResource("Database", {
            value: "v2",
          });
          const role = yield* KindStablesResource("Role", {
            value: "role",
            upstream: database,
          });
          return { database, role };
        }).pipe(stack.deploy);

        expect(output.database.value).toBe("v2");
        expect(output.role.upstreamKind).toBe("postgresql");
      }),
  );

  test.provider(
    "should resolve bindings inside constructs using namespaced resources",
    (stack) =>
      Effect.gen(function* () {
        const Site = (id: string, _props: {}) =>
          Effect.gen(function* () {
            const bucket = yield* BindingTarget("Bucket", {
              string: "bucket-value",
            });
            const distribution = yield* BindingTarget("Distribution", {
              string: "distribution-value",
            });

            yield* bucket.bind("Policy", {
              env: {
                BUCKET: bucket.string,
                DISTRIBUTION: distribution.string,
              },
            });

            return {
              bucket,
              distribution,
            };
          }).pipe(Namespace.push(id));

        const output = yield* Site("MarketingSite", {}).pipe(stack.deploy);

        expect(output.bucket.env).toEqual({
          BUCKET: "bucket-value",
          DISTRIBUTION: "distribution-value",
        });
        expectConvergedStatus(
          (yield* getState("MarketingSite/Bucket"))?.status,
        );
        expect((yield* getState("MarketingSite/Distribution"))?.status).toEqual(
          "created",
        );
      }),
  );

  test.provider(
    "should exclude deleted bindings before provider updates",
    (stack) =>
      Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const target = yield* DeletedBindingRegressionTarget("A", {
              name: "target",
            });
            yield* target.bind("TestBinding", {
              env: {
                FEATURE_FLAG: "on",
              },
            });
            return target;
          }),
        );

        expect(created.env).toEqual({
          FEATURE_FLAG: "on",
        });

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* DeletedBindingRegressionTarget("A", {
              name: "target",
            });
          }),
        );

        expect(updated.env).toEqual({});
        expect(yield* getState("A")).toMatchObject({
          bindings: [],
          attr: {
            env: {},
          },
        });
      }),
  );

  // #874: terminal commits must persist the RESOLVED binding payload the
  // provider reconciled with, not the raw plan-time expressions. Raw
  // `node.bindings` hold unresolved Outputs (silently dropped by JSON state
  // stores), so persisting them makes every later plan's `diffBindings`
  // compare a lossy stored shape against fully-resolved data — a phantom
  // binding update on every plan. Exercises the create, update, and replace
  // commit sites.
  test.provider("terminal commits persist resolved binding payloads", (stack) =>
    Effect.gen(function* () {
      const program = (opts: { source: string; replaceString?: string }) =>
        Effect.gen(function* () {
          const source = yield* BindingTarget("BindSource", {
            string: opts.source,
          });
          const host = yield* BindingTarget("BindHost", {
            name: "host",
            replaceString: opts.replaceString,
          });
          // `source.string` is an unresolved Output at plan time.
          yield* host.bind("FromSource", {
            env: { VALUE: source.string },
          });
          return { source, host };
        });

      const actionOf = (plan: any, logicalId: string) =>
        (Object.values(plan.resources) as any[]).find(
          (node: any) => node.resource.LogicalId === logicalId,
        )?.action;

      const expectHostBindings = Effect.fn(function* (value: string) {
        const hostState = yield* getState("BindHost");
        expect(hostState?.bindings).toEqual([
          { sid: "FromSource", data: { env: { VALUE: value } } },
        ]);
      });

      // ── create commit ──
      yield* stack.deploy(program({ source: "v1" }));
      yield* expectHostBindings("v1");
      const created = yield* stack.plan(program({ source: "v1" }));
      expect(actionOf(created, "BindSource")).toBe("noop");
      expect(actionOf(created, "BindHost")).toBe("noop");

      // ── update commit ──
      yield* stack.deploy(program({ source: "v2" }));
      yield* expectHostBindings("v2");
      const updated = yield* stack.plan(program({ source: "v2" }));
      expect(actionOf(updated, "BindSource")).toBe("noop");
      expect(actionOf(updated, "BindHost")).toBe("noop");

      // ── replace commit ──
      yield* stack.deploy(program({ source: "v2", replaceString: "flip" }));
      yield* expectHostBindings("v2");
      const replaced = yield* stack.plan(
        program({ source: "v2", replaceString: "flip" }),
      );
      expect(actionOf(replaced, "BindSource")).toBe("noop");
      expect(actionOf(replaced, "BindHost")).toBe("noop");
    }),
  );

  test.provider(
    "persists resolved binding data so an unchanged redeploy plans binding noops",
    (stack) =>
      Effect.gen(function* () {
        // Binding data references an output of a resource created in the
        // SAME deploy — unresolved at plan time, resolved during apply.
        const program = Effect.gen(function* () {
          const upstream = yield* BindingTarget("Upstream", {
            string: "upstream-value",
          });
          const target = yield* BindingTarget("Target", { string: "t" });
          yield* target.bind("Cap", { env: { UPSTREAM: upstream.string } });
          return target;
        });

        const created = yield* stack.deploy(program);
        expect(created.env).toEqual({ UPSTREAM: "upstream-value" });

        // The persisted binding data must hold the RESOLVED value (what
        // `reconcile` received) — not the raw plan-time data, whose Output
        // proxies JSON state stores silently drop.
        expect(yield* getState("Target")).toMatchObject({
          status: "created",
          bindings: [
            { sid: "Cap", data: { env: { UPSTREAM: "upstream-value" } } },
          ],
        });

        // An unchanged redeploy must plan the binding as a noop. Before the
        // fix, the truncated persisted data diffed against the now-resolved
        // value and forced a spurious update on every deploy after a create.
        yield* stack.deploy(program);
        expect((yield* getState("Target"))?.status).toEqual("created");
      }),
  );

  test.provider(
    "should update a surviving consumer before deleting a removed dependency",
    (stack) =>
      Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const secret = yield* TestResource("Secret", {
              string: "secret-value",
            });
            const worker = yield* Function("Worker", {
              name: "worker",
              env: {
                SECRET: secret.string,
              },
            });
            return { secret, worker };
          }),
        );

        expect(created.worker.env).toEqual({
          SECRET: "secret-value",
        });
        expect((yield* getState("Secret"))?.status).toEqual("created");
        expect((yield* getState("Worker"))?.status).toEqual("created");

        const updated = yield* stack.deploy(
          Effect.gen(function* () {
            return yield* Function("Worker", {
              name: "worker",
            });
          }),
        );

        expect(updated.env).toEqual({});
        expect(yield* getState("Secret")).toBeUndefined();
        expect((yield* getState("Worker"))?.status).toEqual("updated");
      }),
  );

  test.provider(
    "should create a resource with a binding that references its own output",
    (stack) =>
      Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const target = yield* DeletedBindingRegressionTarget("A", {
              name: "target",
            });
            yield* target.bind("SelfBinding", {
              env: {
                SELF_NAME: target.name,
              },
            });
            return target;
          }),
        );

        expect(created.env).toEqual({
          SELF_NAME: "target",
        });
      }),
    { timeout: 10_000 },
  );
});

// Regression: a logical ID may legitimately contain the FQN separator ("/").
// The GitHub event source registers a webhook keyed by `${owner}/${repository}`
// (e.g. "alchemy-run/alchemy"). During destroy the deletion path used to
// recompute the state key via `toFqn(namespace, logicalId)`, but `logicalId`
// came from `parseFqn` which splits on "/" and keeps only the last segment
// ("alchemy"). The recomputed key missed the real state row, so the
// resource was deleted from the cloud yet never removed from state — resurfacing
// as an orphan deletion on every subsequent destroy, forever.
describe("FQN separator in logical ID", { tags: ["unit", "local"] }, () => {
  test.provider(
    "destroy clears state for a top-level logical ID containing '/'",
    (stack) =>
      Effect.gen(function* () {
        const fqn = "alchemy-run/alchemy";

        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* TestResource(fqn, { string: "v1" });
          }),
        );

        // The row is persisted under the full FQN (separator and all).
        expect((yield* getState(fqn))?.status).toEqual("created");

        const deleted: string[] = [];
        yield* stack.destroy().pipe(
          hook({
            delete: (id: string) =>
              Effect.sync(() => {
                deleted.push(id);
              }),
          }),
        );

        // provider.delete ran exactly once, AND the state row was removed
        // (the pre-fix bug deleted the cloud resource but missed the row).
        expect(deleted).toHaveLength(1);
        expect(yield* getState(fqn)).toBeUndefined();
        expect(yield* listState()).toEqual([]);
      }),
  );

  test.provider(
    "destroy clears state for a namespaced logical ID containing '/'",
    (stack) =>
      Effect.gen(function* () {
        // Mirrors the GitHub webhook: a host construct (the Worker) whose
        // child resource's logical ID is "owner/repo".
        const fqn = "ReleaseService/alchemy-run/alchemy";

        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* TestResource("alchemy-run/alchemy", {
              string: "v1",
            });
          }).pipe(Namespace.push("ReleaseService")),
        );

        expect((yield* getState(fqn))?.status).toEqual("created");

        yield* stack.destroy();

        expect(yield* getState(fqn)).toBeUndefined();
        expect(yield* listState()).toEqual([]);
      }),
  );
});

describe("linear update propagation", { tags: ["unit", "local"] }, () => {
  // Regression: in a linear chain (A -> B with no cycle), an update to A
  // followed by an update to B must let B see A's *post-update* attr, never
  // the stale prior attr. Before the cycle-gating change, A would publish
  // its prior attr early and B's update would race against the live value,
  // sometimes deploying with stale data (e.g. a Worker reading a Build's
  // outdir/hash before the build finished).
  test.provider(
    "downstream update receives upstream's post-update attr",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "v1" });
            const B = yield* TestResource("B", { string: A.string });
            return { A, B };
          }),
        );

        const sawByB: string[] = [];
        const captureBHooks = {
          create: () => Effect.succeed(undefined),
          update: (id: string, props: TestResourceProps) =>
            Effect.sync(() => {
              if (id === "B" && typeof props.string === "string") {
                sawByB.push(props.string);
              }
            }),
          delete: () => Effect.succeed(undefined),
          read: () => Effect.succeed(undefined),
        };

        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "v2" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        }).pipe(stack.deploy, hook(captureBHooks));

        expect(output.A.string).toEqual("v2");
        expect(output.B.string).toEqual("v2");
        // B.update must have observed the fresh upstream value, never the
        // stale "v1". A single fresh-only call is the ideal; we accept any
        // sequence as long as no stale value leaked through.
        expect(sawByB.length).toBeGreaterThan(0);
        expect(sawByB.every((v) => v === "v2")).toBe(true);
      }),
  );

  // Regression: a dependent that repins from upstream A to upstream B updates
  // *itself*, while A and B are both noops. The noop pass must still persist
  // their new `downstream` — delete ordering reads it from the persisted row,
  // so a stale list would delete B concurrently with the dependent that still
  // references it (and needlessly wait on A).
  test.provider(
    "noop upstreams persist a repinned dependent's downstream edge",
    (stack) =>
      Effect.gen(function* () {
        const program = (pin: "A" | "B") =>
          Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a" });
            const B = yield* TestResource("B", { string: "b" });
            const C = yield* TestResource("C", {
              string: (pin === "A" ? A : B).string,
            });
            return { A, B, C };
          });

        yield* stack.deploy(program("A"));
        expect((yield* getState("A"))?.downstream).toEqual(["C"]);
        expect((yield* getState("B"))?.downstream).toEqual([]);

        yield* stack.deploy(program("B"));
        expect((yield* getState("A"))?.downstream).toEqual([]);
        expect((yield* getState("B"))?.downstream).toEqual(["C"]);
      }),
  );
});

// Regression: `deleteFirst` on a `replace` diff was plumbed from the provider
// all the way into persisted state but never *read* — every replacement was
// create-first, with the old generation reclaimed afterwards by Phase-2 GC.
// That silently broke any resource whose replacement can't coexist with the
// original (fixed physical name, singleton): the create collided with the
// not-yet-deleted original. These tests pin both orderings.
describe("deleteFirst replacements", { tags: ["unit", "local"] }, () => {
  test.provider(
    "deletes the old generation BEFORE creating the replacement",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* DeleteFirstResource("R", { replaceString: "v1" });
          }),
        );

        const order: string[] = [];
        const recordHooks = {
          create: () =>
            Effect.sync(() => {
              order.push("create");
            }),
          update: () => Effect.succeed(undefined),
          delete: () =>
            Effect.sync(() => {
              order.push("delete");
            }),
        };

        yield* Effect.gen(function* () {
          return yield* DeleteFirstResource("R", { replaceString: "v2" });
        }).pipe(stack.deploy, hook(recordHooks));

        // The whole point: delete-old precedes create-new.
        expect(order).toEqual(["delete", "create"]);

        // The resource collapses straight to a terminal `created` state with
        // no leftover replacement chain for GC to drain.
        const state = yield* getState("R");
        expect(state?.status).toEqual("created");
        expect((state as { old?: unknown }).old).toBeUndefined();
        expect(yield* listState()).toHaveLength(1);
      }),
  );

  test.provider(
    "default (non-deleteFirst) replacement still creates BEFORE deleting",
    (stack) =>
      Effect.gen(function* () {
        // `TestResource` returns a plain `{ action: "replace" }` (deleteFirst
        // defaults to false), so the engine must stay create-first.
        yield* stack.deploy(
          Effect.gen(function* () {
            return yield* TestResource("R", { replaceString: "v1" });
          }),
        );

        const order: string[] = [];
        yield* Effect.gen(function* () {
          return yield* TestResource("R", { replaceString: "v2" });
        }).pipe(
          stack.deploy,
          hook({
            create: () =>
              Effect.sync(() => {
                order.push("create");
              }),
            update: () => Effect.succeed(undefined),
            delete: () =>
              Effect.sync(() => {
                order.push("delete");
              }),
          }),
        );

        expect(order).toEqual(["create", "delete"]);
      }),
  );

  test.provider(
    "lets a same-identity replacement succeed where create-first would collide",
    (stack) =>
      Effect.gen(function* () {
        // A shared registry of live physical names. The provider's create
        // fails if the (fixed) name is still live — exactly the failure mode
        // of a real fixed-name resource (Docker network "already exists",
        // no-op `volume create`) when create runs before the old is deleted.
        const registry = { live: new Set<string>() };
        const withRegistry = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
          effect.pipe(
            Effect.provide(Layer.succeed(CollisionRegistry, registry)),
          );

        yield* stack
          .deploy(
            Effect.gen(function* () {
              return yield* DeleteFirstResource("R", {
                name: "singleton",
                replaceString: "v1",
              });
            }),
          )
          .pipe(withRegistry);
        expect(registry.live.has("singleton")).toBe(true);

        // Before the fix this deploy died with a CollisionError because the
        // create of the new "singleton" ran while the old one was still live.
        const result = yield* stack
          .deploy(
            Effect.gen(function* () {
              return yield* DeleteFirstResource("R", {
                name: "singleton",
                replaceString: "v2",
              });
            }),
          )
          .pipe(withRegistry);

        expect(result.name).toEqual("singleton");
        expect(result.replaceString).toEqual("v2");
        // Exactly one live instance remains (old torn down, new created).
        expect(registry.live.size).toBe(1);
        expect(registry.live.has("singleton")).toBe(true);

        const state = yield* getState("R");
        expect(state?.status).toEqual("created");
      }),
  );
});

describe("circularity via bindings", { tags: ["unit", "local"] }, () => {
  const selfBoundStack = (props: {
    string: string;
    replaceString?: string;
    includeD?: boolean;
  }) =>
    Effect.gen(function* () {
      const A = yield* BindingTarget("A", {
        name: "a",
        string: props.string,
        replaceString: props.replaceString,
      });
      yield* A.bind("SelfBinding", {
        env: {
          SELF: A.string,
        },
      });
      const B = yield* TestResource("B", { string: A.string });
      if (props.includeD) {
        const D = yield* TestResource("D", { string: B.string });
        return { A, B, D };
      }
      return { A, B };
    });

  const mutualBindingStack = (props: {
    aString: string;
    aReplaceString?: string;
    bString?: string;
    includeD?: boolean;
  }) =>
    Effect.gen(function* () {
      const A = yield* BindingTarget("A", {
        name: "a",
        string: props.aString,
        replaceString: props.aReplaceString,
      });
      const B = yield* BindingTarget("B", {
        name: "b",
        string: props.bString ?? "b-value",
      });
      yield* A.bind("FromB", {
        env: {
          PEER: B.string,
        },
      });
      yield* B.bind("FromA", {
        env: {
          PEER: A.string,
        },
      });
      if (props.includeD) {
        const D = yield* TestResource("D", {
          string: Output.interpolate`${A.string}-${B.string}`,
        });
        return { A, B, D };
      }
      return { A, B };
    });

  const propAndBindingCycleStack = () =>
    Effect.gen(function* () {
      const A = yield* BindingTarget("A", {
        name: "a",
        string: "a-value",
      });
      const B = yield* TestResource("B", {
        string: A.string,
      });
      yield* A.bind("FromB", {
        env: {
          PEER: B.string,
        },
      });
      return { A, B };
    });

  test.provider(
    "create succeeds when props use precreate output and bindings use downstream output",
    (stack) =>
      Effect.gen(function* () {
        const output = yield* stack.deploy(propAndBindingCycleStack());

        expect(output.A.env).toEqual({ PEER: "a-value" });
        expect(output.B.string).toEqual("a-value");
        expectConvergedStatus((yield* getState("A"))?.status);
        expectConvergedStatus((yield* getState("B"))?.status);
      }),
    { timeout: 10_000 },
  );

  describe("self-referential bindings", () => {
    test.provider("create succeeds with self binding", (stack) =>
      Effect.gen(function* () {
        const output = yield* stack.deploy(
          selfBoundStack({
            string: "a-value",
            replaceString: "original",
          }),
        );

        expect(output.A.env).toEqual({ SELF: "a-value" });
        expect(output.B.string).toEqual("a-value");
        expectConvergedStatus((yield* getState("A"))?.status);
        expectConvergedStatus((yield* getState("B"))?.status);
      }),
    );

    test.provider(
      "replacing state noop replay recovers and creates downstream resources",
      (stack) =>
        Effect.gen(function* () {
          yield* selfBoundStack({
            string: "a-value",
            replaceString: "original",
          }).pipe(stack.deploy);

          const program = selfBoundStack({
            string: "a-value-replaced",
            replaceString: "changed",
            includeD: true,
          });

          yield* program.pipe(stack.deploy, hook(failOn("A", "create")));

          expect(
            (yield* getState<ReplacingResourceState>("A"))?.status,
          ).toEqual("replacing");
          expectConvergedStatus((yield* getState("B"))?.status);
          expectNotStarted(yield* getState("D"));

          const output = yield* program.pipe(stack.deploy);
          expectConvergedStatus((yield* getState("A"))?.status);
          expect((yield* getState("B"))?.status).toEqual("updated");
          expectConvergedStatus((yield* getState("D"))?.status);
          expect(output.A.env).toEqual({ SELF: "a-value-replaced" });
          expect(output.D!.string).toEqual("a-value-replaced");
        }),
    );

    test.provider(
      "replacing state update replay updates replacement and creates downstream resources",
      (stack) =>
        Effect.gen(function* () {
          yield* selfBoundStack({
            string: "a-value",
            replaceString: "original",
          }).pipe(stack.deploy);

          yield* selfBoundStack({
            string: "a-value-replaced",
            replaceString: "changed",
            includeD: true,
          }).pipe(stack.deploy, hook(failOn("A", "create")));

          expect(
            (yield* getState<ReplacingResourceState>("A"))?.status,
          ).toEqual("replacing");
          expectConvergedStatus((yield* getState("B"))?.status);
          expectNotStarted(yield* getState("D"));

          const output = yield* selfBoundStack({
            string: "a-value-updated-during-recovery",
            replaceString: "changed",
            includeD: true,
          }).pipe(stack.deploy);

          expectConvergedStatus((yield* getState("A"))?.status);
          expect((yield* getState("B"))?.status).toEqual("updated");
          expectConvergedStatus((yield* getState("D"))?.status);
          expect(output.A.env).toEqual({
            SELF: "a-value-updated-during-recovery",
          });
          expect(output.D!.string).toEqual("a-value-updated-during-recovery");
        }),
    );

    test.provider(
      "replaced state noop replay finishes cleanup and creates downstream resources",
      (stack) =>
        Effect.gen(function* () {
          yield* selfBoundStack({
            string: "a-value",
            replaceString: "original",
          }).pipe(stack.deploy);

          const program = selfBoundStack({
            string: "a-value-replaced",
            replaceString: "changed",
            includeD: true,
          });

          yield* program.pipe(stack.deploy, hook(failOn("B", "update")));

          expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
            "replaced",
          );
          expect((yield* getState("B"))?.status).toEqual("updating");
          expectNotStarted(yield* getState("D"));

          const output = yield* program.pipe(stack.deploy);
          expectConvergedStatus((yield* getState("A"))?.status);
          expect((yield* getState("B"))?.status).toEqual("updated");
          expectConvergedStatus((yield* getState("D"))?.status);
          expect(output.A.env).toEqual({ SELF: "a-value-replaced" });
          expect(output.D!.string).toEqual("a-value-replaced");
        }),
    );

    test.provider(
      "replaced state update replay updates replacement and downstream resources",
      (stack) =>
        Effect.gen(function* () {
          yield* selfBoundStack({
            string: "a-value",
            replaceString: "original",
          }).pipe(stack.deploy);

          yield* selfBoundStack({
            string: "a-value-replaced",
            replaceString: "changed",
            includeD: true,
          }).pipe(stack.deploy, hook(failOn("B", "update")));

          expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
            "replaced",
          );
          expect((yield* getState("B"))?.status).toEqual("updating");
          expectNotStarted(yield* getState("D"));

          const output = yield* selfBoundStack({
            string: "a-value-updated-after-replace",
            replaceString: "changed",
            includeD: true,
          }).pipe(stack.deploy);

          expectConvergedStatus((yield* getState("A"))?.status);
          expect((yield* getState("B"))?.status).toEqual("updated");
          expectConvergedStatus((yield* getState("D"))?.status);
          expect(output.A.env).toEqual({
            SELF: "a-value-updated-after-replace",
          });
          expect(output.D!.string).toEqual("a-value-updated-after-replace");
        }),
    );
  });

  describe("mutual A <-> B bindings", () => {
    test.provider("create succeeds with mutual bindings", (stack) =>
      Effect.gen(function* () {
        const output = yield* stack.deploy(
          mutualBindingStack({
            aString: "a-value",
          }),
        );

        expect(output.A.env).toEqual({ PEER: "b-value" });
        expect(output.B.env).toEqual({ PEER: "a-value" });
        expectConvergedStatus((yield* getState("A"))?.status);
        expectConvergedStatus((yield* getState("B"))?.status);
      }),
    );

    test.provider("destroy succeeds with mutual bindings", (stack) =>
      Effect.gen(function* () {
        yield* mutualBindingStack({
          aString: "a-value",
        }).pipe(stack.deploy);

        yield* stack.destroy();

        expect(yield* getState("A")).toBeUndefined();
        expectNotStarted(yield* getState("B"));
      }),
    );

    describe("from replacing state", () => {
      test.provider(
        "replacing noop recovery creates downstream resources",
        (stack) =>
          Effect.gen(function* () {
            yield* mutualBindingStack({
              aString: "a-value",
              aReplaceString: "original",
            }).pipe(stack.deploy);

            const program = mutualBindingStack({
              aString: "a-value-replaced",
              aReplaceString: "changed",
              includeD: true,
            });

            yield* program.pipe(stack.deploy, hook(failOn("A", "create")));

            expect(
              (yield* getState<ReplacingResourceState>("A"))?.status,
            ).toEqual("replacing");
            expectConvergedStatus((yield* getState("B"))?.status);
            expectNotStarted(yield* getState("D"));

            const output = yield* program.pipe(stack.deploy);
            expectConvergedStatus((yield* getState("A"))?.status);
            expect((yield* getState("B"))?.status).toEqual("updated");
            expectConvergedStatus((yield* getState("D"))?.status);
            expect(output.A.env).toEqual({ PEER: "b-value" });
            expect(output.B.env).toEqual({ PEER: "a-value-replaced" });
            expect(output.D!.string).toEqual("a-value-replaced-b-value");
          }),
      );

      test.provider(
        "replacing update recovery creates downstream resources",
        (stack) =>
          Effect.gen(function* () {
            yield* mutualBindingStack({
              aString: "a-value",
              aReplaceString: "original",
            }).pipe(stack.deploy);

            yield* mutualBindingStack({
              aString: "a-value-replaced",
              aReplaceString: "changed",
              includeD: true,
            }).pipe(stack.deploy, hook(failOn("A", "create")));

            expect(
              (yield* getState<ReplacingResourceState>("A"))?.status,
            ).toEqual("replacing");
            expectConvergedStatus((yield* getState("B"))?.status);
            expectNotStarted(yield* getState("D"));

            const output = yield* mutualBindingStack({
              aString: "a-value-updated-during-recovery",
              aReplaceString: "changed",
              includeD: true,
            }).pipe(stack.deploy);

            expectConvergedStatus((yield* getState("A"))?.status);
            expect((yield* getState("B"))?.status).toEqual("updated");
            expectConvergedStatus((yield* getState("D"))?.status);
            expect(output.A.env).toEqual({ PEER: "b-value" });
            expect(output.B.env).toEqual({
              PEER: "a-value-updated-during-recovery",
            });
            expect(output.D!.string).toEqual(
              "a-value-updated-during-recovery-b-value",
            );
          }),
      );

      test.provider(
        "replacing replace recovery nests another replacement",
        (stack) =>
          Effect.gen(function* () {
            yield* mutualBindingStack({
              aString: "a-value",
              aReplaceString: "original",
            }).pipe(stack.deploy);

            yield* mutualBindingStack({
              aString: "a-value-replaced",
              aReplaceString: "changed",
              includeD: true,
            }).pipe(stack.deploy, hook(failOn("A", "create")));

            const output = yield* mutualBindingStack({
              aString: "a-value-another-replacement",
              aReplaceString: "another-change",
              includeD: true,
            }).pipe(stack.deploy);

            expectConvergedStatus((yield* getState("A"))?.status);
            expect((yield* getState("B"))?.status).toEqual("updated");
            expectConvergedStatus((yield* getState("D"))?.status);
            expect(output.B.env).toEqual({
              PEER: "a-value-another-replacement",
            });
          }),
      );
    });

    describe("from replaced state", () => {
      test.provider(
        "replaced noop recovery updates downstream then creates downstream resources",
        (stack) =>
          Effect.gen(function* () {
            yield* mutualBindingStack({
              aString: "a-value",
              aReplaceString: "original",
            }).pipe(stack.deploy);

            const program = mutualBindingStack({
              aString: "a-value-replaced",
              aReplaceString: "changed",
              includeD: true,
            });

            yield* program.pipe(stack.deploy, hook(failOn("B", "update")));

            expect(
              (yield* getState<ReplacedResourceState>("A"))?.status,
            ).toEqual("replaced");
            expect((yield* getState("B"))?.status).toEqual("updating");
            expectNotStarted(yield* getState("D"));

            const output = yield* program.pipe(stack.deploy);
            expect((yield* getState("A"))?.status).toEqual("created");
            expect((yield* getState("B"))?.status).toEqual("updated");
            expectConvergedStatus((yield* getState("D"))?.status);
            expect(output.A.env).toEqual({ PEER: "b-value" });
            expect(output.B.env).toEqual({ PEER: "a-value-replaced" });
            expect(output.D!.string).toEqual("a-value-replaced-b-value");
          }),
      );

      test.provider(
        "replaced with update recovery updates replacement and downstream resources",
        (stack) =>
          Effect.gen(function* () {
            yield* mutualBindingStack({
              aString: "a-value",
              aReplaceString: "original",
            }).pipe(stack.deploy);

            yield* mutualBindingStack({
              aString: "a-value-replaced",
              aReplaceString: "changed",
              includeD: true,
            }).pipe(stack.deploy, hook(failOn("B", "update")));

            expect(
              (yield* getState<ReplacedResourceState>("A"))?.status,
            ).toEqual("replaced");
            expect((yield* getState("B"))?.status).toEqual("updating");
            expectNotStarted(yield* getState("D"));

            const output = yield* mutualBindingStack({
              aString: "a-value-updated-after-replace",
              aReplaceString: "changed",
              includeD: true,
            }).pipe(stack.deploy);

            expect((yield* getState("A"))?.status).toEqual("created");
            expect((yield* getState("B"))?.status).toEqual("updated");
            expectConvergedStatus((yield* getState("D"))?.status);
            expect(output.A.env).toEqual({ PEER: "b-value" });
            expect(output.B.env).toEqual({
              PEER: "a-value-updated-after-replace",
            });
            expect(output.D!.string).toEqual(
              "a-value-updated-after-replace-b-value",
            );
          }),
      );

      test.provider(
        "replaced replace recovery nests another replacement",
        (stack) =>
          Effect.gen(function* () {
            yield* mutualBindingStack({
              aString: "a-value",
              aReplaceString: "original",
            }).pipe(stack.deploy);

            yield* mutualBindingStack({
              aString: "a-value-replaced",
              aReplaceString: "changed",
              includeD: true,
            }).pipe(stack.deploy, hook(failOn("B", "update")));

            const output = yield* mutualBindingStack({
              aString: "a-value-another-replacement",
              aReplaceString: "another-change",
              includeD: true,
            }).pipe(stack.deploy);

            expectConvergedStatus((yield* getState("A"))?.status);
            expect((yield* getState("B"))?.status).toEqual("updated");
            expectConvergedStatus((yield* getState("D"))?.status);
            expect(output.B.env).toEqual({
              PEER: "a-value-another-replacement",
            });
          }),
      );
    });
  });
});

describe("prop-flow convergence", { tags: ["unit", "local"] }, () => {
  test.provider(
    "downstream outside a cycle waits for precreated upstream reconciliation",
    (stack) =>
      Effect.gen(function* () {
        let reconciled = false;
        const observations: boolean[] = [];
        yield* Effect.gen(function* () {
          const worker = yield* PhasedTarget("Worker", {
            desired: "queue-handler",
            replaceKey: "v1",
          });
          const binding = yield* TestResource("Binding", {
            string: worker.stableId,
          });
          yield* worker.bind("Feedback", { env: { B: binding.string } });
          // Like a Queue Consumer: the script name is available from the
          // stub, but attaching requires the real Worker upload to finish.
          return yield* TestResource("Consumer", { string: worker.stableId });
        }).pipe(
          stack.deploy,
          hook({
            create: (id) =>
              Effect.gen(function* () {
                if (id === "Worker") {
                  yield* Effect.sleep("50 millis");
                  reconciled = true;
                } else if (id === "Consumer") {
                  observations.push(reconciled);
                }
              }),
          }),
        );
        expect(observations).toEqual([true]);
      }),
  );

  const phasedCycleStack = (props: {
    desired: string;
    replaceKey?: string;
    use: "stableId" | "value";
    includeC?: boolean;
  }) =>
    Effect.gen(function* () {
      const A = yield* PhasedTarget("A", {
        desired: props.desired,
        replaceKey: props.replaceKey,
      });
      const selected = props.use === "stableId" ? A.stableId : A.value;
      const B = yield* TestResource("B", {
        string: selected,
      });
      yield* A.bind("FromB", {
        env: {
          B: B.string,
        },
      });

      if (props.includeC) {
        const C = yield* TestResource("C", {
          string: B.string,
        });
        return { A, B, C };
      }

      return { A, B };
    });

  test.provider(
    "fresh circular create may use a stable precreate identifier",
    (stack) =>
      Effect.gen(function* () {
        const output = yield* phasedCycleStack({
          desired: "final-a",
          replaceKey: "v1",
          use: "stableId",
        }).pipe(stack.deploy);

        expect(output.A.value).toEqual("final-a");
        expect(output.B.string).toEqual("stable:v1");
      }),
  );

  test.provider(
    "fresh circular create should converge downstream props to final values",
    (stack) =>
      Effect.gen(function* () {
        const output = yield* phasedCycleStack({
          desired: "final-a",
          replaceKey: "v1",
          use: "value",
        }).pipe(stack.deploy);

        expect(output.A.value).toEqual("final-a");
        expect(output.B.string).toEqual("final-a");
      }),
  );

  test.provider(
    "fresh replacement should converge newly created downstream props to replacement values",
    (stack) =>
      Effect.gen(function* () {
        yield* phasedCycleStack({
          desired: "old-a",
          replaceKey: "v1",
          use: "value",
        }).pipe(stack.deploy);

        const output = yield* phasedCycleStack({
          desired: "new-a",
          replaceKey: "v2",
          use: "value",
        }).pipe(stack.deploy);

        expect(output.A.value).toEqual("new-a");
        expect(output.B.string).toEqual("new-a");
      }),
  );

  test.provider(
    "stale precreate values should not propagate transitively",
    (stack) =>
      Effect.gen(function* () {
        const output = yield* phasedCycleStack({
          desired: "final-a",
          replaceKey: "v1",
          use: "value",
          includeC: true,
        }).pipe(stack.deploy);

        expect(output.A.value).toEqual("final-a");
        expect(output.B.string).toEqual("final-a");
        expect(output.C!.string).toEqual("final-a");
      }),
  );

  test.provider(
    "binding feedback converges across an A -> B -> A fixed point",
    (stack) =>
      Effect.gen(function* () {
        const output = yield* Effect.gen(function* () {
          const A = yield* PhasedTarget("A", {
            desired: "final-a",
            replaceKey: "v1",
          });
          const B = yield* TestResource("B", {
            string: A.value,
          });
          yield* A.bind("FromB", {
            env: {
              B: B.string,
            },
          });
          return { A, B };
        }).pipe(stack.deploy);

        expect(output.A.value).toEqual("final-a");
        expect(output.B.string).toEqual("final-a");
        expect(output.A.env).toEqual({
          B: "final-a",
        });
      }),
  );

  test.provider(
    "terminal created or updated status is delayed until fixed-point convergence finishes",
    (stack) =>
      Effect.gen(function* () {
        const events: Array<{ id: string; status: string }> = [];
        const cli = Cli.of({
          startPlanningSession: () =>
            Effect.succeed({
              update: () => Effect.void,
              succeed: () => Effect.void,
              fail: () => Effect.void,
              close: Effect.void,
            }),
          approvePlan: () => Effect.succeed(true),
          displayPlan: () => Effect.void,
          startApplySession: () =>
            Effect.succeed({
              done: () => Effect.void,
              emit: (event) =>
                Effect.sync(() => {
                  if (event._tag === "apply.resource.status") {
                    events.push({
                      id: event.id,
                      status: event.status,
                    });
                  }
                }),
            }),
        });

        const output = yield* Effect.gen(function* () {
          const A = yield* PhasedTarget("A", {
            desired: "final-a",
            replaceKey: "v1",
          });
          const B = yield* TestResource("B", {
            string: A.value,
          });
          yield* A.bind("FromB", {
            env: {
              B: B.string,
            },
          });
          return { A, B };
        }).pipe(stack.deploy, Effect.provide(Layer.succeed(Cli, cli)));

        expect(output.A.env).toEqual({
          B: "final-a",
        });

        const statusesById = events.reduce(
          (acc, event: { id: string; status: string }) => {
            (acc[event.id] ??= []).push(event);
            return acc;
          },
          {} as Record<string, Array<{ id: string; status: string }>>,
        );
        const terminal = (id: string) =>
          (statusesById[id] ?? [])
            .map((event: { id: string; status: string }) => event.status)
            .filter(
              (status: string) => status === "created" || status === "updated",
            );

        expect(terminal("A")).toEqual(["updated"]);
        expect(terminal("B")).toEqual(["updated"]);
      }),
  );

  test.provider("apply sessions finalize after a resource failure", (stack) =>
    Effect.gen(function* () {
      let finalized = 0;
      const cli = Cli.of({
        startPlanningSession: () =>
          Effect.succeed({
            update: () => Effect.void,
            succeed: () => Effect.void,
            fail: () => Effect.void,
            close: Effect.void,
          }),
        approvePlan: () => Effect.succeed(true),
        displayPlan: () => Effect.void,
        startApplySession: () =>
          Effect.succeed({
            done: () =>
              Effect.sync(() => {
                finalized += 1;
              }),
            emit: () => Effect.void,
          }),
      });

      yield* TestResource("A", { string: "value" }).pipe(
        stack.deploy,
        hook(failOn("A", "create")),
        Effect.provide(Layer.succeed(Cli, cli)),
      );

      expect(finalized).toBe(1);
    }),
  );

  // Regression: a resource with `precreate` (e.g. Cloudflare Worker) resolves
  // its early `ready` signal before its real `reconcile` runs. A non-cyclic
  // downstream must still wait for the upstream's TERMINAL output, so that an
  // upstream `reconcile` failure interrupts the downstream instead of letting
  // it proceed off the precreate stub. Before the fix the downstream raced
  // ahead on the precreate identifier and fully created itself even though the
  // upstream failed.
  test.provider(
    "precreate upstream reconcile failure interrupts non-cyclic downstream (stable id dep)",
    (stack) =>
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const A = yield* PhasedTarget("A", {
            desired: "a-value",
            replaceKey: "v1",
          });
          // B depends on A.stableId — a value already available from A's
          // precreate stub — yet must still be gated on A's reconcile.
          const B = yield* TestResource("B", {
            string: A.stableId,
          });
          return { A, B };
        });

        yield* program.pipe(stack.deploy, hook(failOn("A", "create")));

        // A's reconcile failed after committing "creating".
        expect((yield* getState("A"))?.status).toEqual("creating");
        // B must NOT have reached its own reconcile. It may have committed an
        // intermediate "creating" while waiting on deps, but it must never be
        // "created" — that would mean the upstream failure was ignored.
        expect((yield* getState("B"))?.status).not.toEqual("created");

        // Recovery deploy converges both.
        const output = yield* program.pipe(stack.deploy);
        expectConvergedStatus((yield* getState("A"))?.status);
        expectConvergedStatus((yield* getState("B"))?.status);
        expect(output.B.string).toEqual("stable:v1");
      }),
  );

  test.provider(
    "precreate upstream reconcile failure interrupts non-cyclic downstream (value dep)",
    (stack) =>
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const A = yield* PhasedTarget("A", {
            desired: "a-value",
            replaceKey: "v1",
          });
          const B = yield* TestResource("B", {
            string: A.value,
          });
          const C = yield* TestResource("C", {
            string: B.string,
          });
          return { A, B, C };
        });

        yield* program.pipe(stack.deploy, hook(failOn("A", "create")));

        expect((yield* getState("A"))?.status).toEqual("creating");
        expect((yield* getState("B"))?.status).not.toEqual("created");
        // Transitive downstream never starts either.
        expectNotStarted(yield* getState("C"));

        const output = yield* program.pipe(stack.deploy);
        expectConvergedStatus((yield* getState("A"))?.status);
        expectConvergedStatus((yield* getState("B"))?.status);
        expectConvergedStatus((yield* getState("C"))?.status);
        expect(output.C.string).toEqual("a-value");
      }),
  );
});

describe("from created state", { tags: ["unit", "local"] }, () => {
  test.provider("noop when props unchanged", (stack) =>
    Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "test-string",
        });
        return A.string;
      });

      let output = yield* stack.deploy(program);
      expect(output).toEqual("test-string");

      expect((yield* getState("A"))?.status).toEqual("created");
      output = yield* stack.deploy(program);

      // Re-apply with same props - should be noop
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("test-string");
    }),
  );

  test.provider("replace when props trigger replacement", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const A = yield* TestResource("A", {
            replaceString: "original",
          });
          return A.replaceString;
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("created");

      // Change props that trigger replacement

      const output = yield* stack.deploy(
        Effect.gen(function* () {
          const A = yield* TestResource("A", {
            replaceString: "new",
          });
          return A.replaceString;
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("new");
    }),
  );
});

describe("from updated state", { tags: ["unit", "local"] }, () => {
  test.provider("noop when props unchanged", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("created");

      // Update to get to updated state
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string-changed",
          });
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("updated");

      // Re-apply with same props - should be noop
      const output = yield* stack.deploy(
        Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string-changed",
          });
          return A.string;
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("updated");
      expect(output).toEqual("test-string-changed");
    }),
  );

  test.provider("replace when props trigger replacement", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
            replaceString: "original",
          });
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("created");

      // Update to get to updated state
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string-changed",
            replaceString: "original",
          });
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("updated");

      // Change props that trigger replacement
      const output = yield* stack.deploy(
        Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string-changed",
            replaceString: "new",
          });
          return A.replaceString;
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("new");
    }),
  );
});

describe("from creating state", { tags: ["unit", "local"] }, () => {
  test.provider("continue creating when props unchanged", (stack) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string",
        });
      }).pipe(stack.deploy, hook());
      expect((yield* getState("A"))?.status).toEqual("creating");

      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "test-string",
        });
        return A.string;
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("test-string");
    }),
  );

  test.provider(
    "continue creating when props have updatable changes",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(stack.deploy, hook());
        expect((yield* getState("A"))?.status).toEqual("creating");

        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string-changed",
          });
          return A.string;
        }).pipe(stack.deploy);
        expect(output).toEqual("test-string-changed");
        expect((yield* getState("A"))?.status).toEqual("created");
      }),
  );

  test.provider("replace when props trigger replacement", (stack) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "test-string",
        });
      }).pipe(stack.deploy, hook());
      expect((yield* getState("A"))?.status).toEqual("creating");

      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          replaceString: "test-string-changed",
        });
        return A.replaceString;
      }).pipe(stack.deploy);
      expect(output).toEqual("test-string-changed");
      expect((yield* getState("A"))?.status).toEqual("created");
    }),
  );

  test.provider(
    "destroy should handle creating state with no attributes",
    (stack) =>
      Effect.gen(function* () {
        // 1. Create a resource but fail - this leaves state in "creating" with no attr
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(stack.deploy, hook());
        expect((yield* getState("A"))?.status).toEqual("creating");
        expect((yield* getState("A"))?.attr).toBeUndefined();

        // 2. Call destroy - this triggers collectGarbage which tries to delete
        // the orphaned resource. The bug is that output is undefined in the
        // delete call when the resource never completed creation.
        yield* stack.destroy();

        // Resource should be cleaned up
        expect(yield* getState("A")).toBeUndefined();
      }),
  );

  test.provider(
    "destroy should handle creating state when attributes can be recovered",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(stack.deploy, hook());
        expect((yield* getState("A"))?.status).toEqual("creating");
        expect((yield* getState("A"))?.attr).toBeUndefined();

        yield* stack.destroy().pipe(
          hook({
            delete: () => Effect.fail(new ResourceFailure()),
            read: () =>
              Effect.succeed({
                string: "test-string",
              }),
          }),
        );

        // Resource should be cleaned up
        expect((yield* getState("A"))?.status).toEqual("deleting");

        // actually delete this time
        yield* stack.destroy().pipe(
          hook({
            read: () =>
              Effect.succeed({
                string: "test-string",
              }),
          }),
        );

        expect(yield* getState("A")).toBeUndefined();
      }),
  );

  test.provider(
    "destroy should handle replacing state when old resource has no attributes",
    (stack) =>
      Effect.gen(function* () {
        // 1. Create a resource but fail - this leaves state in "creating" with no attr
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "original",
          });
        }).pipe(stack.deploy, hook());
        expect((yield* getState("A"))?.status).toEqual("creating");
        expect((yield* getState("A"))?.attr).toBeUndefined();

        // 2. Trigger replacement but also fail during create - this leaves state in "replacing"
        // with old.attr being undefined
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "new",
          });
        }).pipe(stack.deploy, hook());
        const state = yield* getState<ReplacingResourceState>("A");
        expect(state?.status).toEqual("replacing");
        expect(state?.old?.attr).toBeUndefined();

        // 3. Call destroy - this triggers collectGarbage which tries to delete
        // the resource. The bug is that old.attr is undefined.
        yield* stack.destroy().pipe(
          hook({
            read: () =>
              Effect.succeed({
                replaceString: "original",
              }),
          }),
        );

        // Resource should be cleaned up
        expect(yield* getState("A")).toBeUndefined();
      }),
  );

  // ── attr-less `creating` rows must not orphan the physical resource ──
  //
  // A create can be interrupted AFTER the cloud-side call succeeded but
  // BEFORE reconcile returned Attributes, leaving a `creating` row with
  // `attr === undefined`. Destroy used to skip `provider.delete` entirely
  // for such rows and drop the state, silently orphaning the physical
  // resource. The engine now read-then-deletes: `provider.read` recovers
  // the attributes from the persisted props (deterministic physical name),
  // and only a confirmed-missing or Unowned resource skips the delete.

  test.provider(
    "destroy deletes the recovered physical resource of an attr-less creating row",
    (stack) =>
      Effect.gen(function* () {
        // Interrupted create: cloud-side create "succeeded" but no attrs
        // were ever persisted.
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(stack.deploy, hook());
        expect((yield* getState("A"))?.status).toEqual("creating");
        expect((yield* getState("A"))?.attr).toBeUndefined();

        const deleted: string[] = [];
        yield* stack.destroy().pipe(
          hook({
            read: () => Effect.succeed({ string: "test-string" }),
            delete: (id) => Effect.sync(() => void deleted.push(id)),
          }),
        );

        // The physical resource recovered by `read` was actually deleted —
        // not silently orphaned.
        expect(deleted).toEqual(["A"]);
        expect(yield* getState("A")).toBeUndefined();
      }),
  );

  test.provider(
    "destroy never deletes a recovered resource that is Unowned",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(stack.deploy, hook());
        expect((yield* getState("A"))?.status).toEqual("creating");

        const deleted: string[] = [];
        yield* stack.destroy().pipe(
          hook({
            // The physical name exists but belongs to someone else — our
            // interrupted create actually lost a name race (or died before
            // stamping ownership).
            read: () => Effect.succeed(Unowned({ string: "foreign" })),
            delete: (id) => Effect.sync(() => void deleted.push(id)),
          }),
        );

        // Foreign resources are left in place; only our state is dropped.
        expect(deleted).toEqual([]);
        expect(yield* getState("A")).toBeUndefined();
      }),
  );

  test.provider(
    "destroy tolerates not-found for an attr-less creating row",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(stack.deploy, hook());
        expect((yield* getState("A"))?.status).toEqual("creating");

        const deleted: string[] = [];
        yield* stack.destroy().pipe(
          hook({
            read: () => Effect.succeed(undefined),
            delete: (id) => Effect.sync(() => void deleted.push(id)),
          }),
        );

        // Nothing exists cloud-side — delete is not invoked, state is dropped.
        expect(deleted).toEqual([]);
        expect(yield* getState("A")).toBeUndefined();
      }),
  );

  test.provider(
    "destroy survives a recovery read that crashes on degraded creating props",
    (stack) =>
      Effect.gen(function* () {
        // An interrupted create can persist `creating` props whose
        // unresolved Outputs were stripped to holes; a provider read that
        // dereferences one crashes with a defect (e.g. a SchemaError deep
        // in its SDK client, see #995). Destroy must degrade to "nothing
        // recovered" and drop the row instead of bricking the stage.
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(stack.deploy, hook());
        expect((yield* getState("A"))?.status).toEqual("creating");

        const deleted: string[] = [];
        yield* stack.destroy().pipe(
          hook({
            read: () =>
              Effect.die(
                new Error("SchemaError: Expected string, got undefined"),
              ),
            delete: (id) => Effect.sync(() => void deleted.push(id)),
          }),
        );

        // Recovery failed — delete is not invoked, state is still dropped.
        expect(deleted).toEqual([]);
        expect(yield* getState("A")).toBeUndefined();
      }),
  );

  test.provider(
    "destroy drops an attr-less creating row when the provider has no read",
    (stack) =>
      Effect.gen(function* () {
        // Manufacture the interrupted-create row directly: Test.Queue's
        // provider implements no `read`, so recovery is impossible and the
        // engine can only drop the row (surfacing a note, not crashing).
        const state = yield* yield* State;
        const stk = yield* Stack;
        yield* state.set({
          stack: stk.name,
          stage: stk.stage,
          fqn: "Q",
          value: {
            kind: "resource",
            status: "creating",
            resourceType: "Test.Queue",
            namespace: undefined,
            fqn: "Q",
            logicalId: "Q",
            instanceId: "q-instance",
            providerVersion: 0,
            downstream: [],
            bindings: [],
            props: { name: "q" },
          } satisfies CreatingResourceState,
        });

        yield* stack.destroy();
        expect(yield* getState("Q")).toBeUndefined();
      }),
  );

  test.provider(
    "replacement drain recovers and deletes an attr-less old generation",
    (stack) =>
      Effect.gen(function* () {
        // 1. Interrupted create — `creating` row with no attr.
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "original",
          });
        }).pipe(stack.deploy, hook());
        expect((yield* getState("A"))?.status).toEqual("creating");
        expect((yield* getState("A"))?.attr).toBeUndefined();

        // 2. Deploy a replacement. The first `read` (plan-time create-resume
        // probe) reports not-found so the engine plans a replacement instead
        // of resuming the create; the drain-time `read` then discovers the
        // physical resource the interrupted create actually made, and the
        // engine must delete it while draining the replaced old generation.
        const deleted: string[] = [];
        let reads = 0;
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "new",
          });
        }).pipe(
          stack.deploy,
          hook({
            read: () =>
              Effect.sync(() => ++reads).pipe(
                Effect.map((n) =>
                  n === 1 ? undefined : { replaceString: "original" },
                ),
              ),
            delete: (id) => Effect.sync(() => void deleted.push(id)),
          }),
        );

        // The old generation's physical resource was recovered and deleted,
        // and the replacement collapsed to a stable `created` row.
        expect(deleted).toEqual(["A"]);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect(
          ((yield* getState("A"))?.attr as TestResourceProps)?.replaceString,
        ).toEqual("new");
      }),
  );

  test.provider(
    "resuming an interrupted create fails loudly when the recovered resource is Unowned",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(stack.deploy, hook());
        expect((yield* getState("A"))?.status).toEqual("creating");

        const exit = yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(
          stack.deploy,
          hook({
            read: () => Effect.succeed(Unowned({ string: "foreign" })),
          }),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const reason = exit.cause.reasons.find(Cause.isFailReason);
          expect((reason?.error as any)?._tag).toBe("OwnedBySomeoneElse");
        }
        // The row is untouched — the user can re-run with --adopt.
        expect((yield* getState("A"))?.status).toEqual("creating");
      }),
  );

  test.provider(
    "resuming an interrupted create with adopt(true) takes over an Unowned resource",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(stack.deploy, hook());
        expect((yield* getState("A"))?.status).toEqual("creating");

        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(
          adopt(true),
          stack.deploy,
          hook({
            read: () => Effect.succeed(Unowned({ string: "test-string" })),
          }),
        );

        const persisted = yield* getState("A");
        expect(persisted?.status).toEqual("created");
        // The Unowned brand never reaches persisted state.
        expect(Unowned.is(persisted?.attr)).toBe(false);
      }),
  );
});

describe("from updating state", { tags: ["unit", "local"] }, () => {
  test.provider("continue updating when props unchanged", (stack) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string",
        });
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string-changed",
        });
      }).pipe(
        stack.deploy,
        hook({
          update: () => Effect.fail(new ResourceFailure()),
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("updating");

      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "test-string-changed",
        });
        return A.string;
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("updated");
      expect(output).toEqual("test-string-changed");
    }),
  );

  test.provider(
    "continue updating when props have updatable changes",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");

        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string-changed",
          });
        }).pipe(
          stack.deploy,
          hook({
            update: () => Effect.fail(new ResourceFailure()),
          }),
        );
        expect((yield* getState("A"))?.status).toEqual("updating");

        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string-changed-again",
          });
          return A.string;
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("updated");
        expect(output).toEqual("test-string-changed-again");
      }),
  );

  test.provider("replace when props trigger replacement", (stack) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string",
          replaceString: "original",
        });
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "test-string-changed",
          replaceString: "original",
        });
      }).pipe(
        stack.deploy,
        hook({
          update: () => Effect.fail(new ResourceFailure()),
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("updating");

      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "test-string-changed",
          replaceString: "changed",
        });
        return A.replaceString;
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("changed");
    }),
  );
});

describe("from replacing state", { tags: ["unit", "local"] }, () => {
  test.provider("continue replacement when props unchanged", (stack) =>
    Effect.gen(function* () {
      // 1. Create initial resource
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "original",
        });
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      // 2. Trigger replacement but fail during create of replacement
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "new",
        });
      }).pipe(
        stack.deploy,
        hook({
          create: () => Effect.fail(new ResourceFailure()),
        }),
      );
      const state = yield* getState<ReplacingResourceState>("A");
      expect(state?.status).toEqual("replacing");
      expect(state?.old?.status).toEqual("created");

      // 3. Re-apply with same props - should continue replacement
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          replaceString: "new",
        });
        return A.replaceString;
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("new");
    }),
  );

  test.provider(
    "continue replacement when props have updatable changes",
    (stack) =>
      Effect.gen(function* () {
        // 1. Create initial resource
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "original",
            string: "initial",
          });
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");

        // 2. Trigger replacement but fail during create
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "new",
            string: "initial",
          });
        }).pipe(
          stack.deploy,
          hook({
            create: () => Effect.fail(new ResourceFailure()),
          }),
        );
        expect((yield* getState("A"))?.status).toEqual("replacing");

        // 3. Re-apply with changed props (updatable) - should continue replacement with new props
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            replaceString: "new",
            string: "changed",
          });
          return { replaceString: A.replaceString, string: A.string };
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect(output.replaceString).toEqual("new");
        expect(output.string).toEqual("changed");
      }),
  );

  test.provider(
    "continue replacement when props trigger another replacement",
    (stack) =>
      Effect.gen(function* () {
        // 1. Create initial resource
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "original",
          });
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");

        // 2. Trigger replacement but fail during create
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "new",
          });
        }).pipe(
          stack.deploy,
          hook({
            create: () => Effect.fail(new ResourceFailure()),
          }),
        );
        expect((yield* getState("A"))?.status).toEqual("replacing");

        // 3. Replace again with another replacement - should converge
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            replaceString: "another-replacement",
          });
          return A.replaceString;
        }).pipe(stack.deploy);
        expectConvergedStatus((yield* getState("A"))?.status);
        expect(output).toEqual("another-replacement");
      }),
  );
});

describe("from replaced state", { tags: ["unit", "local"] }, () => {
  test.provider("continue cleanup when props unchanged", (stack) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "test-string",
        });
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "test-string-changed",
        });
      }).pipe(
        stack.deploy,
        hook({
          delete: () => Effect.fail(new ResourceFailure()),
        }),
      );
      const AState = yield* getState<ReplacedResourceState>("A");
      expect(AState?.status).toEqual("replaced");
      expect(AState?.old).toMatchObject({
        status: "created",
        props: {
          replaceString: "test-string",
        },
      });

      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "test-string-changed",
        });
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
    }),
  );

  test.provider(
    "update replacement then cleanup when props have updatable changes",
    (stack) =>
      Effect.gen(function* () {
        // 1. Create initial resource
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "original",
            string: "initial",
          });
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");

        // 2. Trigger replacement and fail during delete of old resource
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "new",
            string: "initial",
          });
        }).pipe(
          stack.deploy,
          hook({
            delete: () => Effect.fail(new ResourceFailure()),
          }),
        );
        const state = yield* getState<ReplacedResourceState>("A");
        expect(state?.status).toEqual("replaced");
        expect(state?.old?.status).toEqual("created");

        // 3. Change props again (updatable change) - should update the replacement then cleanup
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            replaceString: "new",
            string: "changed",
          });
          return { replaceString: A.replaceString, string: A.string };
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect(output.replaceString).toEqual("new");
        expect(output.string).toEqual("changed");
      }),
  );

  test.provider(
    "continue cleanup when props trigger another replacement",
    (stack) =>
      Effect.gen(function* () {
        // 1. Create initial resource
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "original",
          });
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");

        // 2. Trigger replacement and fail during delete of old resource
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "new",
          });
        }).pipe(
          stack.deploy,
          hook({
            delete: () => Effect.fail(new ResourceFailure()),
          }),
        );
        expect((yield* getState("A"))?.status).toEqual("replaced");

        // 3. Replace again and continue cleanup of the older generations
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            replaceString: "another-replacement",
          });
          return A.replaceString;
        }).pipe(stack.deploy);
        expectConvergedStatus((yield* getState("A"))?.status);
        expect(output).toEqual("another-replacement");
      }),
  );
});

describe(
  "retain removal policy on replace",
  { tags: ["unit", "local"] },
  () => {
    test.provider(
      "replace with retain does not delete the old generation",
      (stack) =>
        Effect.gen(function* () {
          const deleted: string[] = [];

          // 1. Create initial resource with a retain removal policy.
          yield* Effect.gen(function* () {
            yield* TestResource("A", { replaceString: "v1" }).pipe(
              RemovalPolicy.retain(true),
            );
          }).pipe(stack.deploy);

          const before = yield* getState("A");
          expect(before?.status).toEqual("created");
          const oldInstanceId = before?.instanceId;

          // 2. Trigger a replacement (replaceString change). The old generation
          //    must NOT be deleted because the resource is retained.
          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { replaceString: "v2" }).pipe(
              RemovalPolicy.retain(true),
            );
            return A.replaceString;
          }).pipe(
            stack.deploy,
            hook({
              delete: (id) =>
                Effect.sync(() => {
                  deleted.push(id);
                }),
            }),
          );

          expect(output).toEqual("v2");
          // provider.delete must never fire for the retained old generation.
          expect(deleted).not.toContain("A");

          const after = yield* getState("A");
          // Resource was genuinely replaced (fresh instance id) and the old
          // chain drained back to a terminal `created` state.
          expect(after?.status).toEqual("created");
          expect(after?.instanceId).not.toEqual(oldInstanceId);
        }),
    );

    test.provider(
      "replace without retain deletes the old generation exactly once",
      (stack) =>
        Effect.gen(function* () {
          const deleted: string[] = [];

          // 1. Create initial resource with the default (destroy) policy.
          yield* Effect.gen(function* () {
            yield* TestResource("A", { replaceString: "v1" });
          }).pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");

          // 2. Trigger a replacement. The old generation must be deleted since
          //    the resource is not retained — guards the retain patch against
          //    disabling normal replacement GC.
          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { replaceString: "v2" });
            return A.replaceString;
          }).pipe(
            stack.deploy,
            hook({
              delete: (id) =>
                Effect.sync(() => {
                  deleted.push(id);
                }),
            }),
          );

          expect(output).toEqual("v2");
          expect(deleted.filter((id) => id === "A")).toHaveLength(1);
          expect((yield* getState("A"))?.status).toEqual("created");
        }),
    );

    test.provider(
      "nested replacement chain with retain never deletes old generations",
      (stack) =>
        Effect.gen(function* () {
          const deleted: string[] = [];

          // 1. Create with retain.
          yield* Effect.gen(function* () {
            yield* TestResource("A", { replaceString: "v1" }).pipe(
              RemovalPolicy.retain(true),
            );
          }).pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");

          // 2. Trigger a replacement but fail mid-create so a replacement chain
          //    forms (replacing, with old=created still live).
          yield* Effect.gen(function* () {
            yield* TestResource("A", { replaceString: "v2" }).pipe(
              RemovalPolicy.retain(true),
            );
          }).pipe(
            stack.deploy,
            hook({ create: () => Effect.fail(new ResourceFailure()) }),
          );
          expect((yield* getState("A"))?.status).toEqual("replacing");

          // 3. Replace again — converges and drains the entire old chain. Every
          //    old generation must be retained (no provider.delete calls).
          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { replaceString: "v3" }).pipe(
              RemovalPolicy.retain(true),
            );
            return A.replaceString;
          }).pipe(
            stack.deploy,
            hook({
              delete: (id) =>
                Effect.sync(() => {
                  deleted.push(id);
                }),
            }),
          );

          expect(output).toEqual("v3");
          expect(deleted).not.toContain("A");
          expect((yield* getState("A"))?.status).toEqual("created");
        }),
    );

    test.provider(
      "orphan delete still honors retain (regression guard)",
      (stack) =>
        Effect.gen(function* () {
          const deleted: string[] = [];
          const events: Array<{ id: string; status: string }> = [];

          yield* Effect.gen(function* () {
            yield* TestResource("A", { string: "v1" }).pipe(
              RemovalPolicy.retain(true),
            );
          }).pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");

          const plan = yield* Effect.void.pipe(stack.plan);
          expect(plan.deletions.A?.action).toBe("orphaned");

          // Destroy removes the resource from the stack. The explicit orphaned
          // action must skip provider.delete and just drop state.
          yield* stack.destroy().pipe(
            hook({
              delete: (id) =>
                Effect.sync(() => {
                  deleted.push(id);
                }),
            }),
            Effect.provide(Layer.succeed(Cli, recordingCli(events))),
          );

          expect(deleted).not.toContain("A");
          expect(yield* getState("A")).toBeUndefined();
          expect(
            events
              .filter((event) => event.id === "A")
              .map((event) => event.status),
          ).toEqual(["orphaning", "orphaned"]);
        }),
    );

    test.provider(
      "retain added to an already-created resource is persisted by the noop deploy",
      (stack) =>
        Effect.gen(function* () {
          // 1. Create with the default (destroy) policy.
          yield* Effect.gen(function* () {
            yield* TestResource("A", { string: "v1" });
          }).pipe(stack.deploy);
          expect((yield* getState("A"))?.removalPolicy).toEqual("destroy");

          // 2. Add `retain` — props are otherwise identical, so the resource
          //    plans as a noop. The policy is a declaration decoration, not a
          //    prop, so nothing about it can produce a diff; the noop path is
          //    the only pass that ever sees the change.
          const declaration = Effect.gen(function* () {
            yield* TestResource("A", { string: "v1" }).pipe(
              RemovalPolicy.retain(true),
            );
          });
          const plan = yield* declaration.pipe(stack.plan);
          expect(actionOfPlan(plan, "A")).toEqual("noop");
          yield* declaration.pipe(stack.deploy);
          expect((yield* getState("A"))?.removalPolicy).toEqual("retain");

          // 3. Remove the declaration — the orphan sweep reads the policy from
          //    state, so the provider's delete must never fire.
          const deleted: string[] = [];
          yield* stack.destroy().pipe(
            hook({
              delete: (id) =>
                Effect.sync(() => {
                  deleted.push(id);
                }),
            }),
          );
          expect(deleted).not.toContain("A");
          expect(yield* getState("A")).toBeUndefined();
        }),
    );

    test.provider(
      "retain removed from an already-created resource is persisted by the noop deploy",
      (stack) =>
        Effect.gen(function* () {
          // The inverse direction: a resource that was retained and is now
          // declared `destroy` must actually be deleted by the orphan sweep.
          yield* Effect.gen(function* () {
            yield* TestResource("A", { string: "v1" }).pipe(
              RemovalPolicy.retain(true),
            );
          }).pipe(stack.deploy);
          expect((yield* getState("A"))?.removalPolicy).toEqual("retain");

          yield* Effect.gen(function* () {
            yield* TestResource("A", { string: "v1" });
          }).pipe(stack.deploy);
          expect((yield* getState("A"))?.removalPolicy).toEqual("destroy");

          const deleted: string[] = [];
          yield* stack.destroy().pipe(
            hook({
              delete: (id) =>
                Effect.sync(() => {
                  deleted.push(id);
                }),
            }),
          );
          expect(deleted).toContain("A");
          expect(yield* getState("A")).toBeUndefined();
        }),
    );
  },
);

describe("from deleting state", { tags: ["unit", "local"] }, () => {
  test.provider(
    "create when props unchanged or have updatable changes",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            string: "test-string",
          });
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");

        yield* stack.destroy().pipe(
          hook({
            delete: () => Effect.fail(new ResourceFailure()),
          }),
        );
        expect((yield* getState("A"))?.status).toEqual("deleting");

        // Now re-apply with the same props - should create the resource again
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "test-string",
          });
          return A.string;
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect(output).toEqual("test-string");
      }),
  );

  // A destroy interrupted while `provider.delete` is still in flight (the
  // shape of a live delete stuck in a long provisioning wait — e.g.
  // CloudFront's disable→wait→delete — when the test runner's timeout fires
  // and teardown is abandoned) must keep the resource's state row. Deletes
  // are idempotent and resumable: the engine commits a `deleting` row BEFORE
  // calling `provider.delete` and only drops it after success, so the next
  // destroy sees the row and drains it. Losing the row here is an invisible
  // orphan — the next destroy plans "no changes" and the cloud resource
  // leaks forever.
  test.provider(
    "interrupting a destroy mid-delete keeps a resumable deleting row",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", { string: "v1" });
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");

        // Destroy with a delete that signals entry and then never resolves,
        // then interrupt the destroy once the delete is in flight —
        // simulating the runner's timeout + teardown abandonment.
        const deleteStarted = yield* Deferred.make<void>();
        const fiber = yield* stack.destroy().pipe(
          hook({
            delete: () =>
              Deferred.succeed(deleteStarted, void 0).pipe(
                Effect.andThen(Effect.never),
              ),
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(deleteStarted);
        yield* Fiber.interrupt(fiber);

        // The row survives the interruption, parked at `deleting`.
        expect((yield* getState("A"))?.status).toEqual("deleting");

        // The next destroy resumes the delete and drains the row.
        yield* stack.destroy();
        expect(yield* getState("A")).toBeUndefined();
        expect(yield* listState()).toEqual([]);
      }),
  );

  test.provider("create when props trigger replacement", (stack) =>
    Effect.gen(function* () {
      // 1. Create initial resource
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          replaceString: "original",
        });
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      // 2. Try to delete but fail
      yield* stack.destroy().pipe(
        hook({
          delete: () => Effect.fail(new ResourceFailure()),
        }),
      );
      expect((yield* getState("A"))?.status).toEqual("deleting");

      // 3. Re-apply with props that trigger replacement - should recreate
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          replaceString: "new",
        });
        return A.replaceString;
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect(output).toEqual("new");
    }),
  );
});

// =============================================================================
// DEPENDENT RESOURCES (A -> B where B depends on A.string)
// =============================================================================

describe("dependent resources (A -> B)", { tags: ["unit", "local"] }, () => {
  describe("happy path", () => {
    test.provider("create A then B where B uses A.string", (stack) =>
      Effect.gen(function* () {
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        }).pipe(stack.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(output.A.string).toEqual("a-value");
        expect(output.B.string).toEqual("a-value");
      }),
    );

    test.provider("update A propagates to B", (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Update A's string - B should update with the new value
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value-updated" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        }).pipe(stack.deploy);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.A.string).toEqual("a-value-updated");
        expect(output.B.string).toEqual("a-value-updated");
      }),
    );

    test.provider("replace A, B updates to new A's output", (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value",
            replaceString: "original",
          });
          yield* TestResource("B", { string: A.string });
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Replace A - B should update to point to new A's output
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value-new",
            replaceString: "changed",
          });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        }).pipe(stack.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.A.string).toEqual("a-value-new");
        expect(output.B.string).toEqual("a-value-new");
      }),
    );

    test.provider("delete both resources (B deleted first, then A)", (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");

        yield* stack.destroy();

        expect(yield* getState("A")).toBeUndefined();
        expectNotStarted(yield* getState("B"));
        expect(yield* listState()).toEqual([]);
      }),
    );
  });

  describe("failures during expandAndPivot", () => {
    test.provider(
      "A create fails, B never starts - recovery creates both",
      (stack) =>
        Effect.gen(function* () {
          // A fails to create - B should never start
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            yield* TestResource("B", { string: A.string });
          }).pipe(stack.deploy, hook(failOn("A", "create")));

          expect((yield* getState("A"))?.status).toEqual("creating");
          expectNotStarted(yield* getState("B"));

          // Recovery: re-apply should create both
          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            return { A, B };
          }).pipe(stack.deploy);

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect(output.A.string).toEqual("a-value");
          expect(output.B.string).toEqual("a-value");
        }),
    );

    test.provider("A creates, B create fails - recovery creates B", (stack) =>
      Effect.gen(function* () {
        // A succeeds, B fails to create
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(stack.deploy, hook(failOn("B", "create")));

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("creating");

        // Recovery: re-apply should noop A and create B
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        }).pipe(stack.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(output.B.string).toEqual("a-value");
      }),
    );

    test.provider("A update fails - recovery updates both", (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(stack.deploy);

        const program = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value-updated" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        });

        // A fails to update - B should not start updating
        yield* program.pipe(stack.deploy, hook(failOn("A", "update")));

        expect((yield* getState("A"))?.status).toEqual("updating");
        expect((yield* getState("B"))?.status).toEqual("created");

        // Recovery: re-apply should update both
        const output = yield* program.pipe(stack.deploy);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.A.string).toEqual("a-value-updated");
        expect(output.B.string).toEqual("a-value-updated");
      }),
    );

    test.provider("A updates, B update fails - recovery updates B", (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          yield* TestResource("B", { string: A.string });
        }).pipe(stack.deploy);

        const program = Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value-updated" });
          const B = yield* TestResource("B", { string: A.string });
          return { A, B };
        });

        // A succeeds, B fails to update
        yield* program.pipe(stack.deploy, hook(failOn("B", "update")));

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updating");

        // Recovery: re-apply should noop A and update B
        const output = yield* program.pipe(stack.deploy);

        expect((yield* getState("A"))?.status).toEqual("updated");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect(output.B.string).toEqual("a-value-updated");
      }),
    );

    test.provider(
      "A replacement fails - recovery replaces A and updates B",
      (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value",
              replaceString: "original",
            });
            yield* TestResource("B", { string: A.string });
          }).pipe(stack.deploy);

          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value-new",
              replaceString: "changed",
            });
            const B = yield* TestResource("B", { string: A.string });
            return { A, B };
          });

          // A replacement fails (during create of new A) - B should not start
          yield* program.pipe(stack.deploy, hook(failOn("A", "create")));

          expect(
            (yield* getState<ReplacingResourceState>("A"))?.status,
          ).toEqual("replacing");
          expect((yield* getState("B"))?.status).toEqual("created");

          // Recovery: re-apply should complete A replacement and update B
          const output = yield* program.pipe(stack.deploy);

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect(output.A.string).toEqual("a-value-new");
          expect(output.B.string).toEqual("a-value-new");
        }),
    );

    test.provider(
      "A replaced, B update fails - recovery updates B then cleans up",
      (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value",
              replaceString: "original",
            });
            yield* TestResource("B", { string: A.string });
          }).pipe(stack.deploy);

          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value-new",
              replaceString: "changed",
            });
            const B = yield* TestResource("B", { string: A.string });
            return { A, B };
          });

          // A replacement succeeds, B fails to update
          yield* program.pipe(stack.deploy, hook(failOn("B", "update")));

          // A should be in replaced state (new A created, old A pending cleanup)
          // B should be in updating state
          const aState = yield* getState<ReplacedResourceState>("A");
          expect(aState?.status).toEqual("replaced");
          expect((yield* getState("B"))?.status).toEqual("updating");

          // Recovery: re-apply should update B and clean up old A
          const output = yield* program.pipe(stack.deploy);

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect(output.B.string).toEqual("a-value-new");
        }),
    );
  });

  describe("failures during collectGarbage", () => {
    test.provider(
      "A replaced, B updated, old A delete fails - recovery cleans up",
      (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value",
              replaceString: "original",
            });
            yield* TestResource("B", { string: A.string });
          }).pipe(stack.deploy);

          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value-new",
              replaceString: "changed",
            });
            const B = yield* TestResource("B", { string: A.string });
            return { A, B };
          });

          // A replacement and B update succeed, but old A delete fails
          yield* program.pipe(stack.deploy, hook(failOn("A", "delete")));

          // A should be in replaced state (delete of old A failed)
          // B should have been updated successfully
          expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
            "replaced",
          );
          expect((yield* getState("B"))?.status).toEqual("updated");

          // Recovery: re-apply should clean up old A
          const output = yield* program.pipe(stack.deploy);

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect(output.A.string).toEqual("a-value-new");
        }),
    );

    test.provider(
      "orphan B delete fails - recovery deletes B then A",
      (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            yield* TestResource("B", { string: A.string });
          }).pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");

          // Orphan deletion: B delete fails
          yield* stack.destroy().pipe(hook(failOn("B", "delete")));

          // B should be in deleting state, A should still be created (waiting for B)
          expect((yield* getState("B"))?.status).toEqual("deleting");
          expect((yield* getState("A"))?.status).toEqual("created");

          // Recovery: re-apply destroy should delete B then A
          yield* stack.destroy();

          expect(yield* getState("A")).toBeUndefined();
          expectNotStarted(yield* getState("B"));
        }),
    );

    test.provider(
      "orphan A delete fails after B deleted - recovery deletes A",
      (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            yield* TestResource("B", { string: A.string });
          }).pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");

          // Orphan deletion: B succeeds, A fails
          yield* stack.destroy().pipe(hook(failOn("A", "delete")));

          // B should be deleted, A should be in deleting state
          expectNotStarted(yield* getState("B"));
          expect((yield* getState("A"))?.status).toEqual("deleting");

          // Recovery: re-apply destroy should delete A
          yield* stack.destroy();

          expect(yield* getState("A")).toBeUndefined();
        }),
    );
  });
});

// =============================================================================
// THREE-LEVEL DEPENDENCY CHAIN (A -> B -> C where C depends on B, B depends on A)
// =============================================================================

describe(
  "three-level dependency chain (A -> B -> C)",
  { tags: ["unit", "local"] },
  () => {
    describe("happy path", () => {
      test.provider("create A then B then C", (stack) =>
        Effect.gen(function* () {
          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: B.string });
            return { A, B, C };
          }).pipe(stack.deploy);

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect(output.A.string).toEqual("a-value");
          expect(output.B.string).toEqual("a-value");
          expect(output.C.string).toEqual("a-value");
        }),
      );

      test.provider("update A propagates through B to C", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
          }).pipe(stack.deploy);

          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value-updated" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: B.string });
            return { A, B, C };
          }).pipe(stack.deploy);

          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updated");
          expect(output.C.string).toEqual("a-value-updated");
        }),
      );

      test.provider("replace A propagates through B to C", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value",
              replaceString: "original",
            });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
          }).pipe(stack.deploy);

          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value-new",
              replaceString: "changed",
            });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: B.string });
            return { A, B, C };
          }).pipe(stack.deploy);

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updated");
          expect(output.C.string).toEqual("a-value-new");
        }),
      );

      test.provider("delete all three (C first, then B, then A)", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
          }).pipe(stack.deploy);

          yield* stack.destroy();

          expect(yield* getState("A")).toBeUndefined();
          expectNotStarted(yield* getState("B"));
          expectNotStarted(yield* getState("C"));
          expect(yield* listState()).toEqual([]);
        }),
      );
    });

    describe("creation failures", () => {
      test.provider("A create fails - B and C never start", (stack) =>
        Effect.gen(function* () {
          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: B.string });
            return { A, B, C };
          });

          yield* program.pipe(stack.deploy, hook(failOn("A", "create")));

          expect((yield* getState("A"))?.status).toEqual("creating");
          expectNotStarted(yield* getState("B"));
          expectNotStarted(yield* getState("C"));

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect(output.C.string).toEqual("a-value");
        }),
      );

      test.provider("A creates, B create fails - C never starts", (stack) =>
        Effect.gen(function* () {
          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: B.string });
            return { A, B, C };
          });

          yield* program.pipe(stack.deploy, hook(failOn("B", "create")));

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("creating");
          expectNotStarted(yield* getState("C"));

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect(output.C.string).toEqual("a-value");
        }),
      );

      test.provider("A and B create, C create fails", (stack) =>
        Effect.gen(function* () {
          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: B.string });
            return { A, B, C };
          });

          yield* program.pipe(stack.deploy, hook(failOn("C", "create")));

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("creating");

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect(output.C.string).toEqual("a-value");
        }),
      );
    });

    describe("update failures", () => {
      test.provider("A update fails - B and C remain stable", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
          }).pipe(stack.deploy);

          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value-updated" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: B.string });
            return { A, B, C };
          });

          yield* program.pipe(stack.deploy, hook(failOn("A", "update")));

          expect((yield* getState("A"))?.status).toEqual("updating");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updated");
          expect(output.C.string).toEqual("a-value-updated");
        }),
      );

      test.provider("A updates, B update fails - C remains stable", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
          }).pipe(stack.deploy);

          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value-updated" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: B.string });
            return { A, B, C };
          });

          yield* program.pipe(stack.deploy, hook(failOn("B", "update")));

          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("updating");
          expect((yield* getState("C"))?.status).toEqual("created");

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updated");
          expect(output.C.string).toEqual("a-value-updated");
        }),
      );

      test.provider("A and B update, C update fails", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
          }).pipe(stack.deploy);

          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value-updated" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: B.string });
            return { A, B, C };
          });

          yield* program.pipe(stack.deploy, hook(failOn("C", "update")));

          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updating");

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updated");
          expect(output.C.string).toEqual("a-value-updated");
        }),
      );
    });

    describe("replace cascade failures", () => {
      test.provider("A replace fails - B and C remain stable", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value",
              replaceString: "original",
            });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
          }).pipe(stack.deploy);

          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value-new",
              replaceString: "changed",
            });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: B.string });
            return { A, B, C };
          });

          yield* program.pipe(stack.deploy, hook(failOn("A", "create")));

          expect(
            (yield* getState<ReplacingResourceState>("A"))?.status,
          ).toEqual("replacing");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updated");
          expect(output.C.string).toEqual("a-value-new");
        }),
      );

      test.provider("A replaced, B update fails - C remains stable", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value",
              replaceString: "original",
            });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
          }).pipe(stack.deploy);

          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value-new",
              replaceString: "changed",
            });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: B.string });
            return { A, B, C };
          });

          yield* program.pipe(stack.deploy, hook(failOn("B", "update")));

          expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
            "replaced",
          );
          expect((yield* getState("B"))?.status).toEqual("updating");
          expect((yield* getState("C"))?.status).toEqual("created");

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updated");
          expect(output.C.string).toEqual("a-value-new");
        }),
      );

      test.provider("A replaced, B updated, C update fails", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value",
              replaceString: "original",
            });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
          }).pipe(stack.deploy);

          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "a-value-new",
              replaceString: "changed",
            });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: B.string });
            return { A, B, C };
          });

          yield* program.pipe(stack.deploy, hook(failOn("C", "update")));

          expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
            "replaced",
          );
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updating");

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updated");
          expect(output.C.string).toEqual("a-value-new");
        }),
      );

      test.provider(
        "A replaced, B and C updated, old A delete fails - recovery cleans up",
        (stack) =>
          Effect.gen(function* () {
            yield* Effect.gen(function* () {
              const A = yield* TestResource("A", {
                string: "a-value",
                replaceString: "original",
              });
              const B = yield* TestResource("B", { string: A.string });
              yield* TestResource("C", { string: B.string });
            }).pipe(stack.deploy);

            const program = Effect.gen(function* () {
              const A = yield* TestResource("A", {
                string: "a-value-new",
                replaceString: "changed",
              });
              const B = yield* TestResource("B", { string: A.string });
              const C = yield* TestResource("C", { string: B.string });
              return { A, B, C };
            });

            yield* program.pipe(stack.deploy, hook(failOn("A", "delete")));

            expect(
              (yield* getState<ReplacedResourceState>("A"))?.status,
            ).toEqual("replaced");
            expect((yield* getState("B"))?.status).toEqual("updated");
            expect((yield* getState("C"))?.status).toEqual("updated");

            // Recovery
            const output = yield* program.pipe(stack.deploy);
            expect((yield* getState("A"))?.status).toEqual("created");
            expect((yield* getState("B"))?.status).toEqual("updated");
            expect((yield* getState("C"))?.status).toEqual("updated");
            expect(output.C.string).toEqual("a-value-new");
          }),
      );
    });

    describe("delete order failures", () => {
      test.provider("C delete fails - A and B waiting", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
          }).pipe(stack.deploy);

          yield* stack.destroy().pipe(hook(failOn("C", "delete")));

          expect((yield* getState("C"))?.status).toEqual("deleting");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("A"))?.status).toEqual("created");

          // Recovery
          yield* stack.destroy();
          expect(yield* getState("A")).toBeUndefined();
          expectNotStarted(yield* getState("B"));
          expectNotStarted(yield* getState("C"));
        }),
      );

      test.provider("C deleted, B delete fails - A waiting", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
          }).pipe(stack.deploy);

          yield* stack.destroy().pipe(hook(failOn("B", "delete")));

          expectNotStarted(yield* getState("C"));
          expect((yield* getState("B"))?.status).toEqual("deleting");
          expect((yield* getState("A"))?.status).toEqual("created");

          // Recovery
          yield* stack.destroy();
          expect(yield* getState("A")).toBeUndefined();
          expectNotStarted(yield* getState("B"));
        }),
      );

      test.provider("C and B deleted, A delete fails", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
          }).pipe(stack.deploy);

          yield* stack.destroy().pipe(hook(failOn("A", "delete")));

          expectNotStarted(yield* getState("C"));
          expectNotStarted(yield* getState("B"));
          expect((yield* getState("A"))?.status).toEqual("deleting");

          // Recovery
          yield* stack.destroy();
          expect(yield* getState("A")).toBeUndefined();
        }),
      );
    });
  },
);

// =============================================================================
// DIAMOND DEPENDENCIES (D depends on B and C, both depend on A)
//     A
//    / \
//   B   C
//    \ /
//     D
// =============================================================================

describe(
  "diamond dependencies (A -> B,C -> D)",
  { tags: ["unit", "local"] },
  () => {
    describe("happy path", () => {
      test.provider("create all four resources", (stack) =>
        Effect.gen(function* () {
          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: A.string });
            const D = yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
            return { A, B, C, D };
          }).pipe(stack.deploy);

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.D.string).toEqual("a-value-a-value");
        }),
      );

      test.provider("update A propagates to B, C, and D", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: A.string });
            yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
          }).pipe(stack.deploy);

          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "updated" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: A.string });
            const D = yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
            return { A, B, C, D };
          }).pipe(stack.deploy);

          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updated");
          expect((yield* getState("D"))?.status).toEqual("updated");
          expect(output.D.string).toEqual("updated-updated");
        }),
      );

      test.provider("add D while B replaces and C noops", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            yield* TestResource("B", {
              string: Output.interpolate`${A.string}-b`,
              replaceString: "b-original",
            });
            yield* TestResource("C", {
              string: Output.interpolate`${A.string}-c`,
              replaceString: "c-original",
            });
          }).pipe(stack.deploy);

          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", {
              string: Output.interpolate`${A.string}-b-replaced`,
              replaceString: "b-changed",
            });
            const C = yield* TestResource("C", {
              string: Output.interpolate`${A.string}-c`,
              replaceString: "c-original",
            });
            const D = yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
            return { A, B, C, D };
          }).pipe(stack.deploy);

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.B.replaceString).toEqual("b-changed");
          expect(output.C.replaceString).toEqual("c-original");
          expect(output.D.string).toEqual("a-value-b-replaced-a-value-c");
        }),
      );

      test.provider("add D while C replaces and B noops", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            yield* TestResource("B", {
              string: Output.interpolate`${A.string}-b`,
              replaceString: "b-original",
            });
            yield* TestResource("C", {
              string: Output.interpolate`${A.string}-c`,
              replaceString: "c-original",
            });
          }).pipe(stack.deploy);

          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", {
              string: Output.interpolate`${A.string}-b`,
              replaceString: "b-original",
            });
            const C = yield* TestResource("C", {
              string: Output.interpolate`${A.string}-c-replaced`,
              replaceString: "c-changed",
            });
            const D = yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
            return { A, B, C, D };
          }).pipe(stack.deploy);

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.B.replaceString).toEqual("b-original");
          expect(output.C.replaceString).toEqual("c-changed");
          expect(output.D.string).toEqual("a-value-b-a-value-c-replaced");
        }),
      );

      test.provider("add D while both B and C replace", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            yield* TestResource("B", {
              string: Output.interpolate`${A.string}-b`,
              replaceString: "b-original",
            });
            yield* TestResource("C", {
              string: Output.interpolate`${A.string}-c`,
              replaceString: "c-original",
            });
          }).pipe(stack.deploy);

          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", {
              string: Output.interpolate`${A.string}-b-replaced`,
              replaceString: "b-changed",
            });
            const C = yield* TestResource("C", {
              string: Output.interpolate`${A.string}-c-replaced`,
              replaceString: "c-changed",
            });
            const D = yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
            return { A, B, C, D };
          }).pipe(stack.deploy);

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.B.replaceString).toEqual("b-changed");
          expect(output.C.replaceString).toEqual("c-changed");
          expect(output.D.string).toEqual(
            "a-value-b-replaced-a-value-c-replaced",
          );
        }),
      );

      test.provider("delete all (D first, then B and C, then A)", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: A.string });
            yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
          }).pipe(stack.deploy);

          yield* stack.destroy();

          expect(yield* getState("A")).toBeUndefined();
          expectNotStarted(yield* getState("B"));
          expectNotStarted(yield* getState("C"));
          expectNotStarted(yield* getState("D"));
        }),
      );
    });

    describe("creation failures", () => {
      test.provider("A create fails - B, C, D never start", (stack) =>
        Effect.gen(function* () {
          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: A.string });
            const D = yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
            return { A, B, C, D };
          });

          yield* program.pipe(stack.deploy, hook(failOn("A", "create")));

          expect((yield* getState("A"))?.status).toEqual("creating");
          expectNotStarted(yield* getState("B"));
          expectNotStarted(yield* getState("C"));
          expectNotStarted(yield* getState("D"));

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.D.string).toEqual("a-value-a-value");
        }),
      );

      test.provider(
        "A creates, B create fails - C may create, D stuck",
        (stack) =>
          Effect.gen(function* () {
            const program = Effect.gen(function* () {
              const A = yield* TestResource("A", { string: "a-value" });
              const B = yield* TestResource("B", { string: A.string });
              const C = yield* TestResource("C", { string: A.string });
              const D = yield* TestResource("D", {
                string: Output.interpolate`${B.string}-${C.string}`,
              });
              return { A, B, C, D };
            });

            yield* program.pipe(stack.deploy, hook(failOn("B", "create")));

            expect((yield* getState("A"))?.status).toEqual("created");
            expect((yield* getState("B"))?.status).toEqual("creating");
            // C might have been created since it doesn't depend on B
            const cState = yield* getState("C");
            expect(cState === undefined || cState?.status === "created").toBe(
              true,
            );
            expectNotStarted(yield* getState("D"));

            // Recovery
            const output = yield* program.pipe(stack.deploy);
            expect((yield* getState("A"))?.status).toEqual("created");
            expect((yield* getState("B"))?.status).toEqual("created");
            expect((yield* getState("C"))?.status).toEqual("created");
            expect((yield* getState("D"))?.status).toEqual("created");
            expect(output.D.string).toEqual("a-value-a-value");
          }),
      );

      test.provider(
        "A creates, C create fails - B may create, D stuck",
        (stack) =>
          Effect.gen(function* () {
            const program = Effect.gen(function* () {
              const A = yield* TestResource("A", { string: "a-value" });
              const B = yield* TestResource("B", { string: A.string });
              const C = yield* TestResource("C", { string: A.string });
              const D = yield* TestResource("D", {
                string: Output.interpolate`${B.string}-${C.string}`,
              });
              return { A, B, C, D };
            });

            yield* program.pipe(stack.deploy, hook(failOn("C", "create")));

            expect((yield* getState("A"))?.status).toEqual("created");
            expect((yield* getState("C"))?.status).toEqual("creating");
            // B might have been created since it doesn't depend on C
            const bState = yield* getState("B");
            expect(bState === undefined || bState?.status === "created").toBe(
              true,
            );
            expectNotStarted(yield* getState("D"));

            // Recovery
            const output = yield* program.pipe(stack.deploy);
            expect((yield* getState("A"))?.status).toEqual("created");
            expect((yield* getState("B"))?.status).toEqual("created");
            expect((yield* getState("C"))?.status).toEqual("created");
            expect((yield* getState("D"))?.status).toEqual("created");
            expect(output.D.string).toEqual("a-value-a-value");
          }),
      );

      test.provider("A, B, C create - D create fails", (stack) =>
        Effect.gen(function* () {
          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: A.string });
            const D = yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
            return { A, B, C, D };
          });

          yield* program.pipe(stack.deploy, hook(failOn("D", "create")));

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect((yield* getState("D"))?.status).toEqual("creating");

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.D.string).toEqual("a-value-a-value");
        }),
      );

      test.provider("both B and C fail to create - D stuck", (stack) =>
        Effect.gen(function* () {
          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: A.string });
            const D = yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
            return { A, B, C, D };
          });

          yield* program.pipe(
            stack.deploy,
            hook(
              failOnMultiple([
                { id: "B", hook: "create" },
                { id: "C", hook: "create" },
              ]),
            ),
          );

          expect((yield* getState("A"))?.status).toEqual("created");
          // effect terminates eagerly, so it's possible that B or C to run first and block C from running
          const BState = yield* getState("B");
          const CState = yield* getState("C");
          expect(BState?.status).toBeOneOf(["creating", undefined]);
          expect(CState?.status).toBeOneOf(["creating", undefined]);
          // at leasst one of B or C should have been created
          expect(BState?.status ?? CState?.status).toEqual("creating");

          expectNotStarted(yield* getState("D"));

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect((yield* getState("D"))?.status).toEqual("created");
          expect(output.D.string).toEqual("a-value-a-value");
        }),
      );
    });

    describe("update failures", () => {
      test.provider("A update fails - B, C, D remain stable", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: A.string });
            yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
          }).pipe(stack.deploy);

          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "updated" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: A.string });
            const D = yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
            return { A, B, C, D };
          });

          yield* program.pipe(stack.deploy, hook(failOn("A", "update")));

          expect((yield* getState("A"))?.status).toEqual("updating");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect((yield* getState("D"))?.status).toEqual("created");

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updated");
          expect((yield* getState("D"))?.status).toEqual("updated");
          expect(output.D.string).toEqual("updated-updated");
        }),
      );

      test.provider(
        "A updates, B update fails - C may update, D stuck",
        (stack) =>
          Effect.gen(function* () {
            yield* Effect.gen(function* () {
              const A = yield* TestResource("A", { string: "a-value" });
              const B = yield* TestResource("B", { string: A.string });
              const C = yield* TestResource("C", { string: A.string });
              yield* TestResource("D", {
                string: Output.interpolate`${B.string}-${C.string}`,
              });
            }).pipe(stack.deploy);

            const program = Effect.gen(function* () {
              const A = yield* TestResource("A", { string: "updated" });
              const B = yield* TestResource("B", { string: A.string });
              const C = yield* TestResource("C", { string: A.string });
              const D = yield* TestResource("D", {
                string: Output.interpolate`${B.string}-${C.string}`,
              });
              return { A, B, C, D };
            });

            yield* program.pipe(stack.deploy, hook(failOn("B", "update")));

            expect((yield* getState("A"))?.status).toEqual("updated");
            expect((yield* getState("B"))?.status).toEqual("updating");
            // C might have been updated since it doesn't depend on B
            const cState = yield* getState("C");
            expect(
              cState?.status === "created" || cState?.status === "updated",
            ).toBe(true);
            expect((yield* getState("D"))?.status).toEqual("created");

            // Recovery
            const output = yield* program.pipe(stack.deploy);
            expect((yield* getState("B"))?.status).toEqual("updated");
            expect((yield* getState("C"))?.status).toEqual("updated");
            expect((yield* getState("D"))?.status).toEqual("updated");
            expect(output.D.string).toEqual("updated-updated");
          }),
      );

      test.provider("A, B, C update - D update fails", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: A.string });
            yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
          }).pipe(stack.deploy);

          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "updated" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: A.string });
            const D = yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
            return { A, B, C, D };
          });

          yield* program.pipe(stack.deploy, hook(failOn("D", "update")));

          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect((yield* getState("C"))?.status).toEqual("updated");
          expect((yield* getState("D"))?.status).toEqual("updating");

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("D"))?.status).toEqual("updated");
          expect(output.D.string).toEqual("updated-updated");
        }),
      );
    });

    describe("delete failures", () => {
      test.provider("D delete fails - B, C, A waiting", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: A.string });
            const C = yield* TestResource("C", { string: A.string });
            yield* TestResource("D", {
              string: Output.interpolate`${B.string}-${C.string}`,
            });
          }).pipe(stack.deploy);

          yield* stack.destroy().pipe(hook(failOn("D", "delete")));

          expect((yield* getState("D"))?.status).toEqual("deleting");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect((yield* getState("C"))?.status).toEqual("created");
          expect((yield* getState("A"))?.status).toEqual("created");

          // Recovery
          yield* stack.destroy();
          expect(yield* getState("A")).toBeUndefined();
          expectNotStarted(yield* getState("B"));
          expectNotStarted(yield* getState("C"));
          expectNotStarted(yield* getState("D"));
        }),
      );

      test.provider(
        "D deleted, B delete fails - C may delete, A waiting",
        (stack) =>
          Effect.gen(function* () {
            yield* Effect.gen(function* () {
              const A = yield* TestResource("A", { string: "a-value" });
              const B = yield* TestResource("B", { string: A.string });
              const C = yield* TestResource("C", { string: A.string });
              yield* TestResource("D", {
                string: Output.interpolate`${B.string}-${C.string}`,
              });
            }).pipe(stack.deploy);

            yield* stack.destroy().pipe(hook(failOn("B", "delete")));

            expectNotStarted(yield* getState("D"));
            expect((yield* getState("B"))?.status).toEqual("deleting");
            // C may or may not be deleted depending on execution order
            const cState = yield* getState("C");
            expect(cState === undefined || cState?.status === "created").toBe(
              true,
            );
            expect((yield* getState("A"))?.status).toEqual("created");

            // Recovery
            yield* stack.destroy();
            expect(yield* getState("A")).toBeUndefined();
            expectNotStarted(yield* getState("B"));
            expectNotStarted(yield* getState("C"));
          }),
      );
    });
  },
);

// =============================================================================
// INDEPENDENT RESOURCES (no dependencies between them)
// =============================================================================

describe(
  "independent resources (A, B with no dependencies)",
  { tags: ["unit", "local"] },
  () => {
    describe("parallel failures", () => {
      test.provider("both A and B fail to create", (stack) =>
        Effect.gen(function* () {
          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: "b-value" });
            return { A, B };
          });

          yield* program.pipe(
            stack.deploy,
            hook(
              failOnMultiple([
                { id: "A", hook: "create" },
                { id: "B", hook: "create" },
              ]),
            ),
          );

          // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
          const AState = yield* getState("A");
          const BState = yield* getState("B");
          expect(AState?.status).toBeOneOf(["creating", undefined]);
          expect(BState?.status).toBeOneOf(["creating", undefined]);
          // at least one of A or B should have been creating
          expect(AState?.status ?? BState?.status).toEqual("creating");

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect(output.A.string).toEqual("a-value");
          expect(output.B.string).toEqual("b-value");
        }),
      );

      test.provider("A creates, B fails - recovery creates B", (stack) =>
        Effect.gen(function* () {
          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-value" });
            const B = yield* TestResource("B", { string: "b-value" });
            return { A, B };
          });

          yield* program.pipe(stack.deploy, hook(failOn("B", "create")));

          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("creating");

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("created");
          expect((yield* getState("B"))?.status).toEqual("created");
          expect(output.B.string).toEqual("b-value");
        }),
      );

      test.provider("A update fails, B update succeeds", (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            yield* TestResource("A", { string: "a-value" });
            yield* TestResource("B", { string: "b-value" });
          }).pipe(stack.deploy);

          const program = Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a-updated" });
            const B = yield* TestResource("B", { string: "b-updated" });
            return { A, B };
          });

          yield* program.pipe(stack.deploy, hook(failOn("A", "update")));

          expect((yield* getState("A"))?.status).toEqual("updating");
          // B might have been updated
          const bState = yield* getState("B");
          expect(
            bState?.status === "created" || bState?.status === "updated",
          ).toBe(true);

          // Recovery
          const output = yield* program.pipe(stack.deploy);
          expect((yield* getState("A"))?.status).toEqual("updated");
          expect((yield* getState("B"))?.status).toEqual("updated");
          expect(output.A.string).toEqual("a-updated");
          expect(output.B.string).toEqual("b-updated");
        }),
      );
    });

    describe("mixed state recovery", () => {
      test.provider(
        "A in creating, B in updating state - recovery completes both",
        (stack) =>
          Effect.gen(function* () {
            // First create B successfully
            yield* Effect.gen(function* () {
              yield* TestResource("B", { string: "b-value" });
            }).pipe(stack.deploy);
            expect((yield* getState("B"))?.status).toEqual("created");

            // Now try to create A and update B - A fails
            const program = Effect.gen(function* () {
              const A = yield* TestResource("A", { string: "a-value" });
              const B = yield* TestResource("B", { string: "b-updated" });
              return { A, B };
            });

            yield* program.pipe(
              stack.deploy,
              hook(
                failOnMultiple([
                  { id: "A", hook: "create" },
                  { id: "B", hook: "update" },
                ]),
              ),
            );

            // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
            const AState = yield* getState("A");
            const BState = yield* getState("B");
            expect(AState?.status).toBeOneOf(["creating", undefined]);
            expect(BState?.status).toBeOneOf(["created", "updating"]);
            // at least one of A or B should have started their failing operation
            expect(
              AState?.status === "creating" || BState?.status === "updating",
            ).toBe(true);

            // Recovery
            const output = yield* program.pipe(stack.deploy);
            expect((yield* getState("A"))?.status).toEqual("created");
            expect((yield* getState("B"))?.status).toEqual("updated");
            expect(output.A.string).toEqual("a-value");
            expect(output.B.string).toEqual("b-updated");
          }),
      );

      test.provider(
        "A in replacing, B in deleting state - complex recovery",
        (stack) =>
          Effect.gen(function* () {
            // Create both
            yield* Effect.gen(function* () {
              yield* TestResource("A", { replaceString: "original" });
              yield* TestResource("B", { string: "b-value" });
            }).pipe(stack.deploy);
            expect((yield* getState("A"))?.status).toEqual("created");
            expect((yield* getState("B"))?.status).toEqual("created");

            // Try to replace A and delete B (by not including B) - both fail
            const program = Effect.gen(function* () {
              yield* TestResource("A", { replaceString: "changed" });
            });

            yield* program.pipe(
              stack.deploy,
              hook(
                failOnMultiple([
                  { id: "A", hook: "create" },
                  { id: "B", hook: "delete" },
                ]),
              ),
            );

            // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
            const AState = yield* getState<ReplacingResourceState>("A");
            const BState = yield* getState("B");
            expect(AState?.status).toBeOneOf(["created", "replacing"]);
            expect(BState?.status).toBeOneOf(["created", "deleting"]);
            // at least one of A or B should have started their failing operation
            expect(
              AState?.status === "replacing" || BState?.status === "deleting",
            ).toBe(true);

            // Recovery - complete the replace and delete
            yield* program.pipe(stack.deploy);
            expect((yield* getState("A"))?.status).toEqual("created");
            expectNotStarted(yield* getState("B"));
          }),
      );
    });
  },
);

// =============================================================================
// MULTIPLE RESOURCES REPLACING SIMULTANEOUSLY
// =============================================================================

describe("multiple resources replacing", { tags: ["unit", "local"] }, () => {
  test.provider("two independent resources replace successfully", (stack) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* TestResource("A", { replaceString: "a-original" });
        yield* TestResource("B", { replaceString: "b-original" });
      }).pipe(stack.deploy);

      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { replaceString: "a-new" });
        const B = yield* TestResource("B", { replaceString: "b-new" });
        return { A, B };
      }).pipe(stack.deploy);

      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(output.A.replaceString).toEqual("a-new");
      expect(output.B.replaceString).toEqual("b-new");
    }),
  );

  test.provider(
    "A replace fails, B replace succeeds - recovery completes A",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", { replaceString: "a-original" });
          yield* TestResource("B", { replaceString: "b-original" });
        }).pipe(stack.deploy);

        const program = Effect.gen(function* () {
          const A = yield* TestResource("A", { replaceString: "a-new" });
          const B = yield* TestResource("B", { replaceString: "b-new" });
          return { A, B };
        });

        yield* program.pipe(stack.deploy, hook(failOn("A", "create")));

        expect((yield* getState<ReplacingResourceState>("A"))?.status).toEqual(
          "replacing",
        );
        // B might have been replaced
        const bState = yield* getState("B");
        expect(
          bState?.status === "created" ||
            bState?.status === "replacing" ||
            bState?.status === "replaced",
        ).toBe(true);

        // Recovery
        const output = yield* program.pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(output.A.replaceString).toEqual("a-new");
        expect(output.B.replaceString).toEqual("b-new");
      }),
  );

  test.provider(
    "both A and B replace fail - recovery completes both",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", { replaceString: "a-original" });
          yield* TestResource("B", { replaceString: "b-original" });
        }).pipe(stack.deploy);

        const program = Effect.gen(function* () {
          const A = yield* TestResource("A", { replaceString: "a-new" });
          const B = yield* TestResource("B", { replaceString: "b-new" });
          return { A, B };
        });

        yield* program.pipe(
          stack.deploy,
          hook(
            failOnMultiple([
              { id: "A", hook: "create" },
              { id: "B", hook: "create" },
            ]),
          ),
        );

        // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
        const AState = yield* getState<ReplacingResourceState>("A");
        const BState = yield* getState<ReplacingResourceState>("B");
        expect(AState?.status).toBeOneOf(["created", "replacing"]);
        expect(BState?.status).toBeOneOf(["created", "replacing"]);
        // at least one of A or B should have started replacing
        expect(
          AState?.status === "replacing" || BState?.status === "replacing",
        ).toBe(true);

        // Recovery
        const output = yield* program.pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(output.A.replaceString).toEqual("a-new");
        expect(output.B.replaceString).toEqual("b-new");
      }),
  );

  test.provider(
    "A replaced, B replacing - old A delete fails, B create fails - recovery completes both",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", { replaceString: "a-original" });
          yield* TestResource("B", { replaceString: "b-original" });
        }).pipe(stack.deploy);

        const program = Effect.gen(function* () {
          const A = yield* TestResource("A", { replaceString: "a-new" });
          const B = yield* TestResource("B", { replaceString: "b-new" });
          return { A, B };
        });

        yield* program.pipe(
          stack.deploy,
          hook(
            failOnMultiple([
              { id: "A", hook: "delete" },
              { id: "B", hook: "create" },
            ]),
          ),
        );

        // effect terminates eagerly, so it's possible that A or B runs first and blocks the other from running
        // A should be replaced (new created, old pending delete) or still replacing/created if B failed first
        // B should be replacing (new not yet created) or already created if A failed first
        const AState = yield* getState<ReplacedResourceState>("A");
        const BState = yield* getState<ReplacingResourceState>("B");
        expect(AState?.status).toBeOneOf(["created", "replacing", "replaced"]);
        expect(BState?.status).toBeOneOf(["created", "replacing"]);
        // at least one of A or B should have started their failing operation
        expect(
          AState?.status === "replaced" || BState?.status === "replacing",
        ).toBe(true);

        // Recovery
        const output = yield* program.pipe(stack.deploy);
        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect(output.A.replaceString).toEqual("a-new");
        expect(output.B.replaceString).toEqual("b-new");
      }),
  );
});

describe("repeated replacements", { tags: ["unit", "local"] }, () => {
  test.provider(
    "resource can be replaced again while still in replacing state",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", { replaceString: "a-original" });
        }).pipe(stack.deploy);

        const firstReplacement = Effect.gen(function* () {
          yield* TestResource("A", { replaceString: "a-first" });
        });

        yield* firstReplacement.pipe(stack.deploy, hook(failOn("A", "create")));

        const replacingState = yield* getState<ReplacingResourceState>("A");
        expect(replacingState?.status).toEqual("replacing");

        const secondReplacement = Effect.gen(function* () {
          yield* TestResource("A", { replaceString: "a-second" });
        });

        yield* secondReplacement.pipe(stack.deploy);

        const finalState = yield* getState("A");
        expectConvergedStatus(finalState?.status);
        expect(finalState?.props?.replaceString).toEqual("a-second");
      }),
  );

  test.provider(
    "resource can be replaced again while still in replaced state",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          yield* TestResource("A", { replaceString: "a-original" });
        }).pipe(stack.deploy);

        const firstReplacement = Effect.gen(function* () {
          yield* TestResource("A", { replaceString: "a-first" });
        });

        yield* firstReplacement.pipe(stack.deploy, hook(failOn("A", "delete")));

        const replacedState = yield* getState<ReplacedResourceState>("A");
        expect(replacedState?.status).toEqual("replaced");

        const secondReplacement = Effect.gen(function* () {
          yield* TestResource("A", { replaceString: "a-second" });
        });

        yield* secondReplacement.pipe(stack.deploy);

        const finalState = yield* getState("A");
        expectConvergedStatus(finalState?.status);
        expect(finalState?.props?.replaceString).toEqual("a-second");
      }),
  );
});

// =============================================================================
// ORPHAN CHAIN DELETION
// =============================================================================

describe("orphan chain deletion", { tags: ["unit", "local"] }, () => {
  test.provider("three-level orphan chain deleted in correct order", (stack) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-value" });
        const B = yield* TestResource("B", { string: A.string });
        yield* TestResource("C", { string: B.string });
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect((yield* getState("C"))?.status).toEqual("created");

      // Remove C from graph - should delete C only
      yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-value" });
        yield* TestResource("B", { string: A.string });
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expectNotStarted(yield* getState("C"));
    }),
  );

  test.provider(
    "orphan with intermediate failure recovers correctly",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "a-value" });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(stack.deploy);

        // Remove all three - C fails to delete
        yield* stack.destroy().pipe(hook(failOn("C", "delete")));

        expect((yield* getState("C"))?.status).toEqual("deleting");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("A"))?.status).toEqual("created");

        // Recovery
        yield* stack.destroy();
        expect(yield* getState("A")).toBeUndefined();
        expectNotStarted(yield* getState("B"));
        expectNotStarted(yield* getState("C"));
      }),
  );

  test.provider("partial orphan - remove leaf, add new dependent", (stack) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-value" });
        yield* TestResource("B", { string: A.string });
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");

      // Remove B, add C dependent on A
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-value" });
        const C = yield* TestResource("C", { string: A.string });
        return { A, C };
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expectNotStarted(yield* getState("B"));
      expect((yield* getState("C"))?.status).toEqual("created");
      expect(output.C.string).toEqual("a-value");
    }),
  );
});

// =============================================================================
// COMPLEX MIXED STATE SCENARIOS
// =============================================================================

describe("complex mixed state scenarios", { tags: ["unit", "local"] }, () => {
  test.provider("replace upstream while creating downstream", (stack) =>
    Effect.gen(function* () {
      // Create A
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "a-value",
          replaceString: "original",
        });
      }).pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");

      // Now add B dependent on A, and also replace A
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "a-value-new",
          replaceString: "changed",
        });
        const B = yield* TestResource("B", { string: A.string });
        return { A, B };
      }).pipe(stack.deploy);

      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("created");
      expect(output.A.string).toEqual("a-value-new");
      expect(output.B.string).toEqual("a-value-new");
    }),
  );

  test.provider("update upstream, create and delete in same apply", (stack) =>
    Effect.gen(function* () {
      // Create A and B
      yield* Effect.gen(function* () {
        yield* TestResource("A", { string: "a-value" });
        yield* TestResource("B", { string: "b-value" });
      }).pipe(stack.deploy);

      // Update A, delete B (by not including), create C
      const output = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-updated" });
        const C = yield* TestResource("C", { string: A.string });
        return { A, C };
      }).pipe(stack.deploy);

      expect((yield* getState("A"))?.status).toEqual("updated");
      expectNotStarted(yield* getState("B"));
      expect((yield* getState("C"))?.status).toEqual("created");
      expect(output.C.string).toEqual("a-updated");
    }),
  );

  test.provider(
    "chain reaction: A replace triggers B update triggers C update",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-value",
            replaceString: "original",
          });
          const B = yield* TestResource("B", { string: A.string });
          yield* TestResource("C", { string: B.string });
        }).pipe(stack.deploy);

        // Replace A - should cascade updates to B and C
        const output = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", {
            string: "a-replaced",
            replaceString: "changed",
          });
          const B = yield* TestResource("B", { string: A.string });
          const C = yield* TestResource("C", { string: B.string });
          return { A, B, C };
        }).pipe(stack.deploy);

        expect((yield* getState("A"))?.status).toEqual("created");
        expect((yield* getState("B"))?.status).toEqual("updated");
        expect((yield* getState("C"))?.status).toEqual("updated");
        expect(output.C.string).toEqual("a-replaced");
      }),
  );

  test.provider("multiple failures across all operation types", (stack) =>
    Effect.gen(function* () {
      // Setup: A, B created; C, D will be added
      yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "a-value",
          replaceString: "original",
        });
        yield* TestResource("B", { string: "b-value" });
      }).pipe(stack.deploy);

      // Complex operation: A replace, B update, C create, D not included (nothing to delete)
      const program = Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "a-replaced",
          replaceString: "changed",
        });
        const B = yield* TestResource("B", { string: "b-updated" });
        const C = yield* TestResource("C", { string: "c-value" });
        return { A, B, C };
      });

      // Fail on A replace (create phase) and C create
      yield* program.pipe(
        stack.deploy,
        hook(
          failOnMultiple([
            { id: "A", hook: "create" },
            { id: "C", hook: "create" },
          ]),
        ),
      );

      // effect terminates eagerly, so it's possible that A or C runs first and blocks the other from running
      const AState = yield* getState<ReplacingResourceState>("A");
      // B might have been updated
      const bState = yield* getState("B");
      expect(bState?.status === "created" || bState?.status === "updated").toBe(
        true,
      );
      const CState = yield* getState("C");
      expect(AState?.status).toBeOneOf(["created", "replacing"]);
      expect(CState?.status).toBeOneOf(["creating", undefined]);
      // at least one of A or C should have started their failing operation
      expect(
        AState?.status === "replacing" || CState?.status === "creating",
      ).toBe(true);

      // Recovery
      const output = yield* program.pipe(stack.deploy);
      expect((yield* getState("A"))?.status).toEqual("created");
      expect((yield* getState("B"))?.status).toEqual("updated");
      expect((yield* getState("C"))?.status).toEqual("created");
      expect(output.A.replaceString).toEqual("changed");
      expect(output.B.string).toEqual("b-updated");
      expect(output.C.string).toEqual("c-value");
    }),
  );
});

describe("artifacts", { tags: ["unit", "local"] }, () => {
  test.provider("shares artifacts from plan diff into apply update", (stack) =>
    Effect.gen(function* () {
      yield* Effect.gen(function* () {
        yield* ArtifactProbe("A", { value: "v1" });
      }).pipe(stack.deploy);

      const updated = yield* Effect.gen(function* () {
        const A = yield* ArtifactProbe("A", { value: "v2" });
        return { A };
      }).pipe(stack.deploy);

      expect(updated.A.value).toEqual("v2");
      expect(updated.A.artifactValue).toEqual("v2");
      expect((yield* getState("A"))?.status).toEqual("updated");
    }),
  );

  test.provider(
    "isolates artifact bags by FQN for namespaced resources with the same leaf logical ID",
    (stack) =>
      Effect.gen(function* () {
        const Site = (id: string, props: { value: string }) =>
          Effect.gen(function* () {
            return yield* ArtifactProbe("Shared", { value: props.value });
          }).pipe(Namespace.push(id));

        yield* Effect.gen(function* () {
          yield* Site("Left", { value: "left-v1" });
          yield* Site("Right", { value: "right-v1" });
        }).pipe(stack.deploy);

        const updated = yield* Effect.gen(function* () {
          const left = yield* Site("Left", { value: "left-v2" });
          const right = yield* Site("Right", { value: "right-v2" });
          return { left, right };
        }).pipe(stack.deploy);

        expect(updated.left.artifactValue).toEqual("left-v2");
        expect(updated.right.artifactValue).toEqual("right-v2");
        expect((yield* getState("Left/Shared"))?.status).toEqual("updated");
        expect((yield* getState("Right/Shared"))?.status).toEqual("updated");
      }),
  );
});

describe(
  "resource identity (fqn) threading",
  { tags: ["unit", "local"] },
  () => {
    test.provider(
      "threads the resource's fully-qualified name into handler inputs, distinct from the logical id",
      (stack) =>
        Effect.gen(function* () {
          // Deploy the probe under a namespace so its FQN ("Parent/leaf") is
          // NOT its bare logical id ("leaf"). The provider echoes both the `id`
          // and `fqn` it received back out as attributes.
          const { probe } = yield* Effect.gen(function* () {
            const probe = yield* Effect.gen(function* () {
              return yield* FqnProbe("leaf", {});
            }).pipe(Namespace.push("Parent"));
            return { probe };
          }).pipe(stack.deploy);

          // The engine passes the leaf logical id as `id` and the full
          // namespace-qualified name as `fqn`.
          expect(probe.id).toEqual("leaf");
          expect(probe.fqn).toEqual("Parent/leaf");
          expect((yield* getState("Parent/leaf"))?.status).toEqual("created");
        }),
    );
  },
);

// =============================================================================
// WHOLE-RESOURCE REFS RE-RESOLVE FRESH ATTRS AT APPLY
// The plan materializes a whole-resource reference to an *updating* upstream
// into its stable attributes for the downstream's `diff` — but the node's
// props keep the evaluable reference, so `reconcile` receives the upstream's
// fresh post-reconcile attributes, non-stable ones included. Baking the
// stables-only snapshot into node.props left e.g. a Lambda Alias pointing at
// the previous Lambda Version forever (#993's alias promotion bug).
// =============================================================================

describe(
  "whole-resource refs re-resolve fresh attrs at apply",
  { tags: ["unit", "local"] },
  () => {
    test.provider(
      "downstream reconcile sees the upstream's fresh non-stable attributes",
      (stack) =>
        Effect.gen(function* () {
          const observed: TestResourceProps[] = [];
          const capture = hook({
            create: () => Effect.void,
            update: (id, props) =>
              Effect.sync(() => {
                if (id === "B") {
                  observed.push(props);
                }
              }),
            delete: () => Effect.void,
          });

          const program = (version: string) =>
            Effect.gen(function* () {
              const A = yield* TestResource("A", { string: version });
              // B references the WHOLE upstream resource, not a single prop.
              return yield* TestResource("B", { object: A as any });
            });

          yield* program("v1").pipe(stack.deploy, capture);

          // A updates in place: the non-stable `string` changes while
          // `stableString` / `stableArray` stay put. B must re-reconcile
          // against A's FRESH attributes — not the stables-only snapshot the
          // plan hands B's diff.
          yield* program("v2").pipe(stack.deploy, capture);

          expect(observed).toHaveLength(1);
          const object = observed[0]!.object as any;
          expect(object.string).toBe("v2");
          expect(object.stableString).toBe("A");

          // The persisted props captured the fully-resolved attrs, so the next
          // no-op deploy diffs full-against-full instead of churning.
          const persisted = yield* getState("B");
          expect((persisted?.props as any).object.string).toBe("v2");

          yield* stack.destroy().pipe(capture);
        }),
    );

    test.provider(
      "host reconcile sees the upstream's fresh non-stable attributes through a binding",
      (stack) =>
        Effect.gen(function* () {
          // Captures the DIFF-facing binding rows the host provider observes
          // at plan time (materialized stables-only snapshots).
          const diffObserved: any[] = [];
          const capture = <A, Err, Req>(test: Effect.Effect<A, Err, Req>) =>
            test.pipe(
              Effect.provide(
                Layer.succeed(TestResourceHooks, {
                  diff: (id, newBindings) =>
                    Effect.sync(() => {
                      if (id === "Host") {
                        diffObserved.push(newBindings);
                      }
                    }),
                }),
              ),
            );

          const program = (version: string) =>
            Effect.gen(function* () {
              const A = yield* TestResource("A", { string: version });
              const host = yield* BindingTarget("Host", { name: "host" });
              // The binding data embeds the WHOLE upstream resource.
              yield* host.bind("FromA", { env: { A } } as any);
              return host;
            });

          yield* program("v1").pipe(stack.deploy, capture);
          const created = yield* getState("Host");
          expect((created?.bindings as any)[0].data.env.A.string).toBe("v1");

          // A updates in place: the host's `diff` compares against the
          // materialized stables-only snapshot, but the binding payload the
          // host's `reconcile` receives must re-resolve to A's FRESH
          // post-reconcile attributes at apply.
          yield* program("v2").pipe(stack.deploy, capture);

          // The plan-time diff saw the stables-only materialization.
          const lastDiff = diffObserved.at(-1);
          expect(lastDiff[0].data.env.A).toEqual({
            stableString: "A",
            stableArray: ["A"],
          });

          // The reconciled attr merged the fresh payload...
          const updated = yield* getState("Host");
          expect((updated?.attr as any).env.A.string).toBe("v2");
          // ...and the terminal commit persisted the RESOLVED payload the
          // provider reconciled with (#874).
          const bound = (updated?.bindings as any)[0].data.env.A;
          expect(bound.string).toBe("v2");
          expect(bound.stableString).toBe("A");

          // With full attrs persisted, the next plan diffs full-against-full
          // instead of churning on the stables-only snapshot.
          const rePlan = yield* program("v2").pipe(stack.plan, capture);
          expect((rePlan.resources as any).Host.action).toBe("noop");

          yield* stack.destroy().pipe(capture);
        }),
    );
  },
);

// =============================================================================
// STATIC STABLE PROPERTIES (provider.stables defined on provider, not in diff)
// This tests the bug where diff returns undefined but downstream resources
// depend on stable properties that should be preserved
// =============================================================================

describe(
  "static stable properties (provider.stables)",
  { tags: ["unit", "local"] },
  () => {
    describe("diff returns undefined with tag-only changes", () => {
      test.provider(
        "upstream has static stables, diff returns undefined, downstream depends on stableId",
        (stack) =>
          Effect.gen(function* () {
            // Stage 1: Create A with no tags, B depends on A.stableId
            {
              const output = yield* Effect.gen(function* () {
                const A = yield* StaticStablesResource("A", {
                  string: "value",
                });
                const B = yield* TestResource("B", { string: A.stableId });
                return { A, B };
              }).pipe(stack.deploy);
              expect(output.A.stableId).toEqual("stable-A");
              expect(output.B.string).toEqual("stable-A");
              expect((yield* getState("A"))?.status).toEqual("created");
              expect((yield* getState("B"))?.status).toEqual("created");
            }

            // Stage 2: Add tags to A - diff returns undefined, but arePropsChanged is true
            // B depends on A.stableId which should remain stable
            {
              const output = yield* Effect.gen(function* () {
                const A = yield* StaticStablesResource("A", {
                  string: "value",
                  tags: { Name: "tagged-resource" },
                });
                const B = yield* TestResource("B", { string: A.stableId });
                return { A, B };
              }).pipe(stack.deploy);
              // A should be updated (tags changed)
              expect(output.A.tags).toEqual({ Name: "tagged-resource" });
              // B should NOT be updated because stableId didn't change
              expect(output.B.string).toEqual("stable-A");
              expect((yield* getState("A"))?.status).toEqual("updated");
              // B should remain "created" (noop) since its input (stableId) didn't change
              expect((yield* getState("B"))?.status).toEqual("created");
            }
          }),
      );

      test.provider(
        "chain: A -> B -> C where B depends on A.stableId and C depends on B.stableString",
        (stack) =>
          Effect.gen(function* () {
            // Stage 1: Create chain
            {
              const output = yield* Effect.gen(function* () {
                const A = yield* StaticStablesResource("A", {
                  string: "initial",
                });
                const B = yield* TestResource("B", { string: A.stableId });
                const C = yield* TestResource("C", { string: B.stableString });
                return { A, B, C };
              }).pipe(stack.deploy);
              expect(output.A.stableId).toEqual("stable-A");
              expect(output.B.string).toEqual("stable-A");
              expect(output.C.string).toEqual("B");
            }

            // Stage 2: Change A's tags only - diff returns undefined
            // Neither B nor C should update since their inputs are stable
            {
              const output = yield* Effect.gen(function* () {
                const A = yield* StaticStablesResource("A", {
                  string: "initial",
                  tags: { Env: "production" },
                });
                const B = yield* TestResource("B", { string: A.stableId });
                const C = yield* TestResource("C", { string: B.stableString });
                return { A, B, C };
              }).pipe(stack.deploy);
              expect(output.A.tags).toEqual({ Env: "production" });
              expect((yield* getState("A"))?.status).toEqual("updated");
              // B and C should not change
              expect((yield* getState("B"))?.status).toEqual("created");
              expect((yield* getState("C"))?.status).toEqual("created");
            }
          }),
      );

      test.provider(
        "diamond: A -> B,C -> D where all depend on stable properties",
        (stack) =>
          Effect.gen(function* () {
            // Stage 1: Create diamond
            {
              const output = yield* Effect.gen(function* () {
                const A = yield* StaticStablesResource("A", {
                  string: "initial",
                });
                const B = yield* TestResource("B", { string: A.stableId });
                const C = yield* TestResource("C", { string: A.stableArn });
                const D = yield* TestResource("D", {
                  string: Output.interpolate`${B.stableString}-${C.stableString}`,
                });
                return { A, B, C, D };
              }).pipe(stack.deploy);
              expect(output.A.stableId).toEqual("stable-A");
              expect(output.A.stableArn).toEqual(
                "arn:test:resource:us-east-1:123456789:A",
              );
              expect(output.B.string).toEqual("stable-A");
              expect(output.C.string).toEqual(
                "arn:test:resource:us-east-1:123456789:A",
              );
              expect(output.D.string).toEqual("B-C");
            }

            // Stage 2: Change A's tags - should not affect B, C, or D
            {
              yield* Effect.gen(function* () {
                const A = yield* StaticStablesResource("A", {
                  string: "initial",
                  tags: { Team: "platform" },
                });
                const B = yield* TestResource("B", { string: A.stableId });
                const C = yield* TestResource("C", { string: A.stableArn });
                yield* TestResource("D", {
                  string: Output.interpolate`${B.stableString}-${C.stableString}`,
                });
              }).pipe(stack.deploy);
              expect((yield* getState("A"))?.status).toEqual("updated");
              expect((yield* getState("B"))?.status).toEqual("created");
              expect((yield* getState("C"))?.status).toEqual("created");
              expect((yield* getState("D"))?.status).toEqual("created");
            }
          }),
      );
    });

    describe("diff returns update action with static stables", () => {
      test.provider(
        "upstream has static stables and diff returns update, downstream depends on stableId",
        (stack) =>
          Effect.gen(function* () {
            // Stage 1: Create A and B
            {
              const output = yield* Effect.gen(function* () {
                const A = yield* StaticStablesResource("A", {
                  string: "value-1",
                });
                const B = yield* TestResource("B", { string: A.stableId });
                return { A, B };
              }).pipe(stack.deploy);
              expect(output.A.stableId).toEqual("stable-A");
              expect(output.B.string).toEqual("stable-A");
            }

            // Stage 2: Change A's string - diff returns "update", stableId still stable
            {
              const output = yield* Effect.gen(function* () {
                const A = yield* StaticStablesResource("A", {
                  string: "value-2",
                });
                const B = yield* TestResource("B", { string: A.stableId });
                return { A, B };
              }).pipe(stack.deploy);
              expect(output.A.string).toEqual("value-2");
              expect(output.A.stableId).toEqual("stable-A");
              expect((yield* getState("A"))?.status).toEqual("updated");
              // B should not change since stableId is stable
              expect((yield* getState("B"))?.status).toEqual("created");
            }
          }),
      );

      test.provider(
        "downstream depends on non-stable property, should update",
        (stack) =>
          Effect.gen(function* () {
            // Stage 1: Create A and B where B depends on A.string (non-stable)
            {
              const output = yield* Effect.gen(function* () {
                const A = yield* StaticStablesResource("A", {
                  string: "value-1",
                });
                const B = yield* TestResource("B", { string: A.string });
                return { A, B };
              }).pipe(stack.deploy);
              expect(output.A.string).toEqual("value-1");
              expect(output.B.string).toEqual("value-1");
            }

            // Stage 2: Change A's string - B should update
            {
              const output = yield* Effect.gen(function* () {
                const A = yield* StaticStablesResource("A", {
                  string: "value-2",
                });
                const B = yield* TestResource("B", { string: A.string });
                return { A, B };
              }).pipe(stack.deploy);
              expect(output.A.string).toEqual("value-2");
              expect(output.B.string).toEqual("value-2");
              expect((yield* getState("A"))?.status).toEqual("updated");
              expect((yield* getState("B"))?.status).toEqual("updated");
            }
          }),
      );
    });

    describe("replace action with static stables", () => {
      test.provider(
        "upstream replaces, downstream depends on stableId - should update with new value",
        (stack) =>
          Effect.gen(function* () {
            // Stage 1: Create A and B
            {
              const output = yield* Effect.gen(function* () {
                const A = yield* StaticStablesResource("A", {
                  string: "value",
                  replaceString: "original",
                });
                const B = yield* TestResource("B", { string: A.stableId });
                return { A, B };
              }).pipe(stack.deploy);
              expect(output.A.stableId).toEqual("stable-A");
              expect(output.B.string).toEqual("stable-A");
            }

            // Stage 2: Replace A - stableId will change (new resource)
            {
              const output = yield* Effect.gen(function* () {
                const A = yield* StaticStablesResource("A", {
                  string: "value",
                  replaceString: "changed",
                });
                const B = yield* TestResource("B", { string: A.stableId });
                return { A, B };
              }).pipe(stack.deploy);
              // A was replaced, stableId is regenerated
              expect(output.A.stableId).toEqual("stable-A");
              expect(output.B.string).toEqual("stable-A");
              expect((yield* getState("A"))?.status).toEqual("created");
              expect((yield* getState("B"))?.status).toEqual("updated");
            }
          }),
      );
    });
  },
);

describe(
  "Redacted props/outputs survive deploy",
  { tags: ["unit", "local"] },
  () => {
    test.provider(
      "preserves a Redacted prop end-to-end through create",
      (stack) =>
        Effect.gen(function* () {
          const secret = Redacted.make("hunter2");
          const created = yield* Effect.gen(function* () {
            return yield* TestResource("A", {
              string: "x",
              redacted: secret,
            });
          }).pipe(stack.deploy);

          expect(Redacted.isRedacted(created.redacted)).toBe(true);
          expect(Redacted.value(created.redacted!)).toBe("hunter2");

          const state = yield* getState("A");
          expect(state).toBeDefined();
          expect(Redacted.isRedacted((state!.props as any).redacted)).toBe(
            true,
          );
          expect(Redacted.value((state!.props as any).redacted)).toBe(
            "hunter2",
          );
          expect(Redacted.isRedacted((state!.attr as any).redacted)).toBe(true);
          expect(Redacted.value((state!.attr as any).redacted)).toBe("hunter2");
        }),
    );

    test.provider(
      "preserves Redacted values nested inside an array end-to-end",
      (stack) =>
        Effect.gen(function* () {
          const created = yield* Effect.gen(function* () {
            return yield* TestResource("A", {
              string: "x",
              redactedArray: [Redacted.make("a"), Redacted.make("b")],
            });
          }).pipe(stack.deploy);

          expect(created.redactedArray).toBeDefined();
          expect(created.redactedArray!.length).toBe(2);
          expect(Redacted.isRedacted(created.redactedArray![0]!)).toBe(true);
          expect(Redacted.value(created.redactedArray![0]!)).toBe("a");
          expect(Redacted.isRedacted(created.redactedArray![1]!)).toBe(true);
          expect(Redacted.value(created.redactedArray![1]!)).toBe("b");
        }),
    );

    test.provider(
      "preserves a Redacted output flowing into a downstream resource prop",
      (stack) =>
        Effect.gen(function* () {
          const output = yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "x",
              redacted: Redacted.make("hunter2"),
            });
            const B = yield* TestResource("B", {
              string: "y",
              redacted: A.redacted as any,
            });
            return { A, B };
          }).pipe(stack.deploy);

          expect(Redacted.isRedacted(output.B.redacted)).toBe(true);
          expect(Redacted.value(output.B.redacted!)).toBe("hunter2");

          const bState = yield* getState("B");
          expect(Redacted.isRedacted((bState!.props as any).redacted)).toBe(
            true,
          );
          expect(Redacted.value((bState!.props as any).redacted)).toBe(
            "hunter2",
          );
          expect(Redacted.isRedacted((bState!.attr as any).redacted)).toBe(
            true,
          );
          expect(Redacted.value((bState!.attr as any).redacted)).toBe(
            "hunter2",
          );
        }),
    );

    test.provider(
      "no-op redeploy when only Redacted prop is present and value unchanged",
      (stack) =>
        Effect.gen(function* () {
          const first = yield* Effect.gen(function* () {
            return yield* TestResource("A", {
              string: "x",
              redacted: Redacted.make("hunter2"),
            });
          }).pipe(stack.deploy);
          expect(Redacted.value(first.redacted!)).toBe("hunter2");

          const before = yield* getState("A");

          yield* Effect.gen(function* () {
            return yield* TestResource("A", {
              string: "x",
              redacted: Redacted.make("hunter2"),
            });
          }).pipe(stack.deploy);

          const after = yield* getState("A");
          expect(after?.status).toBe("created");
          expect((before as any).updatedAt ?? null).toEqual(
            (after as any).updatedAt ?? null,
          );
          expect(Redacted.value((after!.attr as any).redacted)).toBe("hunter2");
        }),
    );

    test.provider("update redeploy when Redacted prop value changes", (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          return yield* TestResource("A", {
            string: "x",
            redacted: Redacted.make("old"),
          });
        }).pipe(stack.deploy);

        const updated = yield* Effect.gen(function* () {
          return yield* TestResource("A", {
            string: "x",
            redacted: Redacted.make("new"),
          });
        }).pipe(stack.deploy);

        expect(Redacted.isRedacted(updated.redacted)).toBe(true);
        expect(Redacted.value(updated.redacted!)).toBe("new");
        const state = yield* getState("A");
        expect(state?.status).toBe("updated");
        expect(Redacted.value((state!.attr as any).redacted)).toBe("new");
      }),
    );
  },
);

describe("stack output persistence", { tags: ["unit", "local"] }, () => {
  const getStackOutput = (stack: string, stage: string) =>
    Effect.gen(function* () {
      const state = yield* yield* State;
      return yield* state.getOutput({ stack, stage });
    });

  test.provider(
    "apply persists the resolved stack output via state.setOutput",
    (stack) =>
      Effect.gen(function* () {
        const result = yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "hello" });
          return { url: A.string };
        }).pipe(stack.deploy);
        expect(result).toEqual({ url: "hello" });

        const persisted = yield* getStackOutput(stack.name, stack.stage).pipe(
          Effect.provide(stack.state),
        );
        expect(persisted).toEqual({ url: "hello" });
      }),
  );

  test.provider(
    "redeploys overwrite the persisted stack output with the new value",
    (stack) =>
      Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "v1" });
          return { url: A.string };
        }).pipe(stack.deploy);

        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "v2" });
          return { url: A.string };
        }).pipe(stack.deploy);

        const persisted = yield* getStackOutput(stack.name, stack.stage).pipe(
          Effect.provide(stack.state),
        );
        expect(persisted).toEqual({ url: "v2" });
      }),
  );

  test.provider(
    "another stack can read the persisted output via Output.stackRef",
    (stack) =>
      Effect.gen(function* () {
        // First deploy: write the stack output we'll later reference.
        yield* Effect.gen(function* () {
          const A = yield* TestResource("A", { string: "shared" });
          return { url: A.string };
        }).pipe(stack.deploy);

        // Second deploy: a downstream resource consumes the previously
        // persisted stack output via Output.stackRef. The deploy
        // succeeds because state.getOutput finds it.
        const result = yield* Effect.gen(function* () {
          const upstream = yield* Output.stackRef<{ url: string }>(stack.name);
          const B = yield* TestResource("B", {
            string: (upstream as any).url,
          });
          return { downstream: B.string };
        }).pipe(stack.deploy);

        expect(result).toEqual({ downstream: "shared" });
      }),
  );
});

describe(
  "Duration round-trip through state",
  { tags: ["unit", "local"] },
  () => {
    test.provider(
      "input Duration reaches reconcile as a real Duration and output Duration re-hydrates as a real Duration on the next deploy",
      (stack) =>
        Effect.gen(function* () {
          const first = yield* stack.deploy(
            DurationResource("Timer", { timeout: Duration.seconds(15) }),
          );

          // Reconcile saw a real Duration: arithmetic worked.
          expect(Duration.isDuration(first.observedTimeout)).toBe(true);
          expect(Duration.toMillis(first.observedTimeout)).toBe(15_000);
          expect(Duration.isDuration(first.computedTimeout)).toBe(true);
          expect(Duration.toMillis(first.computedTimeout)).toBe(16_000);

          // Second deploy: identical props. The engine reads the previous
          // output from state. If the Duration weren't revived, `output`
          // (a plain `{_id,_tag,millis}` shape) would fail `isDuration` and
          // `Duration.toMillis` would throw.
          const second = yield* stack.deploy(
            DurationResource("Timer", { timeout: Duration.seconds(15) }),
          );
          expect(Duration.isDuration(second.observedTimeout)).toBe(true);
          expect(Duration.toMillis(second.observedTimeout)).toBe(15_000);
          expect(Duration.isDuration(second.computedTimeout)).toBe(true);
          expect(Duration.toMillis(second.computedTimeout)).toBe(16_000);

          // The persisted state itself should round-trip to a real Duration.
          const persisted = yield* getState<{
            attr: DurationResource["Attributes"];
          }>("Timer");
          expect(Duration.isDuration(persisted.attr.computedTimeout)).toBe(
            true,
          );
          expect(Duration.toMillis(persisted.attr.computedTimeout)).toBe(
            16_000,
          );
        }),
    );
  },
);

describe("type aliases", { tags: ["unit", "local"] }, () => {
  // Simulate state written before a type rename: rewrite the persisted row's
  // resourceType to the legacy name ("Test.Widget") that the canonical type
  // ("Test.Widgets.Widget") carries as an alias.
  const rewriteTypeToLegacy = Effect.fn(function* (fqn: string) {
    const state = yield* yield* State;
    const stk = yield* Stack;
    const row = (yield* state.get({
      stack: stk.name,
      stage: stk.stage,
      fqn,
    })) as ResourceState;
    expect(row.resourceType).toEqual("Test.Widgets.Widget");
    yield* state.set({
      stack: stk.name,
      stage: stk.stage,
      fqn,
      value: { ...row, resourceType: "Test.Widget" },
    });
  });

  describe("bare provider layer", () => {
    const { test } = Test.make({
      providers: Layer.mergeAll(TestLayers(), aliasedWidgetProvider()),
    });

    test.provider(
      "a noop deploy migrates legacy-typed state to the canonical type",
      (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            yield* AliasedWidget("W1", { name: "w1" });
          }).pipe(stack.deploy);

          yield* rewriteTypeToLegacy("W1");

          // Unchanged props plan as a noop — Apply must still rewrite the
          // state row to the canonical type name.
          yield* Effect.gen(function* () {
            yield* AliasedWidget("W1", { name: "w1" });
          }).pipe(stack.deploy);

          const row = yield* getState("W1");
          expect(row.resourceType).toEqual("Test.Widgets.Widget");
          expect(row.status).toEqual("created");
          expect(row.attr).toEqual({ name: "w1" });
        }),
    );

    test.provider(
      "orphan persisted under a legacy type name is deleted via alias",
      (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            yield* AliasedWidget("W2", { name: "w2" });
          }).pipe(stack.deploy);

          yield* rewriteTypeToLegacy("W2");

          // Remove the resource from the stack — the orphan-deletion path
          // resolves the provider from the legacy type via its alias.
          yield* Effect.void.pipe(stack.deploy);

          expect(aliasedWidgetDeletes).toContain("W2");
          expect(yield* getState("W2")).toBeUndefined();
        }),
    );

    test.provider(
      "destroy resolves the provider for legacy-typed state via alias",
      (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            yield* AliasedWidget("W3", { name: "w3" });
          }).pipe(stack.deploy);

          yield* rewriteTypeToLegacy("W3");

          yield* stack.destroy();

          expect(aliasedWidgetDeletes).toContain("W3");
          expect(yield* getState("W3")).toBeUndefined();
        }),
    );
  });

  describe("provider collection", () => {
    class AliasApplyProviders extends Provider.ProviderCollection<AliasApplyProviders>()(
      "Test.AliasApplyProviders",
    ) {}

    // The bare provider layer is consumed while building the collection and
    // is NOT exported — lookup can only succeed through the collection.
    const { test } = Test.make({
      providers: Layer.effect(
        AliasApplyProviders,
        Provider.collection([AliasedWidget]),
      ).pipe(Layer.provide(aliasedWidgetProvider())),
    });

    test.provider(
      "orphan persisted under a legacy type name is deleted via alias",
      (stack) =>
        Effect.gen(function* () {
          yield* Effect.gen(function* () {
            yield* AliasedWidget("W4", { name: "w4" });
          }).pipe(stack.deploy);

          yield* rewriteTypeToLegacy("W4");

          yield* Effect.void.pipe(stack.deploy);

          expect(aliasedWidgetDeletes).toContain("W4");
          expect(yield* getState("W4")).toBeUndefined();
        }),
    );
  });
});

// Regression coverage for
// https://github.com/alchemy-run/alchemy/issues/793
//
// `Plan.make` used to `state.set(...)` the adopted `created` state during plan
// construction. Because `alchemy plan` / `deploy --dry-run` build a plan the
// exact same way a real deploy does, a read-only preview silently claimed
// ownership of an unowned cloud resource — arming a later, unrelated deploy to
// orphan-delete it. Plan construction must be side-effect-free: reading the
// cloud resource is fine (needed for an accurate diff), but persisting the
// adopted state may only happen when the plan node is applied.
describe(
  "engine-level adoption persists at apply, not plan (issue #793)",
  { tags: ["unit", "local"] },
  () => {
    // A pre-existing, foreign-owned cloud resource that `read` always discovers
    // — the exact shape that triggers an `--adopt` takeover.
    const ownedAttrs: TestResource["Attributes"] = {
      string: "hello",
      stringArray: [],
      stableString: "Adopted",
      stableArray: ["Adopted"],
      replaceString: undefined,
      redacted: undefined,
      redactedArray: undefined,
    };

    test.provider(
      "a dry-run plan writes nothing to the state store; applying persists",
      (stack) =>
        Effect.gen(function* () {
          const events: Array<{ id: string; status: string }> = [];
          let creates = 0;
          let updates = 0;
          const hooks = Layer.succeed(TestResourceHooks, {
            read: () => Effect.succeed(Unowned(ownedAttrs)),
            create: () => Effect.sync(() => creates++),
            update: () => Effect.sync(() => updates++),
          });
          // ── dry-run: build a plan that adopts the unowned cloud resource ──
          const plan = yield* TestResource("Adopted", { string: "hello" }).pipe(
            adopt(true),
            stack.plan,
            Effect.provide(hooks),
          );

          // The adopted state rides on an explicit plan node (which still
          // provider re-syncs ownership tags / config) — it is not persisted.
          expect(plan.resources.Adopted!.action).toBe("adopted");
          expect(plan.resources.Adopted!.state?.status).toBe("created");

          // The critical invariant of #793: planning persisted nothing, so a
          // read-only `alchemy plan` / `--dry-run` cannot arm a later deploy to
          // orphan-delete the live resource.
          expect(yield* getState("Adopted")).toBeUndefined();
          expect(yield* listState()).toEqual([]);

          // ── apply: the same config now deploys. Because plan didn't persist,
          // the resource is still adoptable here. ──
          yield* TestResource("Adopted", { string: "hello" }).pipe(
            adopt(true),
            stack.deploy,
            Effect.provide(hooks),
            Effect.provide(Layer.succeed(Cli, recordingCli(events))),
          );

          // Applying DOES persist the adopted state.
          const persisted = yield* getState("Adopted");
          expect(["created", "updated"]).toContain(persisted?.status);
          expect(yield* listState()).toEqual(["Adopted"]);
          // Adoption is the reconciler's `output defined, olds undefined` path.
          expect(creates).toBe(1);
          expect(updates).toBe(0);
          const statuses = events
            .filter((event) => event.id === "Adopted")
            .map((event) => event.status);
          expect(statuses).toContain("adopting");
          expect(statuses).toContain("adopted");
          expect(statuses.indexOf("adopting")).toBeLessThan(
            statuses.indexOf("adopted"),
          );
        }),
    );
  },
);

describe("deferred adoption", { tags: ["unit", "local"] }, () => {
  interface Singleton extends Resource<
    "Test.DeferredSingleton",
    { parent?: string; value?: string },
    { identity: string; value: string }
  > {}
  const Singleton = Resource<Singleton>("Test.DeferredSingleton");
  class Probe extends Context.Service<
    Probe,
    {
      ready: boolean;
      foreign: boolean;
      absent: boolean;
      fail: boolean;
      reads: string[];
      reconciles: Array<{
        id: string;
        olds: Singleton["Props"] | undefined;
        output: Singleton["Attributes"] | undefined;
      }>;
      deletes: string[];
    }
  >()("DeferredAdoptionProbe") {}
  const providers = Provider.succeed(Singleton, {
    read: Effect.fn(function* ({ id, olds, output }) {
      if (id === "Parent") return output;
      const probe = yield* Probe;
      if (!olds.parent) return undefined;
      expect(probe.ready).toBe(true);
      expect(olds.parent).toBe("child-branch");
      probe.reads.push(id);
      if (output) return output;
      if (probe.absent) return undefined;
      const attrs = { identity: olds.parent, value: "inherited" };
      return probe.foreign ? Unowned(attrs) : attrs;
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const probe = yield* Probe;
      if (id === "Parent") {
        probe.ready = true;
        return { identity: "child-branch", value: "parent" };
      }
      probe.reconciles.push({ id, olds, output });
      if (!output && !probe.absent)
        return yield* new OwnedBySomeoneElse({
          message: "Singleton requires engine adoption",
        });
      expect(Unowned.is(output)).toBe(false);
      if (probe.fail) return yield* new ResourceFailure();
      return { identity: news.parent!, value: news.value ?? "desired" };
    }),
    delete: Effect.fn(function* ({ id }) {
      (yield* Probe).deletes.push(id);
    }),
  });
  interface Stub extends Resource<
    "Test.DeferredStub",
    Singleton["Props"],
    Singleton["Attributes"]
  > {}
  const Stub = Resource<Stub>("Test.DeferredStub");
  const stubProvider = Provider.succeed(Stub, {
    read: Effect.fn(function* ({ id }) {
      (yield* Probe).reads.push(id);
      return Unowned({ identity: "stub", value: "stub" });
    }),
    precreate: () => Effect.succeed({ identity: "stub", value: "stub" }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const probe = yield* Probe;
      probe.reconciles.push({ id, olds, output });
      expect(output).toEqual({ identity: "stub", value: "stub" });
      if (probe.fail) return yield* new ResourceFailure();
      return { identity: news.parent!, value: "ready" };
    }),
    delete: Effect.fn(function* ({ id }) {
      (yield* Probe).deletes.push(id);
    }),
  });
  const makeProbe = (): Probe["Service"] => ({
    ready: false,
    foreign: true,
    absent: false,
    fail: false,
    reads: [],
    reconciles: [],
    deletes: [],
  });
  const { test } = Test.make({
    providers: Layer.mergeAll(providers, stubProvider).pipe(
      Layer.provideMerge(
        Layer.effect(
          Probe,
          // Reuse the test's probe across successive stack layer builds.
          Effect.serviceOption(Probe).pipe(
            Effect.map(Option.getOrElse(makeProbe)),
          ),
        ),
      ),
    ),
  });
  const program = (enabled?: boolean, sibling = false) =>
    Effect.gen(function* () {
      const parent = yield* Singleton("Parent", {});
      const child = Singleton("Child", { parent: parent.identity });
      const result = yield* enabled === undefined
        ? child
        : child.pipe(adopt(enabled));
      if (sibling) yield* Singleton("Sibling", { parent: parent.identity });
      return result;
    });

  for (const kind of ["scoped", "default", "owned", "absent"] as const) {
    test.provider(
      `accepts ${kind} after resolving a new upstream without plan writes`,
      (stack) => {
        return Effect.gen(function* () {
          const probe = yield* Probe;
          probe.foreign = kind !== "owned";
          probe.absent = kind === "absent";
          yield* stack.destroy();
          const app = program(kind === "scoped" ? true : undefined);
          const plan = yield* stack.plan(app);
          expect(plan.resources.Child?.action).toBe("create");
          expect(probe.reads).toEqual([]);
          expect(yield* getState("Child")).toBeUndefined();
          const result = yield* stack.deploy(app);
          expect(result.identity).toBe("child-branch");
          expect(probe.reads).toEqual(["Child"]);
          expect(probe.reconciles[0]?.olds).toBeUndefined();
          expect(probe.reconciles[0]?.output).toEqual(
            kind === "absent"
              ? undefined
              : { identity: "child-branch", value: "inherited" },
          );
          expect(Unowned.is((yield* getState("Child")).attr)).toBe(false);
          yield* stack.destroy();
        }).pipe(Effect.provideService(AdoptPolicy, kind === "default"));
      },
    );
  }

  for (const enabled of [undefined, false]) {
    test.provider(
      `refuses unowned resources before reconcile with scoped policy ${enabled}`,
      (stack) => {
        return Effect.gen(function* () {
          const probe = yield* Probe;
          yield* stack.destroy();
          const refused = yield* stack.deploy(program(enabled)).pipe(
            Effect.as(false),
            Effect.catchTag("OwnedBySomeoneElse", () => Effect.succeed(true)),
          );
          expect(refused).toBe(true);
          expect(probe.reads).toEqual(["Child"]);
          expect(probe.reconciles).toEqual([]);
          expect((yield* getState("Child")).attr).toBeUndefined();
          yield* stack.destroy();
          expect(probe.deletes).not.toContain("Child");
        }).pipe(Effect.provideService(AdoptPolicy, enabled === false));
      },
    );
  }

  test.provider(
    "never probes a precreated stub, including interrupted reconciliation",
    (stack) => {
      const app = Effect.gen(function* () {
        const parent = yield* Singleton("Parent", {});
        return yield* Stub("Stub", { parent: parent.identity }).pipe(
          adopt(false),
        );
      });
      return Effect.gen(function* () {
        const probe = yield* Probe;
        probe.fail = true;
        yield* stack.destroy();
        yield* stack
          .deploy(app)
          .pipe(Effect.catchTag("ResourceFailure", () => Effect.void));
        expect((yield* getState("Stub")).attr).toEqual({
          identity: "stub",
          value: "stub",
        });
        probe.fail = false;
        expect((yield* stack.deploy(app)).identity).toBe("child-branch");
        expect(probe.reads).toEqual([]);
        expect(probe.reconciles).toHaveLength(2);
        expect(probe.reconciles.every(({ olds }) => olds === undefined)).toBe(
          true,
        );
        yield* stack.destroy();
      });
    },
  );

  test.provider("resource adoption never authorizes a sibling", (stack) => {
    return Effect.gen(function* () {
      const probe = yield* Probe;
      yield* stack.destroy();
      const refused = yield* stack.deploy(program(true, true)).pipe(
        Effect.as(false),
        Effect.catchTag("OwnedBySomeoneElse", () => Effect.succeed(true)),
      );
      expect(refused).toBe(true);
      expect(probe.reads).toContain("Sibling");
      expect(probe.reconciles.some(({ id }) => id === "Sibling")).toBe(false);
      expect((yield* getState("Sibling")).attr).toBeUndefined();
      yield* stack.destroy();
      expect(probe.deletes).not.toContain("Sibling");
    });
  });

  test.provider(
    "checkpoints accepted attributes and retries reconciliation with olds undefined",
    (stack) => {
      return Effect.gen(function* () {
        const probe = yield* Probe;
        probe.fail = true;
        yield* stack.destroy();
        const failed = yield* stack.deploy(program(true)).pipe(
          Effect.as(false),
          Effect.catchTag("ResourceFailure", () => Effect.succeed(true)),
        );
        expect(failed).toBe(true);
        const checkpoint = yield* getState<CreatingResourceState>("Child");
        expect(checkpoint.status).toBe("creating");
        expect(checkpoint.props).toEqual({ parent: "child-branch" });
        expect(checkpoint.attr).toEqual({
          identity: "child-branch",
          value: "inherited",
        });
        expect(Unowned.is(checkpoint.attr)).toBe(false);
        probe.fail = false;
        yield* stack.deploy(program(false));
        expect(probe.reconciles).toHaveLength(2);
        expect(probe.reconciles.every(({ olds }) => olds === undefined)).toBe(
          true,
        );
        expect(probe.reads).toEqual(["Child"]);
        yield* stack.destroy();
      });
    },
  );

  test.provider(
    "retries an attr-less refusal using resolved desired identity",
    (stack) => {
      return Effect.gen(function* () {
        const probe = yield* Probe;
        yield* stack.destroy();
        yield* stack
          .deploy(program(false))
          .pipe(Effect.catchTag("OwnedBySomeoneElse", () => Effect.void));
        expect((yield* getState("Child")).attr).toBeUndefined();
        yield* stack.deploy(program(true));
        expect(probe.reconciles).toHaveLength(1);
        expect(probe.reconciles[0]?.olds).toBeUndefined();
        yield* stack.destroy();
      });
    },
  );
});

describe(
  "interrupted create persists no unresolved Output exprs",
  { tags: ["unit", "local"] },
  () => {
    test.provider(
      "creating-state props are plain data and destroy converges",
      (stack) =>
        Effect.gen(function* () {
          const program = Effect.gen(function* () {
            const a = yield* TestResource("A", { string: "a-value" });
            const b = yield* TestResource("B", { string: a.string });
            return { a, b };
          });

          // B fails after dependency resolution and the deferred-read checkpoint.
          yield* program.pipe(stack.deploy, hook(failOn("B", "create")));

          const b = yield* getState("B");
          expect(b?.status).toEqual("creating");
          // Recovery receives the resolved identity, never a live Output proxy.
          expect((b?.props as TestResourceProps).string).toBe("a-value");

          yield* stack.destroy();
          expect(yield* getState("B")).toBeUndefined();
          expect(yield* listState()).toEqual([]);
        }),
    );
  },
);

describe(
  "interrupted replacement destruction",
  { tags: ["unit", "local"] },
  () => {
    type Attributes = {
      physicalId: string;
      revision: string;
      dependency?: string;
    };
    interface Generation extends Resource<
      "Test.DestructionGeneration",
      { revision: string; dependency?: string },
      Attributes
    > {}
    const Generation = Resource<Generation>("Test.DestructionGeneration");
    class Registry extends Context.Service<
      Registry,
      {
        physical: Map<string, Attributes>;
        calls: Array<{
          op: "read" | "delete";
          physicalId: string;
          mode: string;
        }>;
        reconcile?: (
          attrs: Attributes,
          create: Effect.Effect<void>,
        ) => Effect.Effect<void>;
        remove?: (attrs: Attributes) => Effect.Effect<void, ResourceFailure>;
        unowned?: boolean;
      }
    >()("DestructionGeneration.Registry") {}
    const variant = (mode: "live" | "local", precreate = false) =>
      Provider.succeed(Generation, {
        ...(precreate
          ? {
              precreate: Effect.fn(function* ({
                instanceId,
                news,
              }: {
                instanceId: string;
                news: Generation["Props"];
              }) {
                const registry = yield* Registry;
                const attrs = {
                  physicalId: instanceId,
                  revision: "stub",
                  dependency: news.dependency,
                };
                registry.physical.set(instanceId, attrs);
                return attrs;
              }),
            }
          : {}),
        diff: Effect.fn(function* ({ news, olds }) {
          if (
            "revision" in news &&
            isResolved(news.revision) &&
            news.revision !== olds?.revision
          ) {
            return { action: "replace" };
          }
        }),
        read: Effect.fn(function* ({ instanceId }) {
          const registry = yield* Registry;
          registry.calls.push({ op: "read", physicalId: instanceId, mode });
          const attrs = registry.physical.get(instanceId);
          return attrs && registry.unowned ? Unowned(attrs) : attrs;
        }),
        reconcile: Effect.fn(function* ({ instanceId, news }) {
          const registry = yield* Registry;
          const attrs = { physicalId: instanceId, ...news };
          const create = Effect.sync(() => {
            registry.physical.set(instanceId, attrs);
          });
          yield* registry.reconcile
            ? registry.reconcile(attrs, create)
            : create;
          return attrs;
        }),
        delete: Effect.fn(function* ({ instanceId, output }) {
          const registry = yield* Registry;
          expect(output.physicalId).toBe(instanceId);
          registry.calls.push({ op: "delete", physicalId: instanceId, mode });
          if (registry.remove) yield* registry.remove(output);
          expect(
            [...registry.physical.values()].some(
              (value) => value.dependency === instanceId,
            ),
          ).toBe(false);
          registry.physical.delete(instanceId);
        }),
      });
    const makeRegistry = (): Registry["Service"] => ({
      physical: new Map(),
      calls: [],
    });
    const { test: generationTest } = Test.make({
      providers: ProviderLayer.dual(Generation, {
        live: () => variant("live"),
        local: () => variant("local"),
      }).pipe(
        Layer.provideMerge(
          Layer.effect(
            Registry,
            Effect.serviceOption(Registry).pipe(
              Effect.map(Option.getOrElse(makeRegistry)),
            ),
          ),
        ),
      ),
    });

    generationTest.provider(
      "GC preserves dependency direction across pending generations",
      (stack) =>
        Effect.gen(function* () {
          const registry = yield* Registry;
          yield* stack.destroy();
          const first = yield* stack.deploy(
            Effect.gen(function* () {
              const A = yield* Generation("A", { revision: "one" });
              const B = yield* Generation("B", {
                revision: "one",
                dependency: A.physicalId,
              });
              return { A, B };
            }),
          );
          registry.remove = (attrs) =>
            attrs.physicalId === first.B.physicalId
              ? Effect.fail(new ResourceFailure())
              : Effect.void;
          const replacement = yield* stack
            .deploy(
              Effect.gen(function* () {
                const B = yield* Generation("B", { revision: "two" });
                return yield* Generation("A", {
                  revision: "two",
                  dependency: B.physicalId,
                });
              }),
            )
            .pipe(Effect.exit);
          expect(Exit.isFailure(replacement)).toBe(true);
          const A = yield* getState("A");
          const B = yield* getState("B");
          assert(A.status === "replaced" && B.status === "replaced");
          registry.remove = undefined;
          registry.calls.length = 0;
          const current = yield* stack.deploy(
            Effect.gen(function* () {
              const A = yield* Generation("A", { revision: "three" });
              const B = yield* Generation("B", { revision: "three" });
              return { A, B };
            }),
          );
          expect(
            registry.calls
              .filter((call) => call.op === "delete")
              .map((call) => call.physicalId),
          ).toEqual([
            A.instanceId,
            B.instanceId,
            first.B.physicalId,
            first.A.physicalId,
          ]);
          expect([...registry.physical.keys()].sort()).toEqual(
            [current.A.physicalId, current.B.physicalId].sort(),
          );
          yield* stack.destroy();
          expect([...registry.physical.values()]).toEqual([]);
        }),
      { timeout: 10_000 },
    );

    generationTest.provider(
      "GC waits for a deferred physical deletion before deleting its dependency",
      (stack) =>
        Effect.gen(function* () {
          const registry = yield* Registry;
          yield* stack.destroy();
          const first = yield* stack.deploy(
            Effect.gen(function* () {
              const A = yield* Generation("A", { revision: "one" });
              const B = yield* Generation("B", {
                revision: "one",
                dependency: A.physicalId,
              });
              const C = yield* Generation("C", { revision: "one" });
              return { A, B, C };
            }),
          );
          registry.remove = (attrs) =>
            attrs.physicalId === first.C.physicalId
              ? Effect.fail(new ResourceFailure())
              : Effect.void;
          const replacement = yield* stack
            .deploy(
              Effect.gen(function* () {
                const A = yield* Generation("A", { revision: "one" });
                const B = yield* Generation("B", {
                  revision: "one",
                  dependency: A.physicalId,
                });
                return yield* Generation("C", {
                  revision: "two",
                  dependency: B.physicalId,
                });
              }),
            )
            .pipe(Effect.exit);
          assert(Exit.isFailure(replacement));
          const C = yield* getState("C");
          assert(C.status === "replaced");
          expect(C.old.instanceId).toBe(first.C.physicalId);
          registry.remove = undefined;
          registry.calls.length = 0;
          const current = yield* stack.deploy(
            Effect.gen(function* () {
              const A = yield* Generation("A", { revision: "two" });
              const C = yield* Generation("C", { revision: "three" });
              return { A, C };
            }),
          );
          const deleted = registry.calls
            .filter((call) => call.op === "delete")
            .map((call) => call.physicalId);
          expect(deleted).toEqual([
            C.instanceId,
            first.C.physicalId,
            first.B.physicalId,
            first.A.physicalId,
          ]);
          expect(yield* getState("B")).toBeUndefined();
          expect([...registry.physical.keys()].sort()).toEqual(
            [current.A.physicalId, current.C.physicalId].sort(),
          );
          yield* stack.destroy();
          expect([...registry.physical.values()]).toEqual([]);
          expect(yield* listState()).toEqual([]);
        }),
      { timeout: 10_000 },
    );

    const { test: stubTest } = Test.make({
      providers: variant("live", true).pipe(
        Layer.provideMerge(
          Layer.effect(
            Registry,
            Effect.serviceOption(Registry).pipe(
              Effect.map(Option.getOrElse(makeRegistry)),
            ),
          ),
        ),
      ),
    });
    stubTest.provider(
      "unfinished precreate remains resumable after its deleting checkpoint fails",
      (stack) =>
        Effect.gen(function* () {
          const registry = yield* Registry;
          yield* stack.destroy();
          const first = yield* stack.deploy(
            Generation("R", { revision: "one" }),
          );
          const reached = yield* Deferred.make<void>();
          registry.reconcile = () =>
            Deferred.succeed(reached, undefined).pipe(
              Effect.andThen(Effect.never),
            );
          const fiber = yield* stack
            .deploy(Generation("R", { revision: "two" }))
            .pipe(Effect.forkChild);
          yield* Deferred.await(reached).pipe(Effect.timeout("2 seconds"));
          yield* Fiber.interrupt(fiber);
          const pending = yield* getState("R");
          assert(pending.status === "replacing");
          expect(pending.attr?.revision).toBe("stub");
          const plan = yield* stack.plan(Effect.void);
          const state = yield* yield* State;
          const exit = yield* apply(plan).pipe(
            Effect.provideService(
              State,
              Effect.succeed({
                ...state,
                set: (request) =>
                  request.fqn === "R" && request.value.status === "deleting"
                    ? Effect.fail(
                        new StateStoreError({
                          message: "Deleting checkpoint failed",
                        }),
                      )
                    : state.set(request),
              }),
            ),
            Effect.exit,
          );
          assert(Exit.isFailure(exit));
          expect(registry.physical.has(first.physicalId)).toBe(false);
          const checkpoint = yield* getState("R");
          let reconciles = 0;
          registry.reconcile = (_, create) =>
            Effect.sync(() => {
              reconciles++;
            }).pipe(Effect.andThen(create));
          const output = yield* stack.deploy(
            Generation("R", { revision: "two" }),
          );
          expect(reconciles).toBe(1);
          expect(checkpoint.status).toBe("creating");
          expect(checkpoint.attr).toEqual(pending.attr);
          expect(output.revision).toBe("two");
          yield* stack.destroy();
          expect([...registry.physical.values()]).toEqual([]);
        }),
      { timeout: 10_000 },
    );

    for (const phase of [
      "before-create",
      "after-create",
      "after-reconcile",
    ] as const) {
      generationTest.provider(
        `destroy drains generations interrupted ${phase}`,
        (stack) =>
          Effect.gen(function* () {
            const registry = yield* Registry;
            yield* stack.destroy();
            const first = yield* inDev(
              stack.deploy(Generation("R", { revision: "one" })),
            );
            const reached = yield* Deferred.make<void>();
            registry.reconcile = (_, create) =>
              Effect.gen(function* () {
                if (phase !== "before-create") yield* create;
                if (phase !== "after-reconcile") {
                  yield* Deferred.succeed(reached, undefined);
                  yield* Effect.never;
                }
              });
            registry.remove = () =>
              Deferred.succeed(reached, undefined).pipe(
                Effect.andThen(Effect.never),
              );
            const fiber = yield* stack
              .deploy(Generation("R", { revision: "two" }))
              .pipe(Effect.forkChild);
            yield* Deferred.await(reached).pipe(Effect.timeout("2 seconds"));
            yield* Fiber.interrupt(fiber);
            const pending = yield* getState("R");
            assert(
              pending?.status === "replacing" || pending?.status === "replaced",
            );
            expect(pending.instanceId).not.toBe(first.physicalId);
            expect(pending.old.instanceId).toBe(first.physicalId);
            registry.reconcile = undefined;
            registry.remove = undefined;
            registry.calls.length = 0;
            yield* stack.destroy();
            expect(yield* listState()).toEqual([]);
            expect([...registry.physical.values()]).toEqual([]);
            expect(registry.calls).toContainEqual({
              op: "delete",
              physicalId: first.physicalId,
              mode: "local",
            });
            expect(registry.calls).toContainEqual({
              op: phase === "before-create" ? "read" : "delete",
              physicalId: pending.instanceId,
              mode: "live",
            });
            yield* stack.destroy();
          }),
        { timeout: 10_000 },
      );
    }

    generationTest.provider(
      "replacement GC blocks a planned dependency deletion until its entire old chain drains",
      (stack) =>
        Effect.gen(function* () {
          const registry = yield* Registry;
          yield* stack.destroy();
          const program = (revision: string) =>
            Effect.gen(function* () {
              const dependency = yield* Generation("Dependency", {
                revision: "dependency",
              });
              return yield* Generation("R", {
                revision,
                dependency: dependency.physicalId,
              });
            });
          const first = yield* stack.deploy(program("one"));
          const reached = yield* Deferred.make<void>();
          registry.reconcile = (attrs, create) =>
            create.pipe(
              Effect.andThen(
                attrs.revision === "two"
                  ? Deferred.succeed(reached, undefined).pipe(
                      Effect.andThen(Effect.never),
                    )
                  : Effect.void,
              ),
            );
          const fiber = yield* stack
            .deploy(program("two"))
            .pipe(Effect.forkChild);
          yield* Deferred.await(reached).pipe(Effect.timeout("2 seconds"));
          yield* Fiber.interrupt(fiber);
          registry.reconcile = undefined;
          registry.remove = () => Effect.fail(new ResourceFailure());
          expect(
            Exit.isFailure(
              yield* stack.deploy(program("three")).pipe(Effect.exit),
            ),
          ).toBe(true);
          const pending = yield* getState("R");
          assert(pending?.status === "replaced");
          assert(pending.old.status === "replacing");
          registry.remove = (attrs) =>
            attrs.physicalId === first.physicalId
              ? Effect.fail(new ResourceFailure())
              : Effect.void;
          const survivor = Generation("R", { revision: "three" });
          const exit = yield* stack.deploy(survivor).pipe(Effect.exit);
          assert(Exit.isFailure(exit));
          const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
          assert(error instanceof DestroyError);
          expect(error.failures.map((entry) => entry.fqn)).toEqual(["R"]);
          expect(error.blocked.map((entry) => entry.fqn)).toEqual([
            "Dependency",
          ]);
          expect(registry.physical.has(pending.old.instanceId)).toBe(false);
          expect(registry.physical.has(first.physicalId)).toBe(true);
          expect(yield* getState("Dependency")).toBeDefined();
          registry.remove = undefined;
          yield* stack.deploy(survivor);
          expect([...registry.physical.keys()]).toEqual([pending.instanceId]);
          expect(yield* getState("Dependency")).toBeUndefined();
          yield* stack.destroy();
          expect([...registry.physical.values()]).toEqual([]);
        }),
      { timeout: 10_000 },
    );

    generationTest.provider(
      "retries an old-generation delete when its cleanup checkpoint fails",
      (stack) =>
        Effect.gen(function* () {
          const registry = yield* Registry;
          yield* stack.destroy();
          const first = yield* stack.deploy(
            Generation("R", { revision: "one" }),
          );
          const reached = yield* Deferred.make<void>();
          registry.reconcile = (_, create) =>
            create.pipe(
              Effect.andThen(Deferred.succeed(reached, undefined)),
              Effect.andThen(Effect.never),
            );
          const fiber = yield* stack
            .deploy(Generation("R", { revision: "two" }))
            .pipe(Effect.forkChild);
          yield* Deferred.await(reached).pipe(Effect.timeout("2 seconds"));
          yield* Fiber.interrupt(fiber);
          const pending = yield* getState("R");
          assert(pending?.status === "replacing");
          const plan = yield* stack.plan(Effect.void);
          const state = yield* yield* State;
          const exit = yield* apply(plan).pipe(
            Effect.provideService(
              State,
              Effect.succeed({
                ...state,
                set: (request) =>
                  request.fqn === "R" && request.value.status === "creating"
                    ? Effect.fail(
                        new StateStoreError({ message: "Checkpoint failed" }),
                      )
                    : state.set(request),
              }),
            ),
            Effect.exit,
          );
          assert(Exit.isFailure(exit));
          const error = exit.cause.reasons.find(Cause.isFailReason)?.error;
          assert(error instanceof DestroyError);
          expect(error.failures.map((entry) => entry.fqn)).toEqual(["R"]);
          expect(registry.physical.has(first.physicalId)).toBe(false);
          expect(registry.physical.has(pending.instanceId)).toBe(true);
          expect(yield* getState("R")).toEqual(pending);
          yield* stack.destroy();
          expect(
            registry.calls.filter(
              (call) =>
                call.op === "delete" && call.physicalId === first.physicalId,
            ),
          ).toHaveLength(2);
          expect([...registry.physical.values()]).toEqual([]);
          expect(yield* listState()).toEqual([]);
        }),
      { timeout: 10_000 },
    );

    for (const policy of ["unowned", "retain"] as const) {
      generationTest.provider(
        `preserves ${policy} physical resources during interrupted replacement cleanup`,
        (stack) =>
          Effect.gen(function* () {
            const registry = yield* Registry;
            yield* stack.destroy();
            const program = (revision: string) =>
              Generation("R", { revision }).pipe(
                RemovalPolicy.retain(policy === "retain"),
              );
            const first = yield* stack.deploy(program("one"));
            const reached = yield* Deferred.make<void>();
            registry.reconcile = (_, create) =>
              create.pipe(
                Effect.andThen(Deferred.succeed(reached, undefined)),
                Effect.andThen(Effect.never),
              );
            const fiber = yield* stack
              .deploy(program("two"))
              .pipe(Effect.forkChild);
            yield* Deferred.await(reached).pipe(Effect.timeout("2 seconds"));
            yield* Fiber.interrupt(fiber);
            const pending = yield* getState("R");
            assert(pending?.status === "replacing");
            registry.unowned = policy === "unowned";
            registry.calls.length = 0;
            yield* stack.destroy();
            expect(yield* listState()).toEqual([]);
            expect(registry.physical.has(pending.instanceId)).toBe(true);
            expect(registry.physical.has(first.physicalId)).toBe(
              policy === "retain",
            );
            expect(
              registry.calls
                .filter((call) => call.op === "delete")
                .map((call) => call.physicalId),
            ).toEqual(policy === "retain" ? [] : [first.physicalId]);
          }),
        { timeout: 10_000 },
      );
    }

    for (const failure of ["fail", "interrupt"] as const) {
      for (const target of ["newest", "oldest"] as const) {
        generationTest.provider(
          `${failure} deleting ${target} preserves the chain and blocks dependencies`,
          (stack) =>
            Effect.gen(function* () {
              const registry = yield* Registry;
              yield* stack.destroy();
              const program = (revision: string) =>
                Effect.gen(function* () {
                  const dependency = yield* Generation("Dependency", {
                    revision: "dependency",
                  });
                  yield* Generation("Sibling", { revision: "sibling" });
                  const resource = Generation("R", {
                    revision,
                    dependency: dependency.physicalId,
                  });
                  return yield* revision === "two"
                    ? resource.pipe(remote())
                    : resource;
                });
              const first = yield* inDev(stack.deploy(program("one")));
              for (const revision of ["two", "three"]) {
                const reached = yield* Deferred.make<void>();
                registry.reconcile = (attrs, create) =>
                  create.pipe(
                    Effect.andThen(
                      attrs.revision === revision
                        ? Deferred.succeed(reached, undefined).pipe(
                            Effect.andThen(Effect.never),
                          )
                        : Effect.void,
                    ),
                  );
                const fiber = yield* inDev(
                  stack.deploy(program(revision)),
                ).pipe(Effect.forkChild);
                yield* Deferred.await(reached).pipe(
                  Effect.timeout("2 seconds"),
                );
                yield* Fiber.interrupt(fiber);
              }
              const pending = yield* getState("R");
              assert(pending?.status === "replacing");
              assert(pending.old.status === "replacing");
              expect(
                new Set([
                  first.physicalId,
                  pending.old.instanceId,
                  pending.instanceId,
                ]).size,
              ).toBe(3);
              const blocked = yield* Deferred.make<void>();
              registry.remove = (attrs) =>
                attrs.physicalId ===
                (target === "newest" ? pending.instanceId : first.physicalId)
                  ? failure === "fail"
                    ? Effect.fail(new ResourceFailure())
                    : Deferred.succeed(blocked, undefined).pipe(
                        Effect.andThen(Effect.never),
                      )
                  : Effect.void;
              if (failure === "fail") {
                const exit = yield* stack.destroy().pipe(Effect.exit);
                assert(Exit.isFailure(exit));
                const error = exit.cause.reasons.find(
                  Cause.isFailReason,
                )?.error;
                assert(error instanceof DestroyError);
                expect(error.failures.map((entry) => entry.fqn)).toEqual(["R"]);
                expect(
                  error.blocked.map((entry) => ({
                    fqn: entry.fqn,
                    blockedBy: entry.blockedBy,
                  })),
                ).toEqual([{ fqn: "Dependency", blockedBy: ["R"] }]);
              } else {
                const fiber = yield* stack.destroy().pipe(Effect.forkChild);
                yield* Deferred.await(blocked).pipe(
                  Effect.timeout("2 seconds"),
                );
                yield* Fiber.interrupt(fiber);
              }
              expect(yield* getState("Dependency")).toBeDefined();
              const checkpoint = yield* getState("R");
              assert(checkpoint !== undefined);
              if (target === "oldest") {
                assert(checkpoint.status === "replacing");
                expect(checkpoint.old.instanceId).toBe(first.physicalId);
                expect(registry.physical.has(first.physicalId)).toBe(true);
              } else {
                expect(checkpoint.status).toBe("deleting");
                expect(checkpoint.instanceId).toBe(pending.instanceId);
                expect(registry.physical.has(first.physicalId)).toBe(false);
              }
              if (failure === "fail")
                expect(yield* getState("Sibling")).toBeUndefined();
              registry.remove = undefined;
              yield* stack.destroy();
              expect([...registry.physical.values()]).toEqual([]);
              expect(yield* listState()).toEqual([]);
              for (const [physicalId, mode] of [
                [first.physicalId, "local"],
                [pending.old.instanceId, "live"],
                [pending.instanceId, "local"],
              ]) {
                expect(registry.calls).toContainEqual({
                  op: "delete",
                  physicalId,
                  mode,
                });
              }
            }),
          { timeout: 10_000 },
        );
      }
    }
  },
);

// A single failed provider.delete used to abort the whole destroy, stranding
// every not-yet-deleted resource — even ones whose deletes would have
// succeeded. The engine now attempts every delete in dependency order,
// collects the failures, skips only resources whose DEPENDENT failed to
// delete (they may be legitimately undeletable — "blocked", not a second
// error), and raises everything at the end as one typed DestroyError.
describe("error-aggregating destroy", { tags: ["unit", "local"] }, () => {
  const expectDestroyError = (exit: Exit.Exit<unknown, unknown>) => {
    expect(Exit.isFailure(exit)).toBe(true);
    assert(Exit.isFailure(exit));
    const reason = exit.cause.reasons.find(Cause.isFailReason);
    const error = reason?.error as DestroyError;
    expect(error._tag).toBe("DestroyError");
    return error;
  };

  test.provider(
    "a failed delete does not abort sibling deletes and aggregates into DestroyError",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("A", { string: "a" });
            yield* TestResource("B", { string: "b" });
            yield* TestResource("C", { string: "c" });
          }),
        );

        const deleted: string[] = [];
        const exit = yield* stack.destroy().pipe(
          Effect.provide(
            Layer.succeed(TestResourceHooks, {
              delete: (id: string) =>
                id === "B"
                  ? Effect.fail(new ResourceFailure())
                  : Effect.sync(() => void deleted.push(id)),
            }),
          ),
          Effect.exit,
        );

        // The independent siblings were still deleted...
        expect(deleted.sort()).toEqual(["A", "C"]);
        expect(yield* getState("A")).toBeUndefined();
        expect(yield* getState("C")).toBeUndefined();
        // ...the failed resource stays behind for the next destroy...
        expect((yield* getState("B"))?.status).toEqual("deleting");

        // ...and the destroy as a whole still fails, with a typed aggregate.
        const error = expectDestroyError(exit);
        expect(error.failures.map((f) => f.fqn)).toEqual(["B"]);
        expect(error.blocked).toEqual([]);

        // A subsequent destroy (failure gone) converges.
        yield* stack.destroy();
        expect(yield* listState()).toEqual([]);
      }),
  );

  test.provider(
    "a resource whose dependent failed to delete is skipped as blocked, not attempted",
    (stack) =>
      Effect.gen(function* () {
        // A <- B <- C is a dependency chain (deletes run C, B, A); D is
        // independent.
        yield* stack.deploy(
          Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a" });
            const B = yield* TestResource("B", { string: A.string });
            yield* TestResource("C", { string: B.string });
            yield* TestResource("D", { string: "d" });
          }),
        );

        const deleted: string[] = [];
        const exit = yield* stack.destroy().pipe(
          Effect.provide(
            Layer.succeed(TestResourceHooks, {
              delete: (id: string) =>
                id === "C"
                  ? Effect.fail(new ResourceFailure())
                  : Effect.sync(() => void deleted.push(id)),
            }),
          ),
          Effect.exit,
        );

        // Only the independent sibling was attempted and deleted. A and B
        // sit upstream of the failed C, so their deletes were never even
        // attempted — they may be legitimately undeletable while C exists.
        expect(deleted).toEqual(["D"]);
        expect(yield* getState("D")).toBeUndefined();
        expect((yield* getState("C"))?.status).toEqual("deleting");
        expect((yield* getState("B"))?.status).toEqual("created");
        expect((yield* getState("A"))?.status).toEqual("created");

        // The aggregate reports exactly one FAILURE (C); B and A are
        // "blocked by" notes, not spurious errors.
        const error = expectDestroyError(exit);
        expect(error.failures.map((f) => f.fqn)).toEqual(["C"]);
        expect(
          error.blocked
            .map((b) => ({ fqn: b.fqn, blockedBy: b.blockedBy }))
            .sort((x, y) => x.fqn.localeCompare(y.fqn)),
        ).toEqual([
          { fqn: "A", blockedBy: ["B"] },
          { fqn: "B", blockedBy: ["C"] },
        ]);

        // Once the blocker can be deleted, everything drains.
        yield* stack.destroy();
        expect(yield* listState()).toEqual([]);
      }),
  );

  test.provider(
    "independent subtrees are unaffected by a failure in another subtree",
    (stack) =>
      Effect.gen(function* () {
        // Two disjoint chains: A <- B (B's delete fails) and X <- Y.
        yield* stack.deploy(
          Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "a" });
            yield* TestResource("B", { string: A.string });
            const X = yield* TestResource("X", { string: "x" });
            yield* TestResource("Y", { string: X.string });
          }),
        );

        const deleted: string[] = [];
        const exit = yield* stack.destroy().pipe(
          Effect.provide(
            Layer.succeed(TestResourceHooks, {
              delete: (id: string) =>
                id === "B"
                  ? Effect.fail(new ResourceFailure())
                  : Effect.sync(() => void deleted.push(id)),
            }),
          ),
          Effect.exit,
        );

        // The X <- Y chain drained fully, in dependency order.
        expect(deleted).toEqual(["Y", "X"]);
        expect(yield* getState("X")).toBeUndefined();
        expect(yield* getState("Y")).toBeUndefined();
        // B failed; A is blocked behind it.
        expect((yield* getState("B"))?.status).toEqual("deleting");
        expect((yield* getState("A"))?.status).toEqual("created");

        const error = expectDestroyError(exit);
        expect(error.failures.map((f) => f.fqn)).toEqual(["B"]);
        expect(error.blocked.map((b) => b.fqn)).toEqual(["A"]);
      }),
  );

  test.provider(
    "a failed replaced-old-generation delete fails the deploy without spinning the drain loop",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("A", { replaceString: "v1" });
          }),
        );

        // Replacement create succeeds; GC then fails to delete the old
        // generation. The drain loop must terminate (the still-`replaced`
        // row is excluded from retry) and surface the typed aggregate.
        const exit = yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* TestResource("A", { replaceString: "v2" });
            }),
          )
          .pipe(
            Effect.provide(
              Layer.succeed(TestResourceHooks, {
                delete: () => Effect.fail(new ResourceFailure()),
              }),
            ),
            Effect.exit,
          );

        const error = expectDestroyError(exit);
        expect(error.failures.map((f) => f.fqn)).toEqual(["A"]);

        // The replacement chain is preserved for a later deploy to drain.
        const state = yield* getState<ReplacedResourceState>("A");
        expect(state?.status).toEqual("replaced");
        expect(state?.old?.status).toEqual("created");

        // Next deploy (delete healthy again) drains the old chain.
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("A", { replaceString: "v2" });
          }),
        );
        expect((yield* getState("A"))?.status).toEqual("created");
      }),
    { timeout: 15_000 },
  );
});

describe("provider modes (local ⇄ live)", { tags: ["unit", "local"] }, () => {
  // ModalResource registers via `ProviderLayer.dual` with distinct live and
  // local implementations that record lifecycle calls per variant into
  // `modalCalls` (tagged with the scratch stack name so concurrent tests can
  // filter to their own activity). These tests cover the APPLY-level
  // semantics: `providerMode` stamping across every lifecycle commit,
  // mode-correct deletes of old generations and orphans, replaced-chain
  // draining, destroy, and legacy-row re-stamping.

  const callsFor = (stackName: string) =>
    modalCalls.filter((c) => c.stack === stackName);

  const setState = Effect.fn(function* (fqn: string, value: ResourceState) {
    const state = yield* yield* State;
    const stk = yield* Stack;
    yield* state.set({ stack: stk.name, stage: stk.stage, fqn, value });
  });

  const modal = (id: string, props: ModalResourceProps) =>
    Effect.gen(function* () {
      const a = yield* ModalResource(id, props);
      return { runtime: a.runtime };
    });

  test.provider(
    "providerMode is stamped through create → update → mode-switch replace → same-mode replace",
    (stack) =>
      Effect.gen(function* () {
        // ── create (dev run → local) ──
        const created = yield* inDev(
          modal("A", { value: "v1" }).pipe(stack.deploy),
        );
        expect(created.runtime).toEqual("local");
        const afterCreate = yield* getState("A");
        expect(afterCreate?.status).toEqual("created");
        expect(afterCreate?.providerMode).toEqual("local");
        const localInstanceId = afterCreate?.instanceId;

        // ── update (still a dev run → local) ──
        yield* inDev(modal("A", { value: "v2" }).pipe(stack.deploy));
        const afterUpdate = yield* getState("A");
        expect(afterUpdate?.status).toEqual("updated");
        expect(afterUpdate?.providerMode).toEqual("local");
        expect(afterUpdate?.instanceId).toEqual(localInstanceId);

        // ── mode switch (local → live): replacement; the LOCAL provider
        //    deletes the old generation, the LIVE provider creates the new ──
        const before = callsFor(stack.name).length;
        const switched = yield* modal("A", { value: "v2" }).pipe(stack.deploy);
        expect(switched.runtime).toEqual("live");
        const afterSwitch = yield* getState("A");
        expect(afterSwitch?.status).toEqual("created");
        expect(afterSwitch?.providerMode).toEqual("live");
        expect(afterSwitch?.instanceId).not.toEqual(localInstanceId);
        const switchCalls = callsFor(stack.name).slice(before);
        expect(switchCalls).toContainEqual({
          stack: stack.name,
          mode: "live",
          op: "reconcile",
          id: "A",
        });
        expect(switchCalls).toContainEqual({
          stack: stack.name,
          mode: "local",
          op: "delete",
          id: "A",
        });

        // ── ordinary (same-mode) replacement via the provider diff:
        //    providerMode survives, and the old generation is deleted with
        //    its own (live) mode ──
        const beforeReplace = callsFor(stack.name).length;
        yield* modal("A", { value: "v2", replaceValue: "r2" }).pipe(
          stack.deploy,
        );
        const afterReplace = yield* getState("A");
        expect(afterReplace?.status).toEqual("created");
        expect(afterReplace?.providerMode).toEqual("live");
        expect(afterReplace?.instanceId).not.toEqual(afterSwitch?.instanceId);
        expect(callsFor(stack.name).slice(beforeReplace)).toContainEqual({
          stack: stack.name,
          mode: "live",
          op: "delete",
          id: "A",
        });

        yield* stack.destroy();
        expect(yield* getState("A")).toBeUndefined();
      }),
  );

  test.provider(
    "a replaced chain drains each old generation with ITS stamped mode",
    (stack) =>
      Effect.gen(function* () {
        // Simulate an interrupted mode-switch deploy: the live replacement
        // was created and committed as `replaced`, but the apply died before
        // GC drained the old (local) generation. The recovery deploy's GC
        // must delete that generation with the LOCAL provider.
        const oldInstanceId = "11111111111111111111111111111111";
        const newInstanceId = "22222222222222222222222222222222";
        yield* setState("A", {
          status: "replaced",
          fqn: "A",
          logicalId: "A",
          namespace: undefined,
          instanceId: newInstanceId,
          resourceType: "Test.ModalResource",
          providerVersion: 0,
          props: { value: "v1" },
          attr: { value: "v1", runtime: "live" },
          bindings: [],
          downstream: [],
          deleteFirst: false,
          providerMode: "live",
          old: {
            status: "created",
            fqn: "A",
            logicalId: "A",
            namespace: undefined,
            instanceId: oldInstanceId,
            resourceType: "Test.ModalResource",
            providerVersion: 0,
            props: { value: "v1" },
            attr: { value: "v1", runtime: "local" },
            bindings: [],
            downstream: [],
            providerMode: "local",
          },
        } as ResourceState);

        const before = callsFor(stack.name).length;
        // Identical props, live-default run: the top generation noops and
        // GC drains the pending old chain.
        yield* modal("A", { value: "v1" }).pipe(stack.deploy);

        expect(callsFor(stack.name).slice(before)).toContainEqual({
          stack: stack.name,
          mode: "local",
          op: "delete",
          id: "A",
        });
        const settled = yield* getState("A");
        expect(settled?.status).toEqual("created");
        expect(settled?.providerMode).toEqual("live");
        expect(settled?.instanceId).toEqual(newInstanceId);

        yield* stack.destroy();
      }),
  );

  test.provider(
    "stack.destroy tears down a local row with the local provider during a live-default run",
    (stack) =>
      Effect.gen(function* () {
        yield* inDev(modal("A", { value: "v1" }).pipe(stack.deploy));
        expect((yield* getState("A"))?.providerMode).toEqual("local");

        // `stack.destroy()` runs without any mode policy — the run default
        // is live — but the orphaned row must still be deleted by the
        // provider that created it.
        const before = callsFor(stack.name).length;
        yield* stack.destroy();

        expect(yield* getState("A")).toBeUndefined();
        expect(yield* listState()).toEqual([]);
        expect(callsFor(stack.name).slice(before)).toContainEqual({
          stack: stack.name,
          mode: "local",
          op: "delete",
          id: "A",
        });
      }),
  );

  test.provider(
    "legacy rows (no persisted mode) are re-stamped on their next write",
    (stack) =>
      Effect.gen(function* () {
        yield* modal("A", { value: "v1" }).pipe(stack.deploy);
        const row = yield* getState("A");
        expect(row?.providerMode).toEqual("live");

        // Simulate a row written before providerMode existed.
        yield* setState("A", { ...row!, providerMode: undefined });

        // Same-mode update: no replacement churn (assumed current mode) and
        // the row comes out stamped.
        yield* modal("A", { value: "v2" }).pipe(stack.deploy);
        const restamped = yield* getState("A");
        expect(restamped?.status).toEqual("updated");
        expect(restamped?.providerMode).toEqual("live");
        // Same instance — the legacy row was updated, not replaced.
        expect(restamped?.instanceId).toEqual(row?.instanceId);

        yield* stack.destroy();
      }),
  );

  test.provider(
    "a deleteFirst replacement tears down a mixed-mode old chain, each generation with its own provider",
    (stack) =>
      Effect.gen(function* () {
        // An interrupted local → live switch left a `replaced` row: live top
        // generation, undrained local old generation. A deleteFirst
        // replacement (deleteFirstValue change) now restarts a new outer
        // generation and must tear the WHOLE chain down before creating —
        // the live generation with the LIVE provider, the local generation
        // with the LOCAL provider (`deleteOldGenerations`).
        const oldInstanceId = "11111111111111111111111111111111";
        const newInstanceId = "22222222222222222222222222222222";
        yield* setState("A", {
          status: "replaced",
          fqn: "A",
          logicalId: "A",
          namespace: undefined,
          instanceId: newInstanceId,
          resourceType: "Test.ModalResource",
          providerVersion: 0,
          props: { value: "v1" },
          attr: { value: "v1", runtime: "live" },
          bindings: [],
          downstream: [],
          deleteFirst: false,
          providerMode: "live",
          old: {
            status: "created",
            fqn: "A",
            logicalId: "A",
            namespace: undefined,
            instanceId: oldInstanceId,
            resourceType: "Test.ModalResource",
            providerVersion: 0,
            props: { value: "v1" },
            attr: { value: "v1", runtime: "local" },
            bindings: [],
            downstream: [],
            providerMode: "local",
          },
        } as ResourceState);

        const before = callsFor(stack.name).length;
        yield* modal("A", { value: "v1", deleteFirstValue: "df" }).pipe(
          stack.deploy,
        );

        const calls = callsFor(stack.name).slice(before);
        const liveDelete = calls.findIndex(
          (c) => c.op === "delete" && c.mode === "live",
        );
        const localDelete = calls.findIndex(
          (c) => c.op === "delete" && c.mode === "local",
        );
        const create = calls.findIndex(
          (c) => c.op === "reconcile" && c.mode === "live",
        );
        expect(liveDelete).toBeGreaterThanOrEqual(0);
        expect(localDelete).toBeGreaterThanOrEqual(0);
        // deleteFirst: the whole old chain is reclaimed BEFORE the new
        // generation is created.
        expect(create).toBeGreaterThan(liveDelete);
        expect(create).toBeGreaterThan(localDelete);

        const settled = yield* getState("A");
        expect(settled?.status).toEqual("created");
        expect(settled?.providerMode).toEqual("live");
        expect(settled?.instanceId).not.toEqual(newInstanceId);

        yield* stack.destroy();
      }),
  );

  test.provider(
    "a failed mode-switch create leaves the old runtime's instance intact, then converges on retry",
    (stack) =>
      Effect.gen(function* () {
        yield* inDev(modal("A", { value: "v1" }).pipe(stack.deploy));
        const localRow = yield* getState("A");
        expect(localRow?.providerMode).toEqual("local");

        // The live replacement's create fails. Replacements are
        // create-first, so the local generation must survive (it is only
        // reclaimed by GC after a successful create — which never runs on a
        // failed apply).
        const before = callsFor(stack.name).length;
        const failCreate = Layer.succeed(TestResourceHooks, {
          create: () => Effect.fail(new ResourceFailure()),
        });
        const exit = yield* modal("A", { value: "v1" }).pipe(
          stack.deploy,
          Effect.provide(failCreate),
          Effect.exit,
        );
        expect(Exit.isFailure(exit)).toBe(true);

        const failedCalls = callsFor(stack.name).slice(before);
        expect(
          failedCalls.some((c) => c.op === "delete" && c.mode === "local"),
        ).toBe(false);
        const interrupted = yield* getState("A");
        expect(interrupted?.status).toEqual("replacing");
        expect(interrupted?.providerMode).toEqual("live");
        expect(
          (interrupted as ReplacingResourceState).old.providerMode,
        ).toEqual("local");

        // Retry (same live mode): the interrupted replacement resumes, the
        // live create succeeds, and GC finally reclaims the local instance
        // with the LOCAL provider.
        const beforeRetry = callsFor(stack.name).length;
        const retried = yield* modal("A", { value: "v1" }).pipe(stack.deploy);
        expect(retried.runtime).toEqual("live");
        expect(callsFor(stack.name).slice(beforeRetry)).toContainEqual({
          stack: stack.name,
          mode: "local",
          op: "delete",
          id: "A",
        });
        const settled = yield* getState("A");
        expect(settled?.status).toEqual("created");
        expect(settled?.providerMode).toEqual("live");

        yield* stack.destroy();
      }),
  );

  test.provider(
    "GC drains a multi-generation chain with per-generation modes",
    (stack) =>
      Effect.gen(function* () {
        // Two undrained generations with DIFFERENT modes: the outer old is a
        // replaced local generation whose own old is a live generation
        // (live → local → live churn interrupted twice). GC pops one
        // generation per pass — each must be deleted by its own provider.
        const inner = "00000000000000000000000000000000";
        const middle = "11111111111111111111111111111111";
        const top = "22222222222222222222222222222222";
        yield* setState("A", {
          status: "replaced",
          fqn: "A",
          logicalId: "A",
          namespace: undefined,
          instanceId: top,
          resourceType: "Test.ModalResource",
          providerVersion: 0,
          props: { value: "v1" },
          attr: { value: "v1", runtime: "live" },
          bindings: [],
          downstream: [],
          deleteFirst: false,
          providerMode: "live",
          old: {
            status: "replaced",
            fqn: "A",
            logicalId: "A",
            namespace: undefined,
            instanceId: middle,
            resourceType: "Test.ModalResource",
            providerVersion: 0,
            props: { value: "v1" },
            attr: { value: "v1", runtime: "local" },
            bindings: [],
            downstream: [],
            deleteFirst: false,
            providerMode: "local",
            old: {
              status: "created",
              fqn: "A",
              logicalId: "A",
              namespace: undefined,
              instanceId: inner,
              resourceType: "Test.ModalResource",
              providerVersion: 0,
              props: { value: "v1" },
              attr: { value: "v1", runtime: "live" },
              bindings: [],
              downstream: [],
              providerMode: "live",
            },
          },
        } as ResourceState);

        const before = callsFor(stack.name).length;
        yield* modal("A", { value: "v1" }).pipe(stack.deploy);

        const deletes = callsFor(stack.name)
          .slice(before)
          .filter((c) => c.op === "delete");
        // Outer-in: the middle (local) generation pops first, then the
        // inner (live) one — each with its own stamped mode.
        expect(deletes.map((c) => c.mode)).toEqual(["local", "live"]);

        const settled = yield* getState("A");
        expect(settled?.status).toEqual("created");
        expect(settled?.providerMode).toEqual("live");
        expect(settled?.instanceId).toEqual(top);

        yield* stack.destroy();
      }),
  );

  test.provider(
    "a mode switch flows through downstream dependents end-to-end",
    (stack) =>
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          const a = yield* ModalResource("A", { value: "v1" });
          const b = yield* TestResource("B", { string: a.value });
          return { runtime: a.runtime, string: b.string };
        });

        const dev = yield* inDev(program.pipe(stack.deploy));
        expect(dev.runtime).toEqual("local");
        expect(dev.string).toEqual("v1");

        // Switching A to live replaces it; B (mode-agnostic) re-reconciles
        // against the replacement's fresh attrs instead of nooping on stale
        // ones, and both settle in a terminal state.
        const promoted = yield* program.pipe(stack.deploy);
        expect(promoted.runtime).toEqual("live");
        expect(promoted.string).toEqual("v1");

        const a = yield* getState("A");
        expect(a?.status).toEqual("created");
        expect(a?.providerMode).toEqual("live");
        const b = yield* getState("B");
        expect(["created", "updated"]).toContain(b?.status);
        expect(b?.providerMode).toBeUndefined();

        yield* stack.destroy();
        expect(yield* listState()).toEqual([]);
      }),
  );
});

describe(
  "binding client data-plane routing (apply)",
  { tags: ["unit", "local"] },
  () => {
    // Action bodies invoke Binding.Service clients at apply time. In a
    // `dev` run the wrap must route local resources to the emulator plane
    // and `Alchemy.remote()` resources to the live plane — the inverse of
    // each other, and never ambient.

    test.provider(
      "dev Action on a local resource hits the emulator plane",
      (stack) =>
        Effect.gen(function* () {
          const out = yield* inDev(
            Effect.gen(function* () {
              const resource = yield* ModalResource("A", { value: "v1" });
              const Probe = Action(
                "ProbeLocal",
                Effect.gen(function* () {
                  const read = yield* ProbeBinding(resource);
                  return () => read();
                }),
              );
              return yield* Probe({});
            }).pipe(stack.deploy),
          );
          expect(out).toBe("local");
        }),
    );

    test.provider(
      "dev Action on a remote() resource hits the live plane",
      (stack) =>
        Effect.gen(function* () {
          const out = yield* inDev(
            Effect.gen(function* () {
              const resource = yield* ModalResource("A", { value: "v1" }).pipe(
                remote(),
              );
              const Probe = Action(
                "ProbeRemote",
                Effect.gen(function* () {
                  const read = yield* ProbeBinding(resource);
                  return () => read();
                }),
              );
              return yield* Probe({});
            }).pipe(stack.deploy),
          );
          expect(out).toBe("live");
        }),
    );
  },
);

// Apply must honor dependency ORDER and resolve values for references at ANY
// nesting depth of plain data — objects in arrays, arrays in objects, arrays
// of arrays, whole-resource refs (#1082 hardened the walkers with a
// plain-data gate + cycle guards; these pin end-to-end that no nesting shape
// lost its edge or its resolution).
describe(
  "deeply nested dependencies (order + resolution)",
  { tags: ["unit", "local"] },
  () => {
    test.provider(
      "creates upstream first and resolves refs at every nesting depth",
      (stack) =>
        Effect.gen(function* () {
          const createOrder: string[] = [];
          let bCreateProps: any;
          const createHooks = {
            create: (id: string, props: any) =>
              Effect.sync(() => {
                createOrder.push(id);
                if (id === "B") bCreateProps = props;
              }),
            update: () => Effect.succeed(undefined),
            delete: () => Effect.succeed(undefined),
            read: () => Effect.succeed(undefined),
          };

          const nestedProps = (a: any) =>
            ({
              layers: [{ config: { hosts: [{ url: a.string }] } }],
              matrix: [[a.string]],
              whole: { list: [a] },
              mixed: [1, "x", { deep: [a.string] }, null],
            }) as any;

          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "deep-a" });
            const B = yield* TestResource("B", nestedProps(A));
            return { A, B };
          }).pipe(stack.deploy, hook(createHooks));

          // Order: the ONLY references to A are deeply nested — A must still
          // be created before B.
          expect(createOrder).toEqual(["A", "B"]);

          // Resolution: every nested position received the concrete value.
          expect(bCreateProps.layers[0].config.hosts[0].url).toBe("deep-a");
          expect(bCreateProps.matrix[0][0]).toBe("deep-a");
          expect(bCreateProps.mixed[2].deep[0]).toBe("deep-a");
          // A whole-resource reference resolves to the upstream's attributes.
          expect(bCreateProps.whole.list[0].string).toBe("deep-a");

          // Second deploy: the upstream value changes; the change must
          // propagate through every nested position, again upstream-first.
          const updateOrder: string[] = [];
          let bUpdateProps: any;
          const updateHooks = {
            create: () => Effect.succeed(undefined),
            update: (id: string, props: any) =>
              Effect.sync(() => {
                updateOrder.push(id);
                if (id === "B") bUpdateProps = props;
              }),
            delete: () => Effect.succeed(undefined),
            read: () => Effect.succeed(undefined),
          };

          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "deep-a2" });
            const B = yield* TestResource("B", nestedProps(A));
            return { A, B };
          }).pipe(stack.deploy, hook(updateHooks));

          expect(updateOrder).toEqual(["A", "B"]);
          expect(bUpdateProps.layers[0].config.hosts[0].url).toBe("deep-a2");
          expect(bUpdateProps.matrix[0][0]).toBe("deep-a2");
          expect(bUpdateProps.mixed[2].deep[0]).toBe("deep-a2");
          expect(bUpdateProps.whole.list[0].string).toBe("deep-a2");

          yield* stack.destroy();
          expect(yield* listState()).toEqual([]);
        }),
    );

    test.provider(
      "a fan-in of deeply nested deps creates ALL upstreams before the dependent",
      (stack) =>
        Effect.gen(function* () {
          const order: string[] = [];
          let cProps: any;
          const hooks = {
            create: (id: string, props: any) =>
              Effect.sync(() => {
                order.push(id);
                if (id === "C") cProps = props;
              }),
            update: () => Effect.succeed(undefined),
            delete: () => Effect.succeed(undefined),
            read: () => Effect.succeed(undefined),
          };

          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "fan-a" });
            const B = yield* TestResource("B", { string: "fan-b" });
            const C = yield* TestResource("C", {
              fromA: { arr: [{ v: A.string }] },
              fromB: [[{ v: B.string }]],
            } as any);
            return { A, B, C };
          }).pipe(stack.deploy, hook(hooks));

          // A and B may create in either order (they're independent), but C
          // must come last.
          expect(order).toHaveLength(3);
          expect(order[2]).toBe("C");
          expect(order.slice(0, 2).sort()).toEqual(["A", "B"]);
          expect(cProps.fromA.arr[0].v).toBe("fan-a");
          expect(cProps.fromB[0][0].v).toBe("fan-b");

          yield* stack.destroy();
          expect(yield* listState()).toEqual([]);
        }),
    );

    test.provider(
      "a dependency chain through nested containers applies in topological order",
      (stack) =>
        Effect.gen(function* () {
          const order: string[] = [];
          const hooks = {
            create: (id: string) =>
              Effect.sync(() => {
                order.push(id);
              }),
            update: () => Effect.succeed(undefined),
            delete: () => Effect.succeed(undefined),
            read: () => Effect.succeed(undefined),
          };

          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", { string: "chain-a" });
            const B = yield* TestResource("B", {
              nested: [{ from: A.string }],
            } as any);
            const C = yield* TestResource("C", {
              nested: { deep: [[B.string]] },
            } as any);
            return { A, B, C };
          }).pipe(stack.deploy, hook(hooks));

          expect(order).toEqual(["A", "B", "C"]);

          yield* stack.destroy();
          expect(yield* listState()).toEqual([]);
        }),
    );
  },
);

// End-to-end pins for the #1082 leaf rules: class instances in props reach
// `reconcile` by identity (prototype intact), are stripped from persisted
// state, and never churn a diff; cyclic plain data deploys and re-deploys
// without hanging or phantom updates.
describe(
  "non-plain and cyclic props through deploy",
  { tags: ["unit", "local"] },
  () => {
    test.provider(
      "a Date prop reaches reconcile intact and re-deploys without churn",
      (stack) =>
        Effect.gen(function* () {
          const seen: Date[] = [];
          const updates: string[] = [];
          const hooks = {
            create: (_id: string, props: any) =>
              Effect.sync(() => {
                seen.push(props.expires);
              }),
            update: (id: string, props: any) =>
              Effect.sync(() => {
                updates.push(id);
                seen.push(props.expires);
              }),
            delete: () => Effect.succeed(undefined),
            read: () => Effect.succeed(undefined),
          };

          const program = (iso: string) =>
            Effect.gen(function* () {
              return yield* TestResource("A", {
                string: "date-holder",
                expires: new Date(iso),
              } as any);
            });

          yield* program("2027-01-01").pipe(stack.deploy, hook(hooks));
          // The Date arrives in reconcile as a real Date, not `{}`.
          expect(seen[0]).toBeInstanceOf(Date);
          expect(seen[0]!.toISOString()).toBe("2027-01-01T00:00:00.000Z");

          // And it ROUND-TRIPS: read back out of the (durable, on-disk)
          // store, the persisted prop is a real Date again — the DATE_MARKER
          // envelope in StateEncoding, not a bare ISO string. This is what
          // provider diff/delete/read receive as `olds` on a later run.
          const persisted = (yield* getState("A"))?.props as {
            expires: Date;
          };
          expect(persisted.expires).toBeInstanceOf(Date);
          expect(persisted.expires.toISOString()).toBe(
            "2027-01-01T00:00:00.000Z",
          );

          // Same date again — no phantom update from Date handling.
          yield* program("2027-01-01").pipe(stack.deploy, hook(hooks));
          expect(updates).toEqual([]);

          // Changed date — must be detected and delivered.
          yield* program("2028-06-15").pipe(stack.deploy, hook(hooks));
          expect(updates).toEqual(["A"]);
          const last = seen[seen.length - 1]!;
          expect(last).toBeInstanceOf(Date);
          expect(last.toISOString()).toBe("2028-06-15T00:00:00.000Z");

          yield* stack.destroy();
          expect(yield* listState()).toEqual([]);
        }),
    );

    test.provider(
      "a class-instance prop reaches reconcile by identity and never churns",
      (stack) =>
        Effect.gen(function* () {
          class SdkConfig {
            constructor(readonly region: string) {}
          }
          const received: any[] = [];
          const updates: string[] = [];
          const hooks = {
            create: (_id: string, props: any) =>
              Effect.sync(() => {
                received.push(props.config);
              }),
            update: (id: string) =>
              Effect.sync(() => {
                updates.push(id);
              }),
            delete: () => Effect.succeed(undefined),
            read: () => Effect.succeed(undefined),
          };

          const program = () =>
            Effect.gen(function* () {
              // A fresh instance every deploy — identity differs run to run.
              return yield* TestResource("A", {
                string: "sdk-holder",
                config: new SdkConfig("us-east-1"),
              } as any);
            });

          yield* program().pipe(stack.deploy, hook(hooks));
          // Prototype intact all the way into reconcile.
          expect(received[0]).toBeInstanceOf(SdkConfig);
          expect(received[0].region).toBe("us-east-1");

          // Persisted state holds plain data only — the instance is stripped.
          const persisted = yield* getState("A");
          expect((persisted?.props as any).config).toBeUndefined();
          expect(() => JSON.stringify(persisted?.props)).not.toThrow();

          // A fresh (different-identity) instance must not cause an update:
          // runtime-only wiring is invisible to the diff.
          yield* program().pipe(stack.deploy, hook(hooks));
          expect(updates).toEqual([]);

          yield* stack.destroy();
          expect(yield* listState()).toEqual([]);
        }),
    );

    test.provider(
      "cyclic plain props deploy, persist truncated, and re-deploy as noop",
      (stack) =>
        Effect.gen(function* () {
          const updates: string[] = [];
          const hooks = {
            create: () => Effect.succeed(undefined),
            update: (id: string) =>
              Effect.sync(() => {
                updates.push(id);
              }),
            delete: () => Effect.succeed(undefined),
            read: () => Effect.succeed(undefined),
          };

          const program = () =>
            Effect.gen(function* () {
              const cyclic: any = { name: "cfg" };
              cyclic.self = cyclic;
              const A = yield* TestResource("A", { string: "up" });
              const B = yield* TestResource("B", {
                config: cyclic,
                url: A.string,
              } as any);
              return { A, B };
            });

          yield* program().pipe(stack.deploy, hook(hooks));

          // Persisted with the cycle cut — still JSON-serializable.
          const persisted = yield* getState("B");
          expect((persisted?.props as any).config.name).toBe("cfg");
          expect((persisted?.props as any).config.self).toBeUndefined();
          expect(() => JSON.stringify(persisted?.props)).not.toThrow();

          // Identical (still-cyclic) props — a clean noop.
          yield* program().pipe(stack.deploy, hook(hooks));
          expect(updates).toEqual([]);

          yield* stack.destroy();
          expect(yield* listState()).toEqual([]);
        }),
    );
  },
);

describe("renamed resources (renamedFrom)", { tags: ["unit", "local"] }, () => {
  const setState = Effect.fn(function* (fqn: string, value: ResourceState) {
    const state = yield* yield* State;
    const stk = yield* Stack;
    yield* state.set({ stack: stk.name, stage: stk.stage, fqn, value });
  });

  test.provider(
    "migrates the state row from a former FQN without recreating the resource",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("Old", { string: "v1" });
          }),
        );
        const before = yield* getState("Old");
        expect(before?.status).toEqual("created");

        // Redeploy under the new id: no create, no delete — the state row
        // moves and exactly ONE update reconcile runs to re-brand the
        // physical resource (its tags still carry the old logical id).
        const touched: string[] = [];
        const track = (op: string) => (id: string) =>
          Effect.sync(() => void touched.push(`${op}:${id}`));
        yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* TestResource("New", { string: "v1" }).pipe(
                renamedFrom("Old"),
              );
            }),
          )
          .pipe(
            hook({
              create: track("create"),
              update: track("update"),
              delete: track("delete"),
            }),
          );
        expect(touched).toEqual(["update:New"]);

        const after = yield* getState("New");
        expect(after?.instanceId).toEqual(before?.instanceId);
        expect(after?.logicalId).toEqual("New");
        expect(yield* getState("Old")).toBeUndefined();

        // A second deploy is a clean noop — the migration is done.
        const touchedAgain: string[] = [];
        const trackAgain = (op: string) => (id: string) =>
          Effect.sync(() => void touchedAgain.push(`${op}:${id}`));
        yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* TestResource("New", { string: "v1" }).pipe(
                renamedFrom("Old"),
              );
            }),
          )
          .pipe(
            hook({
              create: trackAgain("create"),
              update: trackAgain("update"),
              delete: trackAgain("delete"),
            }),
          );
        expect(touchedAgain).toEqual([]);

        yield* stack.destroy();
        expect(yield* listState()).toEqual([]);
      }),
  );

  test.provider(
    "the old id can be reused by a new resource without stealing the migrated physical",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("Old", { string: "v1" });
          }),
        );
        const before = yield* getState("Old");

        // One deploy renames Old → New AND declares a brand-new resource
        // reusing the id `Old`. The read hook simulates a tag-based
        // adoption probe that would FIND the migrated physical resource
        // (its cloud tags still say `Old`) — the engine must not consult
        // it for the reuser.
        const touched: string[] = [];
        const track = (op: string) => (id: string) =>
          Effect.sync(() => void touched.push(`${op}:${id}`));
        yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* TestResource("New", { string: "v1" }).pipe(
                renamedFrom("Old"),
              );
              yield* TestResource("Old", { string: "fresh" });
            }),
          )
          .pipe(
            hook({
              create: track("create"),
              update: track("update"),
              delete: track("delete"),
              read: () =>
                Effect.succeed({ string: "v1", urn: "stolen-physical" }),
            }),
          );

        // The renamed resource kept its identity...
        const renamed = yield* getState("New");
        expect(renamed?.instanceId).toEqual(before?.instanceId);
        // ...and the reuser was created FRESH: new instanceId, a real
        // create call, and no adoption of the migrated physical.
        const reuser = yield* getState("Old");
        expect(reuser?.instanceId).not.toEqual(before?.instanceId);
        expect(touched).toContain("create:Old");
        expect(touched).toContain("update:New");
        expect(touched.filter((t) => t.startsWith("delete"))).toEqual([]);

        yield* stack.destroy();
        expect(yield* listState()).toEqual([]);
      }),
  );

  test.provider(
    "a persisted renamer excludes its former FQN before the fresh create has a checkpoint",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const predecessor = yield* stack.deploy(
          TestResource("Old", { string: "original" }),
        );
        const renamed = TestResource("New", { string: "original" }).pipe(
          renamedFrom("Old"),
        );
        yield* stack.deploy(renamed).pipe(hook(failOn("New", "update")));
        expect(yield* getState("Old")).toBeUndefined();
        expect((yield* getState("New")).status).toBe("updating");
        let reads = 0;
        const freshCreated = yield* Deferred.make<void>();
        yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* renamed;
              const upstream = yield* Function("Upstream", { name: "fresh" });
              return yield* TestResource("Old", { string: upstream.name }).pipe(
                adopt(true),
              );
            }),
          )
          .pipe(
            Effect.provideService(TestResourceHooks, {
              read: (id) =>
                Effect.sync(() => {
                  if (id !== "Old") return undefined;
                  reads++;
                  return predecessor;
                }),
              update: (id) =>
                id === "New" ? Deferred.await(freshCreated) : Effect.void,
              create: (id) =>
                id === "Old"
                  ? Deferred.succeed(freshCreated, undefined).pipe(
                      Effect.asVoid,
                    )
                  : Effect.void,
            }),
          );
        expect(reads).toBe(0);
        yield* stack.destroy();
      }),
    { timeout: 10_000 },
  );

  for (const finish of ["destroy", "gc"] as const) {
    test.provider(
      `blocked create replacement retains migration exclusion through interruption and ${finish}`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const predecessor = yield* stack.deploy(
            TestResource("Old", { string: "original" }),
          );
          const app = (replaceString: string) =>
            Effect.gen(function* () {
              yield* TestResource("New", { string: "original" }).pipe(
                renamedFrom("Old"),
                RemovalPolicy.retain(),
              );
              const upstream = yield* TestResource("Upstream", {
                string: "fresh",
              });
              return yield* TestResource("Old", {
                string: replaceString === "first" ? upstream.string : "fresh",
                replaceString,
              }).pipe(adopt(true));
            });
          const interruptAtCheckpoint = (version: string) =>
            Effect.gen(function* () {
              const newStarted = yield* Deferred.make<void>();
              const upstreamStarted = yield* Deferred.make<void>();
              const oldCheckpointed = yield* Deferred.make<void>();
              const fiber = yield* stack.deploy(app(version)).pipe(
                Effect.provideService(TestResourceHooks, {
                  update: (id) =>
                    id === "New"
                      ? Deferred.succeed(newStarted, undefined).pipe(
                          Effect.andThen(Effect.never),
                        )
                      : Effect.void,
                  create: (id) =>
                    id === "Upstream"
                      ? Deferred.succeed(upstreamStarted, undefined).pipe(
                          Effect.andThen(Effect.never),
                        )
                      : Effect.void,
                }),
                Effect.provideService(Cli, {
                  ...recordingCli([]),
                  startApplySession: () =>
                    Effect.succeed({
                      done: () => Effect.void,
                      emit: (event) =>
                        event._tag === "apply.resource.status" &&
                        event.id === "Old" &&
                        event.status === "pending"
                          ? Deferred.succeed(oldCheckpointed, undefined).pipe(
                              Effect.andThen(Effect.never),
                            )
                          : Effect.void,
                    }),
                }),
                Effect.forkChild,
              );
              yield* Deferred.await(newStarted);
              yield* Deferred.await(upstreamStarted);
              yield* Deferred.await(oldCheckpointed);
              yield* Fiber.interrupt(fiber);
            });
          yield* interruptAtCheckpoint("first");
          const creating = yield* getState("Old");
          expect(creating.status).toBe("creating");
          expect(creating.adoptionBlocked).toBe("migrated-fqn");
          yield* interruptAtCheckpoint("second");
          const replacing = yield* getState("Old");
          expect(replacing.status).toBe("replacing");
          expect(replacing.attr).toBeUndefined();
          expect(replacing.instanceId).not.toBe(creating.instanceId);
          const reads: string[] = [];
          const deleted: string[] = [];
          const hooks = TestResourceHooks.of({
            read: (id) =>
              Effect.sync(() => {
                if (id !== "Old") return undefined;
                reads.push(id);
                return predecessor;
              }),
            delete: (id) =>
              Effect.sync(() => {
                deleted.push(id);
              }),
          });
          if (finish === "gc") {
            yield* stack
              .deploy(app("second"))
              .pipe(Effect.provideService(TestResourceHooks, hooks));
            const completed = yield* getState("Old");
            expect(completed.status).toBe("created");
            expect(completed.adoptionBlocked).toBe("migrated-fqn");
            expect(reads).toEqual([]);
            expect(deleted).toEqual([]);
            const next = yield* stack.plan(app("third"));
            expect(next.resources.Old?.action).toBe("replace");
            expect(next.resources.Old?.adoptionBlocked).toBe("migrated-fqn");
          }
          yield* stack
            .destroy()
            .pipe(Effect.provideService(TestResourceHooks, hooks));
          expect(reads).toEqual([]);
          expect(deleted.sort()).toEqual(
            finish === "gc" ? ["Old", "Upstream"] : [],
          );
          expect(replacing.adoptionBlocked).toBe("migrated-fqn");
          expect(yield* listState()).toEqual([]);
        }),
      { timeout: 10_000 },
    );
  }

  for (const recovery of ["plan", "deferred", "destroy"] as const) {
    test.provider(
      `interrupted migrated FQN reuse suppresses ${recovery} recovery of the predecessor`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const predecessorAttrs = yield* stack.deploy(
            TestResource("Old", { string: "original" }),
          );
          const predecessor = yield* getState("Old");
          const newStarted = yield* Deferred.make<void>();
          const upstreamStarted = yield* Deferred.make<void>();
          const oldCheckpointed = yield* Deferred.make<void>();
          let renaming = true;
          const app = Effect.gen(function* () {
            const target = TestResource("New", { string: "original" });
            yield* renaming ? target.pipe(renamedFrom("Old")) : target;
            const upstream = yield* TestResource("Upstream", {
              string: "fresh",
            });
            return yield* TestResource("Old", { string: upstream.string }).pipe(
              adopt(true),
            );
          });
          const fiber = yield* stack.deploy(app).pipe(
            Effect.provideService(TestResourceHooks, {
              update: (id) =>
                id === "New"
                  ? Deferred.succeed(newStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                    )
                  : Effect.void,
              create: (id) =>
                id === "Upstream"
                  ? Deferred.succeed(upstreamStarted, undefined).pipe(
                      Effect.andThen(Effect.never),
                    )
                  : Effect.void,
            }),
            Effect.provideService(Cli, {
              ...recordingCli([]),
              startApplySession: () =>
                Effect.succeed({
                  done: () => Effect.void,
                  emit: (event) =>
                    event._tag === "apply.resource.status" &&
                    event.id === "Old" &&
                    event.status === "pending"
                      ? Deferred.succeed(oldCheckpointed, undefined).pipe(
                          Effect.asVoid,
                        )
                      : Effect.void,
                }),
            }),
            Effect.forkChild,
          );
          yield* Deferred.await(newStarted);
          yield* Deferred.await(upstreamStarted);
          yield* Deferred.await(oldCheckpointed);
          yield* Fiber.interrupt(fiber);
          expect((yield* getState("New")).instanceId).toBe(
            predecessor.instanceId,
          );
          const fresh = yield* getState("Old");
          expect(fresh.status).toBe("creating");
          expect(fresh.attr).toBeUndefined();
          expect(fresh.props?.string).toBeUndefined();
          expect(fresh.instanceId).not.toBe(predecessor.instanceId);
          expect(fresh.adoptionBlocked).toBe("migrated-fqn");
          renaming = false;
          let reads = 0;
          if (recovery === "destroy") {
            const deleted: string[] = [];
            yield* stack.destroy().pipe(
              Effect.provideService(TestResourceHooks, {
                read: (id) =>
                  Effect.sync(() => {
                    if (id !== "Old") return undefined;
                    reads++;
                    return predecessorAttrs;
                  }),
                delete: (id) =>
                  Effect.sync(() => {
                    deleted.push(id);
                  }),
              }),
            );
            expect(reads).toBe(0);
            expect(deleted).toEqual(["New"]);
            return;
          }
          const freshCreated = yield* Deferred.make<void>();
          const createAttrs: Array<unknown> = [];
          const store = yield* yield* State;
          yield* stack.deploy(app).pipe(
            Effect.provideService(TestResourceHooks, {
              read: (id) =>
                Effect.sync(() => {
                  if (id !== "Old") return undefined;
                  reads++;
                  return recovery === "plan" || reads > 1
                    ? predecessorAttrs
                    : undefined;
                }),
              create: (id) =>
                id === "Old"
                  ? Effect.gen(function* () {
                      const current = yield* store.get({
                        stack: stack.name,
                        stage: stack.stage,
                        fqn: "Old",
                      });
                      assert(
                        current !== undefined && current.kind !== "action",
                      );
                      createAttrs.push(current.attr);
                      yield* Deferred.succeed(freshCreated, undefined);
                    })
                  : Effect.void,
              update: (id) =>
                id === "New" ? Deferred.await(freshCreated) : Effect.void,
            }),
          );
          expect(reads).toBe(0);
          expect(createAttrs).toEqual([undefined]);
          expect((yield* getState("New")).instanceId).toBe(
            predecessor.instanceId,
          );
          expect((yield* getState("Old")).instanceId).toBe(fresh.instanceId);
          yield* stack.destroy();
        }),
      { timeout: 10_000 },
    );
  }

  test.provider(
    "a reused migrated FQN skips deferred adoption even with unresolved upstream props",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        yield* stack.deploy(TestResource("Old", { string: "original" }));
        const previous = yield* getState("Old");
        const reads: string[] = [];
        yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* TestResource("New", { string: "original" }).pipe(
                renamedFrom("Old"),
              );
              const upstream = yield* Function("Upstream", { name: "fresh" });
              return yield* TestResource("Old", { string: upstream.name }).pipe(
                adopt(true),
              );
            }),
          )
          .pipe(
            Effect.provideService(TestResourceHooks, {
              read: (id) =>
                Effect.sync(() => {
                  reads.push(id);
                  return undefined;
                }),
            }),
          );
        expect(reads).toEqual([]);
        expect((yield* getState("New")).instanceId).toBe(previous.instanceId);
        expect((yield* getState("Old")).instanceId).not.toBe(
          previous.instanceId,
        );
        yield* stack.destroy();
      }),
  );

  test.provider(
    "migrates a namespaced row (StaticSite's <id>/Worker → <id> shape)",
    (stack) =>
      Effect.gen(function* () {
        // The pre-rename shape: `Worker` declared under the `App/Site`
        // namespace chain (fqn `App/Site/Worker`).
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* Effect.gen(function* () {
              yield* TestResource("Worker", { string: "v1" });
            }).pipe(Namespace.push("Site"), Namespace.push("App"));
          }),
        );
        const before = yield* getState("App/Site/Worker");
        expect(before?.status).toEqual("created");

        // The post-rename shape: the resource is `Site` itself, still under
        // `App`, claiming its former namespace-RELATIVE id — exactly what
        // StaticSite does with `renamedFrom(`${id}/Worker`)`.
        const touched: string[] = [];
        const track = (op: string) => (id: string) =>
          Effect.sync(() => void touched.push(`${op}:${id}`));
        yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* TestResource("Site", { string: "v1" }).pipe(
                renamedFrom("Site/Worker"),
                Namespace.push("App"),
              );
            }),
          )
          .pipe(
            hook({
              create: track("create"),
              update: track("update"),
              delete: track("delete"),
            }),
          );
        expect(touched).toEqual(["update:Site"]);

        const after = yield* getState("App/Site");
        expect(after?.instanceId).toEqual(before?.instanceId);
        expect(after?.logicalId).toEqual("Site");
        expect(yield* getState("App/Site/Worker")).toBeUndefined();

        yield* stack.destroy();
        expect(yield* listState()).toEqual([]);
      }),
  );

  test.provider(
    "finishes an interrupted migration state-only (rows at both FQNs, same instanceId)",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("New", { string: "v1" }).pipe(
              renamedFrom("Old"),
            );
          }),
        );
        const row = yield* getState("New");

        // Simulate a crash between apply's `state.set` (new FQN) and
        // `state.delete` (former FQN): a stale copy remains at `Old`.
        yield* setState("Old", { ...row!, fqn: "Old", logicalId: "Old" });

        const deleted: string[] = [];
        yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* TestResource("New", { string: "v1" }).pipe(
                renamedFrom("Old"),
              );
            }),
          )
          .pipe(
            hook({
              delete: (id: string) => Effect.sync(() => void deleted.push(id)),
            }),
          );

        // The leftover row was dropped WITHOUT a provider.delete.
        expect(deleted).toEqual([]);
        expect(yield* getState("Old")).toBeUndefined();
        expect((yield* getState("New"))?.instanceId).toEqual(row?.instanceId);

        yield* stack.destroy();
        expect(yield* listState()).toEqual([]);
      }),
  );

  test.provider(
    "a rename chain with repeated partial failures converges in one deploy",
    (stack) =>
      Effect.gen(function* () {
        // A → B rename, then B → C, with the A→B migration's delete having
        // failed (a leftover copy of the row remains at A).
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("A", { string: "v1" });
          }),
        );
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("B", { string: "v1" }).pipe(renamedFrom("A"));
          }),
        );
        const row = yield* getState("B");
        yield* setState("A", { ...row!, fqn: "A", logicalId: "A" });

        const touched: string[] = [];
        const track = (op: string) => (id: string) =>
          Effect.sync(() => void touched.push(`${op}:${id}`));
        yield* stack
          .deploy(
            Effect.gen(function* () {
              // Most recent former id first.
              yield* TestResource("C", { string: "v1" }).pipe(
                renamedFrom("B", "A"),
              );
            }),
          )
          .pipe(
            hook({
              create: track("create"),
              update: track("update"),
              delete: track("delete"),
            }),
          );

        // One deploy: migrated from B AND dropped the stale copy at A —
        // one re-branding update, no create, no delete.
        expect(touched).toEqual(["update:C"]);
        expect((yield* getState("C"))?.instanceId).toEqual(row?.instanceId);
        expect(yield* getState("B")).toBeUndefined();
        expect(yield* getState("A")).toBeUndefined();

        yield* stack.destroy();
        expect(yield* listState()).toEqual([]);
      }),
  );

  test.provider(
    "a same-deploy rename shift (A→B while B→C) moves both rows end-to-end",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("A", { string: "a" });
            yield* TestResource("B", { string: "b" });
          }),
        );
        const oldA = yield* getState("A");
        const oldB = yield* getState("B");

        // One deploy shifts both names: A→B and B→C. B's migration write
        // and C's former-row cleanup target the same FQN — the apply-side
        // discipline must never let C's delete destroy B's migrated row.
        const touched: string[] = [];
        const track = (op: string) => (id: string) =>
          Effect.sync(() => void touched.push(`${op}:${id}`));
        yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* TestResource("B", { string: "a" }).pipe(renamedFrom("A"));
              yield* TestResource("C", { string: "b" }).pipe(renamedFrom("B"));
            }),
          )
          .pipe(
            hook({
              create: track("create"),
              delete: track("delete"),
            }),
          );

        // No physical resource was created or deleted — both rows moved.
        expect(touched).toEqual([]);
        expect((yield* getState("B"))?.instanceId).toEqual(oldA?.instanceId);
        expect((yield* getState("C"))?.instanceId).toEqual(oldB?.instanceId);
        expect(yield* getState("A")).toBeUndefined();

        yield* stack.destroy();
        expect(yield* listState()).toEqual([]);
      }),
  );

  test.provider(
    "a pending replacement backlog drains after a rename",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("A", { string: "x", replaceString: "1" });
          }),
        );

        // A replacement whose old-generation delete FAILS: the new
        // generation is live but the old one stays queued in the row's
        // `old` chain (status `replaced`). The failed cleanup is soft at
        // deploy time — the deploy may still report success.
        yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* TestResource("A", { string: "x", replaceString: "2" });
            }),
          )
          .pipe(
            hook({
              delete: () => Effect.fail(new ResourceFailure()),
            }),
            Effect.exit,
          );
        const mid = yield* getState("A");
        expect(mid?.status).toEqual("replaced");
        expect((mid as any).old).toBeDefined();

        // Rename while the backlog is pending: the chain must ride the
        // migration and STILL drain — the old generation's physical
        // resource is deleted during the rename deploy.
        const deleted: string[] = [];
        yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* TestResource("B", {
                string: "x",
                replaceString: "2",
              }).pipe(renamedFrom("A"));
            }),
          )
          .pipe(
            hook({
              delete: (id: string) => Effect.sync(() => void deleted.push(id)),
            }),
          );

        // Exactly one physical delete: the queued old generation.
        expect(deleted).toHaveLength(1);
        const after = yield* getState("B");
        // The new generation survived under the new identity, chain drained.
        expect(after?.instanceId).toEqual(mid?.instanceId);
        expect(["created", "updated"]).toContain(after?.status);
        expect((after as any).old).toBeUndefined();
        expect(yield* getState("A")).toBeUndefined();

        yield* stack.destroy();
        expect(yield* listState()).toEqual([]);
      }),
  );

  test.provider(
    "ignores the alias when the new FQN row exists with a different instanceId",
    (stack) =>
      Effect.gen(function* () {
        // Both resources exist independently.
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* TestResource("Old", { string: "old" });
            yield* TestResource("New", { string: "new" });
          }),
        );
        const oldRow = yield* getState("Old");
        const newRow = yield* getState("New");
        expect(oldRow?.instanceId).not.toEqual(newRow?.instanceId);

        // `New` claims `Old` as a former FQN, but already has its own row —
        // the alias is ignored and `Old` is a normal orphan delete (the
        // physical resource IS deleted).
        const deleted: string[] = [];
        yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* TestResource("New", { string: "new" }).pipe(
                renamedFrom("Old"),
              );
            }),
          )
          .pipe(
            hook({
              delete: (id: string) => Effect.sync(() => void deleted.push(id)),
            }),
          );

        expect(deleted).toEqual(["Old"]);
        expect(yield* getState("Old")).toBeUndefined();
        expect((yield* getState("New"))?.instanceId).toEqual(
          newRow?.instanceId,
        );

        yield* stack.destroy();
        expect(yield* listState()).toEqual([]);
      }),
  );
});

describe("filtered reconciliation", { tags: ["unit", "local"] }, () => {
  for (const selection of [
    { include: ["Branch"] },
    { exclude: ["Worker", "NewUnselected", "SkippedAction", "Undeclared"] },
    {
      include: ["**"],
      exclude: ["Worker", "NewUnselected", "SkippedAction", "Undeclared"],
    },
  ]) {
    test.provider(
      `preserves unselected declared and undeclared rows and full-stack outputs ${JSON.stringify(selection)}`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const Compute = Action("SkippedAction", (_: { value: string }) =>
            Effect.succeed({ value: "old" }),
          );
          yield* stack.deploy(
            Effect.gen(function* () {
              yield* TestResource("Branch", { string: "v1" });
              yield* TestResource("Worker", { string: "old" });
              yield* TestResource("Undeclared", {});
              yield* Compute({ value: "old" });
              return { full: "original" };
            }),
          );
          const worker = yield* getState("Worker");
          const undeclared = yield* getState("Undeclared");
          const skipped = yield* getState("SkippedAction");
          const calls: string[] = [];
          const result = yield* stack
            .deploy(
              Effect.gen(function* () {
                const branch = yield* TestResource("Branch", { string: "v2" });
                yield* TestResource("Worker", { string: "changed" });
                yield* TestResource("NewUnselected", {});
                const Fail = Action("SkippedAction", (_: { value: string }) =>
                  Effect.die("unselected action ran"),
                );
                yield* Fail({ value: "changed" });
                return Output.map(branch.string, () => {
                  throw new Error("filtered output evaluated");
                });
              }),
              selection,
            )
            .pipe(
              Effect.provideService(TestResourceHooks, {
                update: (id) =>
                  Effect.sync(() => {
                    calls.push(id);
                  }),
                create: () => Effect.die("unselected create"),
                delete: () => Effect.die("unselected delete"),
              }),
            );
          expect(result).toBeUndefined();
          expect(calls).toEqual(["Branch"]);
          expect(yield* getState("Worker")).toEqual(worker);
          expect(yield* getState("Undeclared")).toEqual(undeclared);
          expect(yield* getState("SkippedAction")).toEqual(skipped);
          expect(yield* getState("NewUnselected")).toBeUndefined();
          const state = yield* yield* State;
          expect(
            yield* state.getOutput({ stack: stack.name, stage: stack.stage }),
          ).toEqual({ full: "original" });
          yield* stack.destroy();
        }),
    );
  }

  test.provider(
    "applies transitive bindings and captured Actions while retaining pure reuse",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        let runs = 0;
        const program = Effect.gen(function* () {
          const source = yield* TestResource("Source", { string: "input" });
          const captured = yield* TestResource("Captured", {
            string: "capture",
          });
          const Compute = Action(
            "Compute",
            Effect.gen(function* () {
              const value = yield* captured.string;
              return (input: { value: string }) =>
                Effect.gen(function* () {
                  runs++;
                  return { value: `${input.value}:${yield* value}` };
                });
            }),
          );
          const result = yield* Compute({ value: source.string });
          const host = yield* BindingTarget("Host", {});
          yield* host.bind("Compute", { env: { RESULT: result.value } });
          yield* TestResource("Other", {});
          return host.env.RESULT;
        });
        yield* stack.deploy(program, { include: ["Host"] });
        const host = yield* getState("Host");
        assert(host.attr !== undefined);
        expect(host.attr.env).toEqual({
          RESULT: "input:capture",
        });
        expect(yield* getState("Other")).toBeUndefined();
        yield* stack.deploy(program, { include: ["Host"] });
        expect(runs).toBe(1);
        expect(yield* stack.deploy(program)).toBe("input:capture");
        expect(runs).toBe(1);
        yield* stack.destroy();
      }),
  );

  test.provider(
    "preserves prior downstream edges owned by unselected resources and Actions",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const Compute = Action("Compute", (input: { value: string }) =>
          Effect.succeed({ value: input.value }),
        );
        yield* stack.deploy(
          Effect.gen(function* () {
            const a = yield* TestResource("A", {});
            const result = yield* Compute({ value: a.string });
            yield* TestResource("B", { string: result.value });
          }),
        );
        const b = yield* getState("B");
        const plan = yield* stack.plan(
          Effect.gen(function* () {
            const a = yield* TestResource("A", {});
            yield* Compute({ value: a.string });
          }),
          { include: ["Compute"] },
        );
        expect(plan.resources.A.downstream).toEqual(["Compute"]);
        expect(plan.actions.Compute.downstream).toEqual(["B"]);
        yield* apply(plan);
        expect((yield* getState("A")).downstream).toEqual(["Compute"]);
        expect((yield* getState("Compute")).downstream).toEqual(["B"]);
        expect(yield* getState("B")).toEqual(b);
        yield* stack.deploy(
          Effect.gen(function* () {
            const a = yield* TestResource("A", {});
            yield* TestResource("B", { string: a.string });
          }),
        );
        expect((yield* getState("A")).downstream).toEqual(["B"]);
        yield* stack.deploy(TestResource("A", {}), { include: ["A"] });
        expect((yield* getState("A")).downstream).toEqual(["B"]);
        const deleted: string[] = [];
        yield* stack.destroy().pipe(
          Effect.provideService(TestResourceHooks, {
            delete: (id) =>
              Effect.sync(() => {
                deleted.push(id);
              }),
          }),
        );
        expect(deleted).toEqual(["B", "A"]);
      }),
  );

  test.provider("does not switch unselected provider modes", (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = Effect.gen(function* () {
        yield* ModalResource("Worker", { value: "same" });
        yield* TestResource("Branch", {});
      });
      yield* stack.deploy(program);
      const worker = yield* getState("Worker");
      const before = modalCalls.filter(
        (call) => call.stack === stack.name,
      ).length;
      yield* inDev(stack.deploy(program, { include: ["Branch"] }));
      expect(yield* getState("Worker")).toEqual(worker);
      expect(
        modalCalls.filter((call) => call.stack === stack.name).length,
      ).toBe(before);
      yield* inDev(stack.deploy(program));
      expect((yield* getState("Worker")).providerMode).toBe("local");
      yield* stack.destroy();
    }),
  );

  test.provider(
    "rejects selected renames without moving persisted identities",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        yield* stack.deploy(TestResource("Old", {}));
        const old = yield* getState("Old");
        const exit = yield* stack
          .deploy(TestResource("New", {}).pipe(renamedFrom("Old")), {
            include: ["New"],
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain("UnsafeSelectionBoundary");
        expect(yield* getState("Old")).toEqual(old);
        expect(yield* getState("New")).toBeUndefined();
        yield* stack.destroy();
      }),
  );

  test.provider(
    "rejects replacement across an unselected dependent boundary, then permits a closed replacement",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (revision: string) =>
          Effect.gen(function* () {
            const a = yield* TestResource("A", { replaceString: revision });
            yield* TestResource("B", { string: a.string });
          });
        yield* stack.deploy(program("1"));
        const a = yield* getState("A");
        const b = yield* getState("B");
        const exit = yield* stack
          .deploy(program("2"), { include: ["A"] })
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain("UnsafeSelectionBoundary");
        expect(yield* getState("A")).toEqual(a);
        expect(yield* getState("B")).toEqual(b);
        yield* stack.deploy(program("2"), { include: ["B"] });
        expect((yield* getState("A")).instanceId).not.toBe(a.instanceId);
        yield* stack.destroy();
      }),
  );

  test.provider(
    "rejects replacement when removed historical binding-cycle edges cross the selection",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        yield* stack.deploy(
          Effect.gen(function* () {
            const a = yield* BindingTarget("A", { replaceString: "1" });
            const b = yield* BindingTarget("B", {});
            yield* a.bind("B", { env: { B: b.name } });
            yield* b.bind("A", { env: { A: a.name } });
          }),
        );
        const a = yield* getState("A");
        const b = yield* getState("B");
        expect(a.downstream).toEqual([]);
        expect(b.downstream).toEqual([]);
        const exit = yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* BindingTarget("A", { replaceString: "2" });
              yield* BindingTarget("B", {});
            }),
            { include: ["A"] },
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain(
            "Historical binding-cycle",
          );
        expect(yield* getState("A")).toEqual(a);
        expect(yield* getState("B")).toEqual(b);
        yield* stack.destroy();
      }),
  );

  test.provider(
    "rejects resuming selected GC when an old generation still has unselected dependents",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (revision: string) =>
          Effect.gen(function* () {
            const a = yield* TestResource("A", { replaceString: revision });
            yield* TestResource("B", { string: a.string });
          });
        yield* stack.deploy(program("1"));
        yield* stack.deploy(program("2")).pipe(
          Effect.provideService(TestResourceHooks, {
            delete: () => Effect.fail(new ResourceFailure()),
          }),
          Effect.exit,
        );
        const before = yield* getState("A");
        expect(before.status).toBe("replaced");
        const exit = yield* stack
          .deploy(TestResource("A", { replaceString: "2" }), { include: ["A"] })
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit))
          expect(Cause.pretty(exit.cause)).toContain("UnsafeSelectionBoundary");
        expect(yield* getState("A")).toEqual(before);
        yield* stack.deploy(program("2"));
        expectConvergedStatus((yield* getState("A")).status);
        yield* stack.destroy();
      }),
  );

  test.provider(
    "does not let an unselected rename claim a selected identity",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        yield* stack.deploy(TestResource("Old", { string: "original" }));
        const before = yield* getState("Old");
        const exit = yield* stack
          .deploy(
            Effect.gen(function* () {
              yield* TestResource("Old", { string: "reused" });
              yield* TestResource("New", {}).pipe(renamedFrom("Old"));
            }),
            { include: ["Old"] },
          )
          .pipe(Effect.exit);
        expect(Exit.isFailure(exit)).toBe(true);
        expect(yield* getState("Old")).toEqual(before);
        expect(yield* getState("New")).toBeUndefined();
        yield* stack.destroy();
      }),
  );

  test.provider(
    "does not collect unselected interrupted replacement generations",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (revision: string) =>
          Effect.gen(function* () {
            yield* TestResource("Old", { replaceString: revision });
            yield* TestResource("Branch", {});
          });
        yield* stack.deploy(program("1"));
        const interrupted = yield* stack.deploy(program("2")).pipe(
          Effect.provideService(TestResourceHooks, {
            delete: () => Effect.fail(new ResourceFailure()),
          }),
          Effect.exit,
        );
        expect(Exit.isFailure(interrupted)).toBe(true);
        const before = yield* getState("Old");
        expect(before.status).toBe("replaced");
        yield* stack
          .deploy(TestResource("Branch", {}), { include: ["Branch"] })
          .pipe(
            Effect.provideService(TestResourceHooks, {
              delete: () => Effect.die("unselected GC"),
            }),
          );
        expect(yield* getState("Old")).toEqual(before);
        yield* stack.deploy(program("2"));
        expectConvergedStatus((yield* getState("Old")).status);
        yield* stack.destroy();
      }),
  );
});

describe("filtered audit safeguards", { tags: ["unit", "local"] }, () => {
  test.provider(
    "rejects an unpersisted keeper before its first checkpoint can fail",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (clear: boolean, revision = "1") =>
          Effect.gen(function* () {
            const a = yield* BindingTarget("A", {
              string: `generation-${revision}`,
              replaceString: revision,
            });
            const middle = yield* BindingTarget("Middle", {});
            if (!clear) {
              yield* a.bind("Middle", { env: { MIDDLE: middle.name } });
              yield* middle.bind("A", { env: { SOURCE: a.string } });
            } else {
              const keeper = yield* BindingTarget("Keeper", {});
              yield* keeper.bind("constant", {
                env: { VALUE: "new evidence" },
              });
            }
            yield* TestResource("B", {
              string: clear
                ? "detached"
                : middle.env.pipe(Output.map((env) => env.SOURCE)),
            });
          });
        yield* stack.deploy(program(false));
        const rows = Effect.all([
          getState("A"),
          getState("Middle"),
          getState("B"),
        ]);
        const before = yield* rows;
        const bytes = yield* Effect.sync(() => JSON.stringify(before));
        const state = yield* yield* State;
        const writes: string[] = [];
        const calls: string[] = [];
        const track = (id: string) =>
          Effect.sync(() => {
            calls.push(id);
          });
        const result = yield* Effect.gen(function* () {
          const plan = yield* stack.plan(program(true), {
            include: ["A", "Middle", "Keeper"],
          });
          yield* apply(plan);
        }).pipe(
          Effect.provideService(
            State,
            Effect.succeed({
              ...state,
              set: (request) =>
                Effect.sync(() => {
                  writes.push(request.fqn);
                }).pipe(
                  Effect.andThen(() =>
                    request.fqn === "Keeper"
                      ? Effect.fail(
                          new StateStoreError({
                            message: "First Keeper checkpoint failed",
                          }),
                        )
                      : state.set(request),
                  ),
                ),
            }),
          ),
          Effect.provideService(TestResourceHooks, {
            create: track,
            update: track,
            delete: track,
          }),
          Effect.exit,
        );
        assert(Exit.isFailure(result));
        expect(Cause.pretty(result.cause)).toContain(
          "last historical binding evidence",
        );
        expect(writes).toEqual([]);
        expect(calls).toEqual([]);
        const after = yield* rows;
        expect(after).toEqual(before);
        expect(yield* Effect.sync(() => JSON.stringify(after))).toBe(bytes);
        expect(yield* getState("Keeper")).toBeUndefined();
        const replacement = yield* stack
          .deploy(program(true, "2"), { include: ["A"] })
          .pipe(
            Effect.provideService(TestResourceHooks, {
              create: track,
              update: track,
              delete: track,
            }),
            Effect.exit,
          );
        assert(Exit.isFailure(replacement));
        expect(calls).toEqual([]);
        expect(yield* rows).toEqual(before);
        yield* stack.deploy(program(true), {
          include: ["A", "Middle", "Keeper", "B"],
        });
        expect((yield* getState("B")).attr?.string).toBe("detached");
        yield* stack.destroy();
      }),
  );

  for (const operation of ["force", "update", "action noop"] as const) {
    test.provider(
      `preserves incomplete metadata before partial ${operation} and replacement`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          let runs = 0;
          const Compute = Action("Middle", (input: { value: string }) =>
            Effect.sync(() => {
              runs++;
              return { value: input.value };
            }),
          );
          const program = (
            detached: boolean,
            revision = "1",
            value = "generation-1",
          ) =>
            Effect.gen(function* () {
              const a = yield* TestResource("A", {
                string: value,
                replaceString: revision,
              });
              if (operation === "action noop") {
                const middle = yield* Compute({
                  value: detached ? "generation-1" : a.string,
                });
                if (detached)
                  yield* TestResource("C", { string: middle.value });
                yield* TestResource("B", {
                  string: detached ? "detached" : middle.value,
                });
              } else
                yield* TestResource("B", {
                  string: detached ? "detached" : a.string,
                });
            });
          yield* stack.deploy(program(false));
          const state = yield* yield* State;
          const incomplete = operation === "action noop" ? "Middle" : "A";
          const key = {
            stack: stack.name,
            stage: stack.stage,
            fqn: incomplete,
          };
          const row = yield* state.get(key);
          assert(row !== undefined);
          const legacy = { ...row };
          yield* Effect.sync(() =>
            Reflect.deleteProperty(legacy, "downstream"),
          );
          yield* state.set({ ...key, value: legacy });
          const ids =
            operation === "action noop" ? ["A", "Middle", "B"] : ["A", "B"];
          const rows = Effect.all(
            ids.map((id) => state.get({ ...key, fqn: id })),
          );
          const before = yield* rows;
          const bytes = yield* Effect.sync(() => JSON.stringify(before));
          const runsBefore = runs;
          const calls: string[] = [];
          const track = (id: string) =>
            Effect.sync(() => {
              calls.push(id);
            });
          const desired = program(
            true,
            "1",
            operation === "update" ? "updated" : "generation-1",
          );
          const include =
            operation === "action noop" ? ["A", "Middle", "C"] : ["A"];
          const result = yield* stack
            .deploy(desired, { include, force: operation === "force" })
            .pipe(
              Effect.provideService(TestResourceHooks, {
                create: track,
                update: track,
                delete: track,
              }),
              Effect.exit,
            );
          assert(Exit.isFailure(result));
          expect(Cause.pretty(result.cause)).toContain(
            "incomplete historical downstream metadata",
          );
          expect(calls).toEqual([]);
          expect(runs).toBe(runsBefore);
          const after = yield* rows;
          expect(after).toEqual(before);
          expect(yield* Effect.sync(() => JSON.stringify(after))).toBe(bytes);
          expect(yield* getState("C")).toBeUndefined();
          const replacement = yield* stack
            .deploy(program(true, "2", "generation-2"), { include: ["A"] })
            .pipe(
              Effect.provideService(TestResourceHooks, {
                create: track,
                update: track,
                delete: track,
              }),
              Effect.exit,
            );
          assert(Exit.isFailure(replacement));
          expect(calls).toEqual([]);
          expect(yield* rows).toEqual(before);
          yield* stack.deploy(desired, { force: true });
          expect((yield* getState("B")).attr?.string).toBe("detached");
          yield* stack.deploy(program(true, "2", "generation-2"), {
            include: ["A"],
          });
          expect((yield* getState("A")).attr?.string).toBe("generation-2");
          yield* stack.destroy();
        }),
    );
  }

  test.provider(
    "retains last binding evidence in interrupted cleanup snapshots",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (bound: boolean) =>
          Effect.gen(function* () {
            const a = yield* BindingTarget("A", { string: "generation-1" });
            const middle = yield* BindingTarget("Middle", {});
            if (bound) {
              yield* a.bind("Middle", { env: { Middle: middle.name } });
              yield* middle.bind("A", { env: { A: a.string } });
            }
            yield* TestResource("B", {
              string: bound
                ? middle.env.pipe(Output.map((env) => env.A))
                : "detached",
            });
          });
        yield* stack.deploy(program(true));
        const interrupted = yield* stack.deploy(program(false)).pipe(
          Effect.provideService(TestResourceHooks, {
            update: () => Effect.fail(new ResourceFailure()),
          }),
          Effect.exit,
        );
        assert(Exit.isFailure(interrupted));
        const rows = Effect.all([
          getState("A"),
          getState("Middle"),
          getState("B"),
        ]);
        const before = yield* rows;
        for (const id of ["A", "Middle"]) {
          const row = yield* getState(id);
          assert(row.status === "updating");
          expect(row.bindings).toEqual([]);
          expect(row.old.bindings.length).toBeGreaterThan(0);
        }
        const calls: string[] = [];
        const track = (id: string) =>
          Effect.sync(() => {
            calls.push(id);
          });
        const recovery = yield* stack
          .deploy(program(false), { include: ["A", "Middle"] })
          .pipe(
            Effect.provideService(TestResourceHooks, {
              create: track,
              update: track,
              delete: track,
            }),
            Effect.exit,
          );
        assert(Exit.isFailure(recovery));
        expect(Cause.pretty(recovery.cause)).toContain(
          "last historical binding evidence",
        );
        expect(calls).toEqual([]);
        expect(yield* rows).toEqual(before);
        yield* stack.deploy(program(false));
        for (const row of yield* rows) {
          expect(row.bindings).toEqual([]);
          expect(row).not.toHaveProperty("old");
        }
        expect((yield* getState("B")).attr?.string).toBe("detached");
        yield* stack.destroy();
      }),
  );

  test.provider(
    "allows partial binding cleanup when a selected noop retains evidence",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (bound: boolean) =>
          Effect.gen(function* () {
            const a = yield* BindingTarget("A", {});
            const keeper = yield* BindingTarget("Keeper", {});
            if (bound) yield* a.bind("value", { env: { VALUE: "a" } });
            yield* keeper.bind("value", { env: { VALUE: "keeper" } });
            yield* TestResource("B", {});
          });
        yield* stack.deploy(program(true));
        const b = yield* getState("B");
        const keeper = yield* getState("Keeper");
        const plan = yield* stack.plan(program(false), {
          include: ["A", "Keeper"],
        });
        expect(plan.resources.Keeper.action).toBe("noop");
        yield* apply(plan);
        expect((yield* getState("A")).bindings).toEqual([]);
        expect(yield* getState("Keeper")).toEqual(keeper);
        expect(yield* getState("B")).toEqual(b);
        yield* stack.destroy();
      }),
  );

  for (const initialCycle of [false, true]) {
    for (const consumer of ["Resource", "Action"] as const) {
      for (const completion of [
        "selected closure",
        "full deployment",
      ] as const) {
        test.provider(
          `preserves last binding evidence for ${consumer} through ${completion} (initialCycle=${initialCycle})`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              let runs = 0;
              const Consume = Action("B", (input: { value: string }) =>
                Effect.sync(() => {
                  runs++;
                  return input.value;
                }),
              );
              const program = (
                mode: "acyclic" | "cycle" | "clear",
                revision = "1",
              ) =>
                Effect.gen(function* () {
                  const a = yield* BindingTarget("A", {
                    string: `generation-${revision}`,
                    replaceString: revision,
                  });
                  const middle = yield* BindingTarget("Middle", {});
                  if (mode !== "clear")
                    yield* middle.bind("A", { env: { A: a.string } });
                  if (mode === "cycle")
                    yield* a.bind("Middle", { env: { Middle: middle.name } });
                  const value =
                    mode === "clear"
                      ? "detached"
                      : middle.env.pipe(Output.map((env) => env.A));
                  if (consumer === "Action") yield* Consume({ value });
                  else yield* TestResource("B", { string: value });
                });
              const consumerValue = Effect.gen(function* () {
                const row = yield* getState<ResourceState | ActionState>("B");
                if (row.kind === "action") {
                  assert(row.status === "ran");
                  return row.output;
                }
                return row.attr?.string;
              });
              yield* stack.deploy(program(initialCycle ? "cycle" : "acyclic"));
              expect(yield* consumerValue).toBe("generation-1");
              const b = yield* getState<ResourceState | ActionState>("B");
              if (!initialCycle) {
                expect((yield* getState("A")).downstream).toEqual(["Middle"]);
                yield* stack.deploy(program("cycle"), {
                  include: ["A", "Middle"],
                });
              }
              expect((yield* getState("A")).downstream).toEqual([]);
              expect(yield* getState<ResourceState | ActionState>("B")).toEqual(
                b,
              );
              const rows = Effect.all([
                getState("A"),
                getState("Middle"),
                getState<ResourceState | ActionState>("B"),
              ]);
              const before = yield* rows;
              const bytes = yield* Effect.sync(() => JSON.stringify(before));
              expect((yield* getState("A")).bindings.length).toBeGreaterThan(0);
              expect(
                (yield* getState("Middle")).bindings.length,
              ).toBeGreaterThan(0);
              const runsBefore = runs;
              const calls: string[] = [];
              const track = (id: string) =>
                Effect.sync(() => {
                  calls.push(id);
                });
              const exit = yield* stack
                .deploy(program("clear"), { include: ["A", "Middle"] })
                .pipe(
                  Effect.provideService(TestResourceHooks, {
                    create: track,
                    update: track,
                    delete: track,
                  }),
                  Effect.exit,
                );
              assert(Exit.isFailure(exit));
              expect(Cause.pretty(exit.cause)).toContain(
                "last historical binding evidence",
              );
              expect(Cause.pretty(exit.cause)).toContain("unselected: B");
              expect(Cause.pretty(exit.cause)).toContain(
                "Select them or run a full deployment",
              );
              expect(calls).toEqual([]);
              expect(runs).toBe(runsBefore);
              const after = yield* rows;
              expect(after).toEqual(before);
              expect(yield* Effect.sync(() => JSON.stringify(after))).toBe(
                bytes,
              );
              const replacement = yield* stack
                .deploy(program("clear", "2"), { include: ["A"] })
                .pipe(
                  Effect.provideService(TestResourceHooks, {
                    create: track,
                    update: track,
                    delete: track,
                  }),
                  Effect.exit,
                );
              assert(Exit.isFailure(replacement));
              expect(Cause.pretty(replacement.cause)).toContain(
                "Historical binding-cycle",
              );
              expect(calls).toEqual([]);
              expect(runs).toBe(runsBefore);
              expect(yield* rows).toEqual(before);
              if (consumer === "Action") {
                const actionBoundary = yield* stack
                  .deploy(program("clear", "2"), {
                    include: ["A", "Middle"],
                  })
                  .pipe(
                    Effect.provideService(TestResourceHooks, {
                      create: track,
                      update: track,
                      delete: track,
                    }),
                    Effect.exit,
                  );
                assert(Exit.isFailure(actionBoundary));
                expect(Cause.pretty(actionBoundary.cause)).toContain(
                  "'B' is unselected",
                );
                expect(Cause.pretty(actionBoundary.cause)).toContain(
                  "Historical binding-cycle",
                );
                expect(calls).toEqual([]);
                expect(runs).toBe(runsBefore);
                expect(yield* rows).toEqual(before);
              }
              if (completion === "selected closure")
                yield* stack.deploy(program("clear"), {
                  include: ["A", "Middle", "B"],
                });
              else yield* stack.deploy(program("clear"));
              expect((yield* getState("A")).bindings).toEqual([]);
              expect((yield* getState("Middle")).bindings).toEqual([]);
              expect(yield* consumerValue).toBe("detached");
              const clearedB = yield* getState<ResourceState | ActionState>(
                "B",
              );
              const a = yield* getState("A");
              yield* stack.deploy(program("clear", "2"), { include: ["A"] });
              expect((yield* getState("A")).instanceId).not.toBe(a.instanceId);
              expect(yield* getState<ResourceState | ActionState>("B")).toEqual(
                clearedB,
              );
              yield* stack.destroy();
            }),
        );
      }
    }
  }

  for (const intermediate of ["Action", "Resource"] as const) {
    for (const completion of ["selected closure", "full deployment"] as const) {
      for (const historical of [false, true]) {
        test.provider(
          `refuses selected ${intermediate} detachment before ${completion} (historical=${historical})`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              let runs = 0;
              const Compute = Action("Middle", (input: { value: string }) =>
                Effect.sync(() => {
                  runs++;
                  return input;
                }),
              );
              const program = (
                revision: string,
                detached: boolean,
                updating = false,
              ) =>
                Effect.gen(function* () {
                  const a = yield* TestResource("A", {
                    string: updating ? "updated" : `generation-${revision}`,
                    replaceString: revision,
                  });
                  const input = detached ? "detached" : a.string;
                  const middle =
                    intermediate === "Action"
                      ? (yield* Compute({ value: input })).value
                      : (yield* TestResource("Middle", { string: input }))
                          .string;
                  const value = historical
                    ? (yield* TestResource("Bridge", {
                        string:
                          updating && intermediate === "Resource"
                            ? "detached"
                            : middle,
                      })).string
                    : middle;
                  yield* TestResource("B", {
                    string: historical && detached ? "detached" : value,
                  });
                });
              yield* stack.deploy(program("1", false));
              if (historical) {
                const failed = yield* stack
                  .deploy(program("1", true, true))
                  .pipe(
                    Effect.provideService(TestResourceHooks, {
                      update: () => Effect.fail(new ResourceFailure()),
                    }),
                    Effect.exit,
                  );
                assert(Exit.isFailure(failed));
                const a = yield* getState("A");
                const bridge = yield* getState("Bridge");
                assert(a.status === "updating");
                assert(bridge.status === "updating");
                expect(a.downstream).toEqual([]);
                expect(a.old).toMatchObject({ downstream: ["Middle"] });
                expect(bridge.downstream).toEqual([]);
                expect(bridge.old).toMatchObject({ downstream: ["B"] });
              }
              const ids = historical
                ? ["A", "Middle", "Bridge", "B"]
                : ["A", "Middle", "B"];
              const rows = Effect.all(ids.map((id) => getState(id)));
              const before = yield* rows;
              const beforeBytes = yield* Effect.sync(() =>
                JSON.stringify(before),
              );
              const runsBefore = runs;
              const calls: string[] = [];
              const track = (id: string) =>
                Effect.sync(() => {
                  calls.push(id);
                });
              const include = ids.filter((id) => id !== "B");
              const exit = yield* stack
                .deploy(program("1", true, historical), { include })
                .pipe(
                  Effect.provideService(TestResourceHooks, {
                    create: track,
                    update: track,
                    delete: track,
                  }),
                  Effect.exit,
                );
              assert(Exit.isFailure(exit));
              expect(Cause.pretty(exit.cause)).toContain(
                "Cannot detach 'A' from 'Middle'",
              );
              expect(Cause.pretty(exit.cause)).toContain("unselected: B");
              expect(Cause.pretty(exit.cause)).toContain(
                "Select them or run a full deployment",
              );
              expect(calls).toEqual([]);
              expect(runs).toBe(runsBefore);
              const after = yield* rows;
              expect(after).toEqual(before);
              expect(yield* Effect.sync(() => JSON.stringify(after))).toBe(
                beforeBytes,
              );
              const complete = program("1", true, historical);
              if (completion === "selected closure")
                yield* stack.deploy(complete, { include: ids });
              else yield* stack.deploy(complete);
              expect((yield* getState("A")).downstream).toEqual([]);
              expect((yield* getState("B")).attr?.string).toBe("detached");
              const b = yield* getState("B");
              const a = yield* getState("A");
              yield* stack.deploy(program("2", true, historical), {
                include: ["A"],
              });
              expect((yield* getState("A")).instanceId).not.toBe(a.instanceId);
              expect(yield* getState("B")).toEqual(b);
              yield* stack.destroy();
            }),
        );
      }
    }
  }

  test.provider(
    "does not confuse binding SCC filtering with selected detachment",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (cycle: boolean) =>
          Effect.gen(function* () {
            const a = yield* BindingTarget("A", {});
            const middle = yield* BindingTarget("Middle", {});
            yield* middle.bind("A", { env: { A: a.name } });
            if (cycle)
              yield* a.bind("Middle", { env: { Middle: middle.name } });
            yield* TestResource("B", { string: middle.name });
          });
        yield* stack.deploy(program(false));
        expect((yield* getState("A")).downstream).toEqual(["Middle"]);
        const b = yield* getState("B");
        yield* stack.deploy(program(true), { include: ["A", "Middle"] });
        expect((yield* getState("A")).downstream).toEqual([]);
        expect(yield* getState("B")).toEqual(b);
        yield* stack.destroy();
      }),
  );

  test.provider(
    "preserves historical excluded edges through partial cycle convergence",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (revision: string, attached: boolean) =>
          Effect.gen(function* () {
            const a = yield* BindingTarget("A", { string: `${revision}-a` });
            const c = yield* BindingTarget("C", { string: `${revision}-c` });
            yield* a.bind("C", { env: { C: c.string } });
            yield* c.bind("A", { env: { A: a.string } });
            yield* TestResource("B", {
              string: attached ? a.string : "detached",
            });
          });
        yield* stack.deploy(program("1", true));
        const failed = yield* stack.deploy(program("2", false)).pipe(
          Effect.provideService(TestResourceHooks, {
            update: () => Effect.fail(new ResourceFailure()),
          }),
          Effect.exit,
        );
        assert(Exit.isFailure(failed));
        const interruptedA = yield* getState("A");
        const b = yield* getState("B");
        assert(interruptedA.status === "updating");
        expect(interruptedA.downstream).toEqual([]);
        expect(interruptedA.old).toMatchObject({ downstream: ["B"] });
        const started = new Set<string>();
        const updates: string[] = [];
        const ready = yield* Deferred.make<void>();
        yield* stack.deploy(program("2", false), { include: ["A"] }).pipe(
          Effect.provideService(TestResourceHooks, {
            update: (id) =>
              Effect.gen(function* () {
                const count = yield* Effect.sync(() => {
                  updates.push(id);
                  started.add(id);
                  return started.size;
                });
                // Both cycle members reconcile stale bindings before convergence.
                if (count === 2) yield* Deferred.succeed(ready, undefined);
                else yield* Deferred.await(ready);
              }),
          }),
        );
        expect(updates.filter((id) => id === "A").length).toBeGreaterThan(1);
        const a = yield* getState("A");
        expectConvergedStatus(a.status);
        expect(a).not.toHaveProperty("old");
        expect(a.downstream).toEqual(["B"]);
        expect(a.attr?.env).toEqual({ C: "2-c" });
        expect(yield* getState("B")).toEqual(b);
        yield* stack.destroy();
      }),
    { timeout: 10_000 },
  );

  for (const declaredConsumer of [true, false]) {
    test.provider(
      `preserves historical excluded edges through partial update recovery (declared=${declaredConsumer})`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const program = (
            value: string,
            replacement: string,
            attached: boolean,
            consumer = true,
          ) =>
            Effect.gen(function* () {
              const a = yield* TestResource("A", {
                string: value,
                replaceString: replacement,
              });
              if (consumer)
                yield* TestResource("B", {
                  string: attached ? a.string : "detached",
                });
            });
          yield* stack.deploy(program("original", "1", true));
          const failed = yield* stack
            .deploy(program("recovered", "1", false))
            .pipe(
              Effect.provideService(TestResourceHooks, {
                update: () => Effect.fail(new ResourceFailure()),
              }),
              Effect.exit,
            );
          assert(Exit.isFailure(failed));
          const interruptedA = yield* getState("A");
          const b = yield* getState("B");
          assert(interruptedA.status === "updating");
          assert(b.status === "updating");
          expect(interruptedA.downstream).toEqual([]);
          expect(interruptedA.old).toMatchObject({ downstream: ["B"] });
          expect(b.attr?.string).toBe("original");
          const recovery = program("recovered", "1", false, declaredConsumer);
          const plan = yield* stack.plan(recovery, { include: ["A"] });
          expect(plan.resources.A.action).toBe("update");
          yield* apply(plan);
          const recovered = yield* getState("A");
          expectConvergedStatus(recovered.status);
          expect(recovered).not.toHaveProperty("old");
          expect(recovered.downstream).toEqual(["B"]);
          expect(yield* getState("B")).toEqual(b);
          const noop = yield* stack.plan(recovery, { include: ["A"] });
          expect(noop.resources.A.action).toBe("noop");
          yield* apply(noop);
          expect((yield* getState("A")).downstream).toEqual(["B"]);
          expect(yield* getState("B")).toEqual(b);
          yield* stack.deploy(
            program("updated again", "1", false, declaredConsumer),
            { include: ["A"] },
          );
          const before = yield* getState("A");
          expect(before.downstream).toEqual(["B"]);
          expect(yield* getState("B")).toEqual(b);
          const calls: string[] = [];
          const track = (id: string) =>
            Effect.sync(() => {
              calls.push(id);
            });
          const exit = yield* stack
            .deploy(program("updated again", "2", false, declaredConsumer), {
              include: ["A"],
            })
            .pipe(
              Effect.provideService(TestResourceHooks, {
                create: track,
                update: track,
                delete: track,
              }),
              Effect.exit,
            );
          assert(Exit.isFailure(exit));
          expect(Cause.pretty(exit.cause)).toContain(
            "dependents are unselected: B",
          );
          expect(calls).toEqual([]);
          expect(yield* getState("A")).toEqual(before);
          expect(yield* getState("B")).toEqual(b);
          yield* stack.deploy(program("updated again", "1", false));
          expect((yield* getState("A")).downstream).toEqual([]);
          expectConvergedStatus((yield* getState("B")).status);
          yield* stack.destroy();
        }),
    );
  }

  for (const status of ["updating", "replacing", "replaced"] as const) {
    test.provider(
      `traverses intermediate ${status}.old downstream edges`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const program = (aRevision: string, changed: boolean) =>
            Effect.gen(function* () {
              const a = yield* TestResource("A", { replaceString: aRevision });
              const middle = yield* TestResource("Middle", {
                string: a.string,
                stringArray: [changed ? "2" : "1"],
                replaceString: changed && status !== "updating" ? "2" : "1",
              });
              yield* TestResource("B", {
                string: changed ? "detached" : middle.string,
              });
            });
          yield* stack.deploy(program("1", false));
          const failed = yield* stack
            .deploy(program("1", true))
            .pipe(
              Effect.provideService(
                TestResourceHooks,
                failOn(
                  "Middle",
                  status === "updating"
                    ? "update"
                    : status === "replacing"
                      ? "create"
                      : "delete",
                ),
              ),
              Effect.exit,
            );
          assert(Exit.isFailure(failed));
          const before = yield* Effect.all([
            getState("A"),
            getState("Middle"),
            getState("B"),
          ]);
          const middle = before[1];
          assert(
            middle.status === "updating" ||
              middle.status === "replacing" ||
              middle.status === "replaced",
          );
          expect(middle.status).toBe(status);
          expect(middle.downstream).toEqual([]);
          expect(middle.old).toMatchObject({ downstream: ["B"] });
          const calls: string[] = [];
          const track = (id: string) =>
            Effect.sync(() => {
              calls.push(id);
            });
          const exit = yield* stack
            .deploy(program("2", true), { include: ["Middle"] })
            .pipe(
              Effect.provideService(TestResourceHooks, {
                create: track,
                update: track,
                delete: track,
              }),
              Effect.exit,
            );
          assert(Exit.isFailure(exit));
          expect(Cause.pretty(exit.cause)).toContain(
            "dependents are unselected: B",
          );
          expect(calls).toEqual([]);
          expect(
            yield* Effect.all([
              getState("A"),
              getState("Middle"),
              getState("B"),
            ]),
          ).toEqual(before);
          yield* stack.destroy();
        }),
    );
  }

  test.provider(
    "refuses ambiguous mixed binding-cycle GC resumption",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = (revision: string, bound: boolean) =>
          Effect.gen(function* () {
            const b = yield* BindingTarget("B", {});
            const a = yield* BindingTarget("A", {
              replaceString: revision,
              string: bound ? b.name : undefined,
            });
            if (bound) yield* b.bind("A", { env: { A: a.name } });
          });
        yield* stack.deploy(program("1", true));
        const failed = yield* stack.deploy(program("2", true)).pipe(
          Effect.provideService(TestResourceHooks, {
            delete: () => Effect.fail(new ResourceFailure()),
          }),
          Effect.exit,
        );
        assert(Exit.isFailure(failed));
        const before = yield* Effect.all([getState("A"), getState("B")]);
        const a = before[0];
        assert(a.status === "replaced");
        expect(a.bindings).toEqual([]);
        expect(a.old.bindings).toEqual([]);
        expect(a.downstream).toEqual([]);
        expect(a.old.downstream).toEqual([]);
        const calls: string[] = [];
        const track = (id: string) =>
          Effect.sync(() => {
            calls.push(id);
          });
        const exit = yield* stack
          .deploy(program("2", false), { include: ["A"] })
          .pipe(
            Effect.provideService(TestResourceHooks, {
              create: track,
              update: track,
              delete: track,
            }),
            Effect.exit,
          );
        assert(Exit.isFailure(exit));
        expect(Cause.pretty(exit.cause)).toContain("Historical binding-cycle");
        expect(calls).toEqual([]);
        expect(yield* Effect.all([getState("A"), getState("B")])).toEqual(
          before,
        );
        yield* stack.destroy();
      }),
  );

  for (const intermediate of ["Action", "Resource"] as const) {
    for (const declaredConsumer of [true, false]) {
      for (const resume of [false, true]) {
        test.provider(
          `refuses transitive ${intermediate} boundary (declared=${declaredConsumer}, resume=${resume})`,
          (stack) =>
            Effect.gen(function* () {
              yield* stack.destroy();
              let runs = 0;
              const Compute = Action("Middle", (input: { value: string }) =>
                Effect.sync(() => {
                  runs++;
                  return input;
                }),
              );
              const program = (revision: string, consumer = true) =>
                Effect.gen(function* () {
                  const a = yield* TestResource("A", {
                    string: revision,
                    replaceString: revision,
                  });
                  const value =
                    intermediate === "Action"
                      ? (yield* Compute({ value: a.string })).value
                      : (yield* TestResource("Middle", { string: a.string }))
                          .string;
                  if (consumer) yield* TestResource("B", { string: value });
                });
              yield* stack.deploy(program("1"));
              if (resume) {
                const interrupted = yield* stack.deploy(program("2")).pipe(
                  Effect.provideService(TestResourceHooks, {
                    delete: () => Effect.fail(new ResourceFailure()),
                  }),
                  Effect.exit,
                );
                assert(Exit.isFailure(interrupted));
                expect((yield* getState("A")).status).toBe("replaced");
              }
              const before = yield* Effect.all([
                getState("A"),
                getState("Middle"),
                getState("B"),
              ]);
              const runsBefore = runs;
              const calls: string[] = [];
              const track = (id: string) =>
                Effect.sync(() => {
                  calls.push(id);
                });
              const exit = yield* stack
                .deploy(program("2", declaredConsumer), {
                  include: ["Middle"],
                })
                .pipe(
                  Effect.provideService(TestResourceHooks, {
                    create: track,
                    update: track,
                    delete: track,
                  }),
                  Effect.exit,
                );
              assert(Exit.isFailure(exit));
              expect(Cause.pretty(exit.cause)).toContain(
                "UnsafeSelectionBoundary",
              );
              expect(Cause.pretty(exit.cause)).toContain("B");
              expect(calls).toEqual([]);
              expect(runs).toBe(runsBefore);
              expect(
                yield* Effect.all([
                  getState("A"),
                  getState("Middle"),
                  getState("B"),
                ]),
              ).toEqual(before);
              yield* stack.destroy();
            }),
        );
      }
    }
  }

  for (const history of [
    "partial removal",
    "selected updating",
    "unselected updating",
    "unselected replacing",
    "unselected replaced",
    "mixed cycle",
  ] as const) {
    test.provider(
      `refuses ambiguous historical bindings after ${history}`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const program = (bound: boolean, aRevision = "1", bRevision = "1") =>
            Effect.gen(function* () {
              const b = yield* BindingTarget("B", { replaceString: bRevision });
              const a = yield* BindingTarget("A", {
                replaceString: aRevision,
                string: bound && history === "mixed cycle" ? b.name : undefined,
              });
              if (bound) {
                if (history !== "mixed cycle")
                  yield* a.bind("B", { env: { B: b.name } });
                yield* b.bind("A", { env: { A: a.name } });
              }
            });
          yield* stack.deploy(program(true));
          if (history === "selected updating") {
            yield* stack.deploy(program(false), { include: ["B"] });
            const failed = yield* stack.deploy(program(false)).pipe(
              Effect.provideService(TestResourceHooks, {
                update: () => Effect.fail(new ResourceFailure()),
              }),
              Effect.exit,
            );
            assert(Exit.isFailure(failed));
            const a = yield* getState("A");
            assert(a.status === "updating");
            expect(a.bindings).toEqual([]);
            expect(a.old.bindings.length).toBeGreaterThan(0);
            expect((yield* getState("B")).bindings).toEqual([]);
          } else if (history !== "mixed cycle") {
            yield* stack.deploy(program(false), { include: ["A"] });
            expect((yield* getState("A")).bindings).toEqual([]);
            if (history === "unselected updating") {
              const failed = yield* stack.deploy(program(false)).pipe(
                Effect.provideService(TestResourceHooks, {
                  update: () => Effect.fail(new ResourceFailure()),
                }),
                Effect.exit,
              );
              assert(Exit.isFailure(failed));
              const b = yield* getState("B");
              assert(b.status === "updating");
              expect(b.bindings).toEqual([]);
              expect(b.old.bindings.length).toBeGreaterThan(0);
            } else if (
              history === "unselected replacing" ||
              history === "unselected replaced"
            ) {
              const failed = yield* stack
                .deploy(program(false, "1", "2"))
                .pipe(
                  Effect.provideService(
                    TestResourceHooks,
                    history === "unselected replacing"
                      ? { create: () => Effect.fail(new ResourceFailure()) }
                      : { delete: () => Effect.fail(new ResourceFailure()) },
                  ),
                  Effect.exit,
                );
              assert(Exit.isFailure(failed));
              const b = yield* getState("B");
              assert(b.status === "replacing" || b.status === "replaced");
              expect(b.status).toBe(
                history === "unselected replacing" ? "replacing" : "replaced",
              );
              expect(b.bindings).toEqual([]);
              expect(b.old.bindings.length).toBeGreaterThan(0);
            }
          }
          const before = yield* Effect.all([getState("A"), getState("B")]);
          expect(before[0].bindings).toEqual([]);
          const calls: string[] = [];
          const track = (id: string) =>
            Effect.sync(() => {
              calls.push(id);
            });
          const exit = yield* stack
            .deploy(program(false, "2"), { include: ["A"] })
            .pipe(
              Effect.provideService(TestResourceHooks, {
                create: track,
                update: track,
                delete: track,
              }),
              Effect.exit,
            );
          assert(Exit.isFailure(exit));
          expect(Cause.pretty(exit.cause)).toContain(
            "Historical binding-cycle",
          );
          expect(calls).toEqual([]);
          expect(yield* Effect.all([getState("A"), getState("B")])).toEqual(
            before,
          );
          yield* stack.destroy();
        }),
    );
  }

  for (const replacement of [false, true]) {
    test.provider(
      `refuses Action collision with persisted resource (replacement=${replacement})`,
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          yield* stack.deploy(TestResource("X", { replaceString: "1" }));
          if (replacement) {
            const failed = yield* stack
              .deploy(TestResource("X", { replaceString: "2" }))
              .pipe(
                Effect.provideService(TestResourceHooks, {
                  delete: () => Effect.fail(new ResourceFailure()),
                }),
                Effect.exit,
              );
            assert(Exit.isFailure(failed));
            expect((yield* getState("X")).status).toBe("replaced");
          }
          const before = yield* getState("X");
          let runs = 0;
          const Compute = Action("X", (_: {}) =>
            Effect.sync(() => {
              runs++;
            }),
          );
          const calls: string[] = [];
          const track = (id: string) =>
            Effect.sync(() => {
              calls.push(id);
            });
          const exit = yield* stack
            .deploy(Compute({}), { include: ["X"] })
            .pipe(
              Effect.provideService(TestResourceHooks, {
                create: track,
                update: track,
                delete: track,
              }),
              Effect.exit,
            );
          assert(Exit.isFailure(exit));
          expect(Cause.pretty(exit.cause)).toContain("UnsafeSelectionBoundary");
          expect(Cause.pretty(exit.cause)).toContain("persisted resource");
          expect(runs).toBe(0);
          expect(calls).toEqual([]);
          expect(yield* getState("X")).toEqual(before);
          yield* stack.destroy();
        }),
    );
  }

  test.provider(
    "refuses filtered mode switch after interrupted live destruction",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        const program = ModalResource("Worker", { value: "live" });
        yield* stack.deploy(program);
        const failed = yield* stack.destroy().pipe(
          Effect.provideService(TestResourceHooks, {
            delete: () => Effect.fail(new ResourceFailure()),
          }),
          Effect.exit,
        );
        assert(Exit.isFailure(failed));
        const before = yield* getState("Worker");
        expect(before.status).toBe("deleting");
        expect(before.providerMode).toBe("live");
        const callsBefore = modalCalls.filter(
          (call) => call.stack === stack.name,
        );
        const exit = yield* inDev(
          stack.deploy(program, { include: ["Worker"] }),
        ).pipe(Effect.exit);
        assert(Exit.isFailure(exit));
        expect(Cause.pretty(exit.cause)).toContain("UnsafeSelectionBoundary");
        expect(Cause.pretty(exit.cause)).toContain("recorded 'live' mode");
        expect(yield* getState("Worker")).toEqual(before);
        expect(modalCalls.filter((call) => call.stack === stack.name)).toEqual(
          callsBefore,
        );
        yield* inDev(stack.destroy());
        expect(
          modalCalls
            .filter((call) => call.stack === stack.name)
            .slice(callsBefore.length),
        ).toEqual([
          { stack: stack.name, mode: "live", op: "delete", id: "Worker" },
        ]);
        expect(yield* getState("Worker")).toBeUndefined();
        yield* inDev(stack.deploy(program, { include: ["Worker"] }));
        expect((yield* getState("Worker")).providerMode).toBe("local");
        yield* stack.destroy();
      }),
  );
});

describe("noop stable readiness", { tags: ["unit", "local"] }, () => {
  test.provider(
    "publishes noop resource output before waking captured Action consumers",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.destroy();
        let runs = 0;
        const program = (revision: number) =>
          Effect.gen(function* () {
            const source = yield* TestResource("Source", {
              string: "ready",
            }).pipe(RemovalPolicy.retain(revision > 1));
            const Compute = Action(
              "Compute",
              Effect.gen(function* () {
                const value = yield* source.string;
                return (_: { revision: number }) =>
                  Effect.gen(function* () {
                    const resolved = yield* value;
                    runs++;
                    return { value: resolved };
                  });
              }),
            );
            const result = yield* Compute({ revision });
            return result.value;
          });
        expect(yield* stack.deploy(program(1))).toBe("ready");
        const plan = yield* stack.plan(program(2));
        expect(plan.resources.Source.action).toBe("noop");
        expect(plan.actions.Compute.action).toBe("run");
        // The policy note holds the noop until the Action reports pending.
        // One cooperative yield lets it await readyStable before publication;
        // Deferred completion then resumes the waiting consumer synchronously.
        const pending = yield* Deferred.make<void>();
        expect(
          yield* apply(plan, {
            session: {
              done: () => Effect.void,
              emit: (event) => {
                if (
                  event._tag === "apply.resource.status" &&
                  event.id === "Compute" &&
                  event.status === "pending"
                ) {
                  return Deferred.succeed(pending, undefined).pipe(
                    Effect.asVoid,
                  );
                }
                if (
                  event._tag === "apply.resource.note" &&
                  event.id === "Source"
                ) {
                  return Deferred.await(pending).pipe(
                    Effect.andThen(Effect.yieldNow),
                  );
                }
                return Effect.void;
              },
            },
          }),
        ).toBe("ready");
        expect(runs).toBe(2);
        expect(yield* stack.deploy(program(2))).toBe("ready");
        expect(runs).toBe(2);
        yield* stack.destroy();
      }),
  );
});

describe(
  "resource selection apply barriers",
  { tags: ["unit", "local"] },
  () => {
    for (const revision of ["old", "new"]) {
      test.provider(
        `excluded ${revision === "old" ? "noop" : "changed"} upstream rejects without reads diffs mutations or row changes`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            const program = (value: string, fresh = false) =>
              Effect.gen(function* () {
                const source = yield* BindingTarget("Source", {
                  string: value,
                });
                const middle = yield* BindingTarget("Middle", {
                  string: source.string,
                });
                const consumer = yield* TestResource("Consumer", {
                  string: middle.string,
                });
                if (fresh) yield* TestResource("Fresh", {});
                return { consumer: consumer.string };
              }).pipe(Namespace.push("App"));
            yield* stack.deploy(program("old"));
            const state = yield* yield* State;
            const key = { stack: stack.name, stage: stack.stage };
            const snapshot = Effect.gen(function* () {
              const ids = [...(yield* state.list(key))].sort();
              const rows = yield* Effect.forEach(ids, (fqn) =>
                state.get({ ...key, fqn }),
              );
              const output = yield* state.getOutput(key);
              return yield* Effect.sync(() =>
                JSON.stringify({ ids, rows, output }),
              );
            });
            const before = yield* snapshot;
            const calls: string[] = [];
            const record = (op: string) => (id: string) =>
              Effect.sync(() => {
                calls.push(`${op}:${id}`);
              });
            const rejected = yield* stack
              .deploy(program(revision, true), {
                include: ["App/Fresh", "App/Consumer"],
                exclude: ["App/S*"],
              })
              .pipe(
                Effect.provideService(TestResourceHooks, {
                  read: (id) => record("read")(id).pipe(Effect.as(undefined)),
                  diff: record("diff"),
                  create: record("create"),
                  update: record("update"),
                  delete: record("delete"),
                }),
                Effect.exit,
              );
            expect(Exit.isFailure(rejected)).toBe(true);
            if (Exit.isFailure(rejected)) {
              const message = Cause.pretty(rejected.cause);
              expect(message).toContain(
                "App/Consumer -> App/Middle -> App/Source",
              );
              expect(message).toContain("exclude pattern 'App/S*'");
            }
            expect(calls).toEqual([]);
            expect(yield* snapshot).toBe(before);
            yield* stack.destroy();
          }),
      );
    }

    test.provider(
      "includes and updates implicit upstreams outside the include pattern",
      (stack) =>
        Effect.gen(function* () {
          yield* stack.destroy();
          const program = (value: string) =>
            Effect.gen(function* () {
              const source = yield* TestResource("Source", { string: value });
              const middle = yield* TestResource("Middle", {
                string: source.string,
              });
              const consumer = yield* TestResource("Consumer", {
                string: middle.string,
              });
              yield* TestResource("Excluded", {});
              return { value: consumer.string };
            });
          yield* stack.deploy(program("old"));
          const excluded = yield* getState("Excluded");
          const changed: string[] = [];
          const output = yield* stack
            .deploy(program("new"), {
              include: ["Cons*"],
              exclude: ["Excluded"],
            })
            .pipe(
              Effect.provideService(TestResourceHooks, {
                update: (id) =>
                  Effect.sync(() => {
                    changed.push(id);
                  }),
              }),
            );
          expect(output).toBeUndefined();
          expect(changed).toEqual(["Source", "Middle", "Consumer"]);
          expect((yield* getState("Source")).attr?.string).toBe("new");
          expect((yield* getState("Middle")).attr?.string).toBe("new");
          expect((yield* getState("Consumer")).attr?.string).toBe("new");
          expect(yield* getState("Excluded")).toEqual(excluded);
          yield* stack.destroy();
        }),
    );

    for (const selection of [
      { include: ["**"] },
      { exclude: ["Missing/**"] },
    ]) {
      test.provider(
        `selecting everything still preserves stack outputs ${JSON.stringify(selection)}`,
        (stack) =>
          Effect.gen(function* () {
            yield* stack.destroy();
            yield* stack.deploy(
              TestResource("Only", { string: "old" }).pipe(
                Effect.as({ full: "old" }),
              ),
            );
            const output = yield* stack.deploy(
              TestResource("Only", { string: "new" }).pipe(
                Effect.map((resource) =>
                  Output.map(resource.string, () => {
                    throw new Error("partial output evaluated");
                  }),
                ),
              ),
              selection,
            );
            expect(output).toBeUndefined();
            expect((yield* getState("Only")).attr?.string).toBe("new");
            const state = yield* yield* State;
            expect(
              yield* state.getOutput({ stack: stack.name, stage: stack.stage }),
            ).toEqual({ full: "old" });
            yield* stack.destroy();
          }),
      );
    }
  },
);
