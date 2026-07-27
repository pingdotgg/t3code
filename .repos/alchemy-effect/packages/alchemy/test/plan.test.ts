import { adopt, AdoptPolicy, Unowned } from "@/AdoptPolicy";
import { dedupeBindings } from "@/Diff";
import type { Input, InputProps } from "@/Input";
import * as Namespace from "@/Namespace.ts";
import * as Output from "@/Output";
import * as Plan from "@/Plan";
import * as Provider from "@/Provider";
import { UnsatisfiedResourceCycle } from "@/Plan";
import type { ResourceBinding } from "@/Resource";
import * as Stack from "@/Stack";
import { Stage } from "@/Stage";
import {
  InMemoryService,
  inMemoryState,
  State,
  type ResourceState,
  type ResourceStatus,
} from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import {
  AliasedWidget,
  aliasedWidgetProvider,
  ArtifactProbe,
  BindingTarget,
  Bucket,
  Function,
  KindStablesResource,
  NoPrecreateBindingTarget,
  OverrideStablesResource,
  Queue,
  TestLayers,
  TestResource,
  TestResourceHooks,
  type TestResourceProps,
} from "./test.resources";

const TEST_STACK = "test";
const TEST_STAGE = "test";

// Fresh in-memory state per test run so seeded resources from one test
// don't leak into another in the same file.
const freshState = Layer.effect(
  State,
  Effect.sync(() => InMemoryService({})),
);

const { test } = Test.make({
  providers: TestLayers(),
  state: freshState,
});

// Resolve stack name/stage from ambient Stack if present (for test.provider)
// otherwise fall back to the file-level defaults (for plain test()).
const resolveStackId = Effect.gen(function* () {
  const ambient = yield* Effect.serviceOption(Stack.Stack);
  return Option.match(ambient, {
    onNone: () => ({ name: TEST_STACK, stage: TEST_STAGE }),
    onSome: (s) => ({ name: s.name, stage: s.stage }),
  });
});

const seed = (resources: Record<string, ResourceState>) =>
  Effect.gen(function* () {
    const { name, stage } = yield* resolveStackId;
    const state = yield* yield* State;
    for (const [fqn, value] of Object.entries(resources)) {
      yield* state.set({ stack: name, stage, fqn, value });
    }
  });

const instanceId = "852f6ec2e19b66589825efe14dca2971";

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

const makePlanWithCustomStack =
  (stackSpec: any) =>
  <A, Err = never, Req = never>(
    effect: Effect.Effect<A, Err, Req>,
  ): Effect.Effect<Plan.Plan<A>, Err, State> =>
    // @ts-expect-error
    Effect.gen(function* () {
      const { name, stage } = yield* resolveStackId;
      // @ts-expect-error
      return yield* effect.pipe(
        // @ts-expect-error
        Stack.make({
          name,
          providers: Layer.empty,
          state: inMemoryState(),
          stack: stackSpec,
        }),
        Effect.provideService(Stage, stage),
        Effect.flatMap(Plan.make),
        Effect.provide(TestLayers()),
      );
    });

test(
  "artifacts are isolated by FQN during plan diff for namespaced resources",
  Effect.gen(function* () {
    yield* seed({
      "Left/Shared": {
        instanceId: "left-instance",
        providerVersion: 0,
        logicalId: "Shared",
        fqn: "Left/Shared",
        namespace: { Id: "Left" },
        resourceType: "Test.ArtifactProbe",
        status: "created",
        props: {
          value: "left-v1",
        },
        attr: {
          value: "left-v1",
          artifactValue: undefined,
        },
        bindings: [],
        downstream: [],
      },
      "Right/Shared": {
        instanceId: "right-instance",
        providerVersion: 0,
        logicalId: "Shared",
        fqn: "Right/Shared",
        namespace: { Id: "Right" },
        resourceType: "Test.ArtifactProbe",
        status: "created",
        props: {
          value: "right-v1",
        },
        attr: {
          value: "right-v1",
          artifactValue: undefined,
        },
        bindings: [],
        downstream: [],
      },
    });
    const Site = (id: string, props: { value: string }) =>
      Effect.gen(function* () {
        return yield* ArtifactProbe("Shared", { value: props.value });
      }).pipe(Namespace.push(id));

    const plan = yield* Effect.gen(function* () {
      const left = yield* Site("Left", { value: "left-v2" });
      const right = yield* Site("Right", { value: "right-v2" });
      return { left, right };
    }).pipe(makePlan);

    expect(plan.resources["Left/Shared"]?.action).toEqual("update");
    expect(plan.resources["Right/Shared"]?.action).toEqual("update");
  }),
);

test(
  "create all resources when plan is empty",
  Effect.gen(function* () {
    expect(
      yield* Effect.gen(function* () {
        const bucket = yield* Bucket("MyBucket", {
          name: "test-bucket",
        });
        const queue = yield* Queue("MyQueue", {
          name: "test-queue",
        });

        return {
          queueUrl: queue.queueUrl,
          bucketArn: bucket.bucketArn,
        };
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        MyBucket: {
          action: "create",
          bindings: [],
          props: {
            name: "test-bucket",
          },
          state: undefined,
        },
        MyQueue: {
          action: "create",
          bindings: [],
          props: {
            name: "test-queue",
          },
          state: undefined,
        },
      },
      deletions: expect.toSatisfy(
        (d: any) => Object.keys(d).length === 0,
        "empty object",
      ),
    });
  }),
);

test(
  "update the changed resources and no-op un-changed resources",
  Effect.gen(function* () {
    yield* seed({
      MyBucket: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyBucket",
        fqn: "MyBucket",
        namespace: undefined,
        resourceType: "Test.Bucket",
        status: "created",
        props: {
          name: "test-bucket",
        },
        attr: {
          name: "test-bucket",
        },
        bindings: [],
        downstream: [],
      },
    });
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Bucket("MyBucket", {
            name: "test-bucket",
          });
          yield* Queue("MyQueue", {
            name: "test-queue",
          });
        }),
      ),
    ).toMatchObject({
      resources: {
        MyBucket: {
          action: "noop",
          bindings: [],
          state: {
            status: "created",
          },
        },
        MyQueue: {
          action: "create",
          bindings: [],
          props: {
            name: "test-queue",
          },
          state: undefined,
        },
      },
      deletions: expect.toSatisfy(
        (d: any) => Object.keys(d).length === 0,
        "empty object",
      ),
    });
  }),
);

test(
  "plan downstream resources when a stable kind shadows an output discriminator",
  Effect.gen(function* () {
    yield* seed({
      Database: {
        instanceId,
        providerVersion: 0,
        logicalId: "Database",
        fqn: "Database",
        namespace: undefined,
        resourceType: "Test.KindStablesResource",
        status: "created",
        props: {
          value: "v1",
        },
        attr: {
          kind: "postgresql",
          value: "v1",
          upstreamKind: undefined,
        },
        bindings: [],
        downstream: [],
      },
    });

    const plan = yield* Effect.gen(function* () {
      const database = yield* KindStablesResource("Database", {
        value: "v2",
      });
      yield* KindStablesResource("Role", {
        value: "role",
        upstream: database,
      });
    }).pipe(makePlan);

    expect(plan.resources.Database!.action).toBe("update");
    expect(plan.resources.Role!.action).toBe("create");
  }),
);

test(
  "force changes noop resources into updates",
  Effect.gen(function* () {
    yield* seed({
      MyBucket: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyBucket",
        fqn: "MyBucket",
        namespace: undefined,
        resourceType: "Test.Bucket",
        status: "created",
        props: {
          name: "test-bucket",
        },
        attr: {
          name: "test-bucket",
        },
        bindings: [],
        downstream: [],
      },
    });
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Bucket("MyBucket", {
            name: "test-bucket",
          });
        }),
        { force: true },
      ),
    ).toMatchObject({
      resources: {
        MyBucket: {
          action: "update",
          bindings: [],
          props: {
            name: "test-bucket",
          },
          state: {
            status: "created",
          },
        },
      },
      deletions: expect.toSatisfy(
        (d: any) => Object.keys(d).length === 0,
        "empty object",
      ),
    });
  }),
);

test(
  "no-op resources with undefined props",
  Effect.gen(function* () {
    yield* seed({
      MyQueue: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyQueue",
        fqn: "MyQueue",
        namespace: undefined,
        resourceType: "Test.Queue",
        status: "created",
        props: undefined as any,
        attr: {
          name: "MyQueue",
          queueUrl: "https://test.queue.com/MyQueue",
        },
        bindings: [],
        downstream: [],
      },
    });
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Queue("MyQueue");
        }),
      ),
    ).toMatchObject({
      resources: {
        MyQueue: {
          action: "noop",
          bindings: [],
          state: {
            status: "created",
          },
        },
      },
      deletions: expect.toSatisfy(
        (d: any) => Object.keys(d).length === 0,
        "empty object",
      ),
    });
  }),
);

test(
  "no-op resources when object prop key order changes",
  Effect.gen(function* () {
    yield* seed({
      MyFunction: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyFunction",
        fqn: "MyFunction",
        namespace: undefined,
        resourceType: "Test.Function",
        status: "created",
        props: {
          name: "test-function",
          env: {
            A: "1",
            B: "2",
          },
        },
        attr: {
          name: "test-function",
          env: {
            A: "1",
            B: "2",
          },
          functionArn: "arn:test:function:MyFunction",
        },
        bindings: [],
        downstream: [],
      },
    });
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Function("MyFunction", {
            name: "test-function",
            env: {
              B: "2",
              A: "1",
            },
          });
        }),
      ),
    ).toMatchObject({
      resources: {
        MyFunction: {
          action: "noop",
          bindings: [],
          state: {
            status: "created",
          },
        },
      },
      deletions: expect.toSatisfy(
        (d: any) => Object.keys(d).length === 0,
        "empty object",
      ),
    });
  }),
);

test(
  "delete orphaned resources",
  Effect.gen(function* () {
    yield* seed({
      MyBucket: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyBucket",
        fqn: "MyBucket",
        namespace: undefined,
        resourceType: "Test.Bucket",
        status: "created",
        props: {
          name: "test-bucket",
        },
        attr: {
          name: "test-bucket",
        },
        bindings: [],
        downstream: [],
      },
      MyQueue: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyQueue",
        fqn: "MyQueue",
        namespace: undefined,
        resourceType: "Test.Queue",
        status: "created",
        props: {
          name: "test-queue",
        },
        attr: {
          name: "test-queue",
        },
        bindings: [],
        downstream: [],
      },
    });
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Queue("MyQueue", {
            name: "test-queue",
          });
        }),
      ),
    ).toMatchObject({
      resources: {
        MyQueue: {
          action: "noop",
          bindings: [],
          state: {
            status: "created",
          },
        },
      },
      deletions: {
        MyBucket: {
          action: "delete",
          bindings: [],
          state: {
            status: "created",
            attr: {
              name: "test-bucket",
            },
          },
          resource: {
            LogicalId: "MyBucket",
            Type: "Test.Bucket",
            Props: {
              name: "test-bucket",
            },
          },
        },
      },
    });
  }),
);

test(
  "allow deleting a resource after a surviving consumer removes the dependency",
  Effect.gen(function* () {
    yield* seed({
      Secret: {
        instanceId,
        providerVersion: 0,
        logicalId: "Secret",
        fqn: "Secret",
        namespace: undefined,
        resourceType: "Test.TestResource",
        status: "created",
        props: {
          string: "secret-value",
        },
        attr: {
          string: "secret-value",
          stringArray: [],
          stableString: "Secret",
          stableArray: ["Secret"],
          replaceString: undefined,
        },
        bindings: [],
        downstream: ["Worker"],
      },
      Worker: {
        instanceId,
        providerVersion: 0,
        logicalId: "Worker",
        fqn: "Worker",
        namespace: undefined,
        resourceType: "Test.Function",
        status: "created",
        props: {
          name: "worker",
          env: {
            SECRET: "secret-value",
          },
        },
        attr: {
          name: "worker",
          env: {
            SECRET: "secret-value",
          },
          functionArn: "arn:aws:lambda:us-west-2:084828582823:function:Worker",
        },
        bindings: [],
        downstream: [],
      },
    });
    expect(
      yield* makePlan(
        Effect.gen(function* () {
          yield* Function("Worker", {
            name: "worker",
          });
        }),
      ),
    ).toMatchObject({
      resources: {
        Worker: {
          action: "update",
          props: {
            name: "worker",
          },
          bindings: [],
        },
      },
      deletions: {
        Secret: {
          action: "delete",
          state: {
            status: "created",
            downstream: ["Worker"],
          },
        },
      },
    });
  }),
);

test(
  "reject deleting a resource when a surviving consumer still references it",
  Effect.gen(function* () {
    yield* seed({
      Secret: {
        instanceId,
        providerVersion: 0,
        logicalId: "Secret",
        fqn: "Secret",
        namespace: undefined,
        resourceType: "Test.TestResource",
        status: "created",
        props: {
          string: "secret-value",
        },
        attr: {
          string: "secret-value",
          stringArray: [],
          stableString: "Secret",
          stableArray: ["Secret"],
          replaceString: undefined,
        },
        bindings: [],
        downstream: ["Worker"],
      },
      Worker: {
        instanceId,
        providerVersion: 0,
        logicalId: "Worker",
        fqn: "Worker",
        namespace: undefined,
        resourceType: "Test.Function",
        status: "created",
        props: {
          name: "worker",
          env: {
            SECRET: "secret-value",
          },
        },
        attr: {
          name: "worker",
          env: {
            SECRET: "secret-value",
          },
          functionArn: "arn:aws:lambda:us-west-2:084828582823:function:Worker",
        },
        bindings: [],
        downstream: [],
      },
    });
    const malformedStack = {
      name: TEST_STACK,
      stage: TEST_STAGE,
      resources: {},
      bindings: {},
      output: undefined,
    };

    const exit = yield* Effect.exit(
      Effect.gen(function* () {
        const secret = yield* TestResource("Secret", {
          string: "secret-value",
        });
        yield* Function("Worker", {
          name: "worker",
          env: {
            SECRET: secret.string,
          },
        });
        const stack = yield* Stack.Stack;
        delete stack.resources.Secret;
      }).pipe(makePlanWithCustomStack(malformedStack)),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons.find(Cause.isFailReason);
      expect(reason).toBeDefined();
      expect(reason!.error).toEqual(
        new Plan.DeleteResourceHasDownstreamDependencies({
          message: "Resource Secret has downstream dependencies",
          resourceId: "Secret",
          dependencies: ["Worker"],
        }),
      );
    }
  }),
);

describe("replace resource when replaceString changes", () => {
  const stateResources: Record<string, ResourceState> = {
    A: {
      instanceId,
      providerVersion: 0,
      logicalId: "A",
      fqn: "A",
      namespace: undefined,
      resourceType: "Test.TestResource",
      status: "created",
      props: {
        replaceString: "A",
      },
      attr: {},
      downstream: [],
      bindings: [],
    },
  };

  test(
    "noop and replace when replaceString is fully resolved at plan time",
    Effect.gen(function* () {
      yield* seed(stateResources);
      expect(
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "A",
          });
        }).pipe(makePlan),
      ).toMatchObject({
        resources: {
          A: {
            action: "noop",
          },
        },
        deletions: expect.toSatisfy(
          (d: any) => Object.keys(d).length === 0,
          "empty object",
        ),
      });

      expect(
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "B",
          });
        }).pipe(makePlan),
      ).toMatchObject({
        resources: {
          A: {
            action: "replace",
            props: {
              replaceString: "B",
            },
          },
        },
        deletions: expect.toSatisfy(
          (d: any) => Object.keys(d).length === 0,
          "empty object",
        ),
      });
    }),
  );

  test(
    "force preserves replaces",
    Effect.gen(function* () {
      yield* seed(stateResources);
      expect(
        yield* Effect.gen(function* () {
          yield* TestResource("A", {
            replaceString: "B",
          });
        }).pipe((effect) => makePlan(effect, { force: true })),
      ).toMatchObject({
        resources: {
          A: {
            action: "replace",
            props: {
              replaceString: "B",
            },
          },
        },
        deletions: expect.toSatisfy(
          (d: any) => Object.keys(d).length === 0,
          "empty object",
        ),
      });
    }),
  );

  test(
    "update when replaceString depends on unresolved output (diff short-circuits)",
    Effect.gen(function* () {
      yield* seed(stateResources);
      let B: TestResource;
      expect(
        yield* Effect.gen(function* () {
          B = yield* TestResource("B", {
            string: "A",
          });
          yield* TestResource("A", {
            replaceString: B.string,
          });
        }).pipe(makePlan),
      ).toMatchObject({
        resources: {
          A: {
            action: "update",
            props: {
              replaceString: expect.objectContaining({
                kind: "PropExpr",
                identifier: "string",
                expr: expect.objectContaining({
                  kind: "ResourceExpr",
                  src: B!,
                }),
              }),
            },
          },
        },
        deletions: expect.toSatisfy(
          (d: any) => Object.keys(d).length === 0,
          "empty object",
        ),
      });
    }),
  );
});

test(
  "update resource when a binding is added without prop changes",
  Effect.gen(function* () {
    yield* seed({
      A: {
        instanceId,
        providerVersion: 0,
        logicalId: "A",
        fqn: "A",
        namespace: undefined,
        resourceType: "Test.BindingTarget",
        status: "created",
        props: {
          name: "target",
        },
        attr: {
          name: "target",
          env: {},
        },
        bindings: [],
        downstream: [],
      },
    });
    expect(
      yield* Effect.gen(function* () {
        const target = yield* BindingTarget("A", {
          name: "target",
        });
        yield* target.bind("TestBinding", {
          env: {
            FEATURE_FLAG: "on",
          },
        });
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        A: {
          action: "update",
          bindings: [
            {
              action: "create",
              sid: "TestBinding",
              data: {
                env: {
                  FEATURE_FLAG: "on",
                },
              },
            },
          ],
          state: {
            status: "created",
          },
        },
      },
      deletions: expect.toSatisfy(
        (d: any) => Object.keys(d).length === 0,
        "empty object",
      ),
    });
  }),
);

test(
  "update resource when a binding is removed without prop changes",
  Effect.gen(function* () {
    yield* seed({
      A: {
        instanceId,
        providerVersion: 0,
        logicalId: "A",
        fqn: "A",
        namespace: undefined,
        resourceType: "Test.BindingTarget",
        status: "created",
        props: {
          name: "target",
        },
        attr: {
          name: "target",
          env: {
            FEATURE_FLAG: "on",
          },
        },
        bindings: [
          {
            sid: "TestBinding",
            data: {
              env: {
                FEATURE_FLAG: "on",
              },
            },
          },
        ],
        downstream: [],
      },
    });
    expect(
      yield* Effect.gen(function* () {
        yield* BindingTarget("A", {
          name: "target",
        });
      }).pipe(makePlan),
    ).toMatchObject({
      resources: {
        A: {
          action: "update",
          bindings: [
            {
              action: "delete",
              sid: "TestBinding",
              data: {
                env: {
                  FEATURE_FLAG: "on",
                },
              },
            },
          ],
          state: {
            status: "created",
          },
        },
      },
      deletions: expect.toSatisfy(
        (d: any) => Object.keys(d).length === 0,
        "empty object",
      ),
    });
  }),
);

test.provider(
  "binding removals do not keep reappearing after apply",
  (scratch) =>
    Effect.gen(function* () {
      const state = yield* yield* State;
      yield* state.set({
        stack: scratch.name,
        stage: TEST_STAGE,
        fqn: "A",
        value: {
          instanceId,
          providerVersion: 0,
          logicalId: "A",
          fqn: "A",
          namespace: undefined,
          resourceType: "Test.BindingTarget",
          status: "created",
          props: {
            name: "target",
          },
          attr: {
            name: "target",
            env: {
              FEATURE_FLAG: "on",
            },
          },
          bindings: [
            {
              sid: "TestBinding",
              data: {
                env: {
                  FEATURE_FLAG: "on",
                },
              },
            },
          ],
          downstream: [],
        },
      });

      yield* scratch.deploy(
        Effect.gen(function* () {
          yield* BindingTarget("A", {
            name: "target",
          });
        }),
      );

      expect(
        yield* state.get({
          stack: scratch.name,
          stage: TEST_STAGE,
          fqn: "A",
        }),
      ).toMatchObject({
        bindings: [],
      });

      expect(
        yield* Effect.gen(function* () {
          yield* BindingTarget("A", {
            name: "target",
          });
        }).pipe(makePlan),
      ).toMatchObject({
        resources: {
          A: {
            action: "noop",
            bindings: [],
          },
        },
        deletions: expect.toSatisfy(
          (d: any) => Object.keys(d).length === 0,
          "empty object",
        ),
      });
    }),
);

describe("duplicate bindings are collapsed by sid before diff", () => {
  test(
    "dedupeBindings keeps the last occurrence of each sid",
    Effect.sync(() => {
      const deduped = dedupeBindings([
        { sid: "Shared", data: { env: { K: "first" } } },
        { sid: "Other", data: { env: { K: "x" } } },
        { sid: "Shared", data: { env: { K: "last" } } },
      ]);

      // The duplicated sid takes the last value (matching `diffBindings`'
      // `Map`-based collapse) and the result is sid-sorted so binding rows
      // are deterministic regardless of registration order.
      expect(deduped).toEqual([
        { sid: "Other", data: { env: { K: "x" } } },
        { sid: "Shared", data: { env: { K: "last" } } },
      ]);
    }),
  );

  test(
    "diff observes a single binding when the same sid is bound twice",
    Effect.gen(function* () {
      yield* seed({
        A: {
          instanceId,
          providerVersion: 0,
          logicalId: "A",
          fqn: "A",
          namespace: undefined,
          resourceType: "Test.BindingTarget",
          status: "created",
          props: {
            name: "target",
          },
          attr: {
            name: "target",
            env: {},
          },
          bindings: [],
          downstream: [],
        },
      });

      // Capture the exact binding list the provider's `diff` receives.
      const observed: ResourceBinding[][] = [];

      const plan = yield* Effect.gen(function* () {
        const target = yield* BindingTarget("A", {
          name: "target",
        });
        // The same sid is recorded twice — mirrors a single KV namespace
        // bound to two consumers that both attach it to the same target,
        // which pushes a duplicate into `stack.bindings[fqn]`.
        yield* target.bind("Shared", { env: { FEATURE_FLAG: "on" } });
        yield* target.bind("Shared", { env: { FEATURE_FLAG: "on" } });
      }).pipe(
        makePlan,
        Effect.provideService(TestResourceHooks, {
          diff: (_id, newBindings) =>
            Effect.sync(() => {
              observed.push(newBindings);
            }),
        }),
      );

      // Before the fix, `diff` saw the raw duplicate pair (length 2) while
      // `reconcile` saw a deduped list — an inconsistency that made hashing
      // unstable. Every diff invocation must now see the collapsed list.
      expect(observed.length).toBeGreaterThan(0);
      for (const seen of observed) {
        expect(seen).toHaveLength(1);
        expect(seen[0]).toMatchObject({
          sid: "Shared",
          data: { env: { FEATURE_FLAG: "on" } },
        });
      }

      // The plan node likewise collapses to a single create binding.
      expect(plan.resources.A).toMatchObject({
        action: "update",
        bindings: [
          {
            action: "create",
            sid: "Shared",
            data: { env: { FEATURE_FLAG: "on" } },
          },
        ],
      });
    }),
  );
});

describe("construct namespaces", () => {
  test(
    "namespaced construct bindings resolve into the plan graph",
    Effect.gen(function* () {
      const Site = (id: string, _props: {}) =>
        Effect.gen(function* () {
          const bucket = yield* BindingTarget("Bucket", {
            name: "bucket",
          });
          const distribution = yield* BindingTarget("Distribution", {
            name: "distribution",
          });
          yield* bucket.bind("Policy", {
            env: {
              BUCKET: bucket.string,
              DISTRIBUTION: distribution.string,
            },
          });
          return { bucket, distribution };
        }).pipe(Namespace.push(id));

      const plan = yield* Effect.gen(function* () {
        yield* Site("MarketingSite", {});
      }).pipe(makePlan);

      expect(plan).toMatchObject({
        resources: {
          "MarketingSite/Bucket": {
            action: "create",
            bindings: [
              {
                action: "create",
                sid: "Policy",
                data: {
                  env: {
                    BUCKET: expect.objectContaining({
                      kind: "PropExpr",
                      identifier: "string",
                      expr: expect.objectContaining({
                        kind: "ResourceExpr",
                        src: plan.resources["MarketingSite/Bucket"]!.resource,
                      }),
                    }),
                    DISTRIBUTION: expect.objectContaining({
                      kind: "PropExpr",
                      identifier: "string",
                      expr: expect.objectContaining({
                        kind: "ResourceExpr",
                        src: plan.resources["MarketingSite/Distribution"]!
                          .resource,
                      }),
                    }),
                  },
                },
              },
            ],
          },
          "MarketingSite/Distribution": {
            action: "create",
            bindings: [],
          },
        },
        deletions: expect.toSatisfy(
          (d: any) => Object.keys(d).length === 0,
          "empty object",
        ),
      });
    }),
  );

  test(
    "same child logical ids in different constructs do not collide",
    Effect.gen(function* () {
      const Site = (id: string, props: { name: string }) =>
        Effect.gen(function* () {
          return yield* Bucket("Bucket", {
            name: props.name,
          });
        }).pipe(Namespace.push(id));

      const plan = yield* Effect.gen(function* () {
        yield* Site("MarketingSite", {
          name: "marketing-bucket",
        });
        yield* Site("DocsSite", {
          name: "docs-bucket",
        });
      }).pipe(makePlan);

      expect(plan).toMatchObject({
        resources: {
          "MarketingSite/Bucket": {
            action: "create",
            props: {
              name: "marketing-bucket",
            },
          },
          "DocsSite/Bucket": {
            action: "create",
            props: {
              name: "docs-bucket",
            },
          },
        },
        deletions: expect.toSatisfy(
          (d: any) => Object.keys(d).length === 0,
          "empty object",
        ),
      });
    }),
  );

  test(
    "binding-only cycles inside a construct do not become downstream edges",
    Effect.gen(function* () {
      const Site = (id: string, _props: {}) =>
        Effect.gen(function* () {
          const A = yield* BindingTarget("A", {
            string: "a-value",
          });
          const B = yield* BindingTarget("B", {
            string: "b-value",
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

          return { A, B };
        }).pipe(Namespace.push(id));

      const plan = yield* Effect.gen(function* () {
        yield* Site("MarketingSite", {});
      }).pipe(makePlan);

      expect(plan.resources["MarketingSite/A"]?.downstream).toEqual([]);
      expect(plan.resources["MarketingSite/B"]?.downstream).toEqual([]);
      expect(plan.deletions).toEqual({});
    }),
  );
});

const createTestResourceState = (options: {
  logicalId: string;
  status: ResourceStatus;
  props: TestResourceProps;
  attr?: {};
}) =>
  ({
    instanceId,
    providerVersion: 0,
    ...options,
    resourceType: "Test.TestResource",
    attr: options.attr ?? {},
    downstream: [],
    bindings: [],
    fqn: options.logicalId,
    namespace: undefined,
  }) as ResourceState;

const createReplacingState = (options: {
  logicalId: string;
  props: TestResourceProps;
  old: ResourceState;
  attr?: {};
}) =>
  ({
    ...createTestResourceState({
      logicalId: options.logicalId,
      status: "replacing",
      props: options.props,
      attr: options.attr,
    }),
    old: options.old,
    deleteFirst: false,
  }) as Extract<ResourceState, { status: "replacing" }>;

const createReplacedState = (options: {
  logicalId: string;
  props: TestResourceProps;
  old: ResourceState;
  attr?: {};
}) =>
  ({
    ...createTestResourceState({
      logicalId: options.logicalId,
      status: "replaced",
      props: options.props,
      attr: options.attr,
    }),
    old: options.old,
    deleteFirst: false,
  }) as Extract<ResourceState, { status: "replaced" }>;

const testSimple = (
  title: string,
  testCase: {
    state: {
      status: ResourceStatus;
      props: TestResourceProps;
      attr?: {};
      old?: Partial<ResourceState>;
    };
    props: TestResourceProps;
    plan?: any;
    fail?: string;
  },
) =>
  test(
    title,
    Effect.gen(function* () {
      yield* seed({
        A: createTestResourceState({
          ...testCase.state,
          logicalId: "A",
        }),
      });
      {
        const plan = Effect.gen(function* () {
          yield* TestResource("A", testCase.props);
        }).pipe(makePlan);

        if (testCase.fail) {
          const result = plan.pipe(
            Effect.map(() => false),
            // @ts-expect-error
            Effect.catchTag(testCase.fail, () => Effect.succeed(true)),
            Effect.catch(() => Effect.succeed(false)),
          ) as Effect.Effect<boolean>;
          if (!result) {
            expect.fail(`Expected error '${testCase.fail}`);
          }
        } else {
          expect(yield* plan).toMatchObject({
            resources: {
              A: testCase.plan,
            },
            deletions: expect.toSatisfy(
              (d: any) => Object.keys(d).length === 0,
              "empty object",
            ),
          });
        }
      }
    }),
  );

describe("prior crash in 'creating' state", () => {
  testSimple("create if props unchanged", {
    state: {
      status: "creating",
      props: {
        string: "A",
      },
    },
    props: {
      string: "A",
    },
    plan: {
      action: "create",
      props: {
        string: "A",
      },
    },
  });

  testSimple("create if changed props can be updated", {
    state: {
      status: "creating",
      props: {
        string: "A",
      },
    },
    props: {
      string: "B",
    },
    plan: {
      action: "create",
      props: {
        string: "B",
      },
    },
  });

  testSimple("replace if changed props cannot be updated", {
    state: {
      status: "creating",
      props: {
        replaceString: "A",
      },
    },
    props: {
      replaceString: "B",
    },
    plan: {
      action: "replace",
      props: {
        replaceString: "B",
      },
      state: {
        status: "creating",
        props: {
          replaceString: "A",
        },
      },
    },
  });
});

describe("prior crash in 'updating' state", () => {
  testSimple("update if props unchanged", {
    state: {
      status: "updating",
      props: {
        string: "A",
      },
    },
    props: {
      string: "A",
    },
    plan: {
      action: "update",
      props: {
        string: "A",
      },
      state: {
        status: "updating",
        props: {
          string: "A",
        },
      },
    },
  });

  testSimple("update if changed props can be updated", {
    state: {
      status: "updating",
      props: {
        string: "A",
      },
    },
    props: {
      string: "B",
    },
    plan: {
      action: "update",
      props: {
        string: "B",
      },
      state: {
        status: "updating",
        props: {
          string: "A",
        },
      },
    },
  });

  testSimple("replace if changed props can not be updated", {
    state: {
      status: "updating",
      props: {
        replaceString: "A",
      },
    },
    props: {
      replaceString: "B",
    },
    plan: {
      action: "replace",
      props: {
        replaceString: "B",
      },
      state: {
        status: "updating",
        props: {
          replaceString: "A",
        },
      },
    },
  });
});

describe("prior crash in 'replacing' state", () => {
  const priorStates = ["created", "creating", "updated", "updating"] as const;

  const testUnchanged = ({
    old,
  }: {
    old: {
      status: ResourceStatus;
    };
  }) =>
    testSimple(
      `"continue 'replace' if props are unchanged and previous state is '${old.status}'"`,
      {
        state: {
          status: "replacing",
          props: {
            string: "A",
          },
          old,
        },
        props: {
          string: "A",
        },
        plan: {
          action: "replace",
          props: {
            string: "A",
          },
          state: {
            status: "replacing",
            props: {
              string: "A",
            },
            old,
          },
        },
      },
    );

  priorStates.forEach((status) =>
    testUnchanged({
      old: {
        status,
      },
    }),
  );

  const testMinorChange = ({
    old,
  }: {
    old: {
      status: ResourceStatus;
    };
  }) =>
    testSimple(
      `"continue 'replace' if props can be updated and previous state is '${old.status}'"`,
      {
        state: {
          status: "replacing",
          props: {
            string: "A",
          },
          old,
        },
        props: {
          string: "B",
        },
        plan: {
          action: "replace",
          props: {
            string: "B",
          },
          state: {
            status: "replacing",
            props: {
              string: "A",
            },
            old,
          },
        },
      },
    );

  priorStates.forEach((status) =>
    testMinorChange({
      old: {
        status,
      },
    }),
  );

  const testReplacement = (
    title: string,
    {
      old,
      plan,
    }: {
      old: ResourceState;
      plan: any;
    },
  ) =>
    testSimple(title, {
      state: {
        status: "replacing",
        props: {
          replaceString: "A",
        },
        old,
      },
      props: {
        replaceString: "B",
      },
      plan,
    });

  (["replaced", "replacing"] as const).forEach((status) =>
    testReplacement(
      `continue 'replace' if trying to replace a partially replaced resource in state '${status}'`,
      {
        old:
          status === "replaced"
            ? createReplacedState({
                logicalId: "A_old1",
                props: {
                  replaceString: "A1",
                },
                old: createTestResourceState({
                  logicalId: "A_old0",
                  status: "created",
                  props: {
                    replaceString: "A0",
                  },
                }),
              })
            : createReplacingState({
                logicalId: "A_old1",
                props: {
                  replaceString: "A1",
                },
                old: createTestResourceState({
                  logicalId: "A_old0",
                  status: "created",
                  props: {
                    replaceString: "A0",
                  },
                }),
              }),
        plan: {
          action: "replace",
          props: {
            replaceString: "B",
          },
          state: {
            status: "replacing",
            props: {
              replaceString: "A",
            },
            old: expect.objectContaining({
              status,
              props: {
                replaceString: "A1",
              },
              old: expect.objectContaining({
                status: "created",
                props: {
                  replaceString: "A0",
                },
              }),
            }),
          },
        },
      },
    ),
  );
});

describe("prior crash in 'replaced' state", () => {
  (["replaced", "replacing"] as const).forEach((status) =>
    testSimple(
      `continue 'replace' if a replaced resource must be replaced again and previous state is '${status}'`,
      {
        state: {
          status: "replaced",
          props: {
            replaceString: "A1",
          },
          old:
            status === "replaced"
              ? createReplacedState({
                  logicalId: "A_old0",
                  props: {
                    replaceString: "A0",
                  },
                  old: createTestResourceState({
                    logicalId: "A_old-1",
                    status: "created",
                    props: {
                      replaceString: "A-1",
                    },
                  }),
                })
              : createReplacingState({
                  logicalId: "A_old0",
                  props: {
                    replaceString: "A0",
                  },
                  old: createTestResourceState({
                    logicalId: "A_old-1",
                    status: "created",
                    props: {
                      replaceString: "A-1",
                    },
                  }),
                }),
        },
        props: {
          replaceString: "B",
        },
        plan: {
          action: "replace",
          props: {
            replaceString: "B",
          },
          state: {
            status: "replaced",
            props: {
              replaceString: "A1",
            },
            old: expect.objectContaining({
              status,
              props: {
                replaceString: "A0",
              },
              old: expect.objectContaining({
                status: "created",
                props: {
                  replaceString: "A-1",
                },
              }),
            }),
          },
        },
      },
    ),
  );
});

describe("prior crash in 'deleting' state", () => {
  testSimple(
    "create the resource if props are unchanged and the previous state is 'deleting'",
    {
      state: {
        status: "deleting",
        props: {
          string: "A",
        },
      },
      props: {
        string: "A",
      },
      plan: {
        action: "create",
        props: {
          string: "A",
        },
      },
    },
  );
});

test(
  "lazy Output queue.queueUrl to Function.env",
  Effect.gen(function* () {
    let MyQueue: Queue;
    let MyFunction: Function;
    const plan = yield* Effect.gen(function* () {
      MyQueue = yield* Queue("MyQueue");
      MyFunction = yield* Function("MyFunction", {
        name: "test-function",
        env: {
          QUEUE_URL: MyQueue.queueUrl,
        },
      });
    }).pipe(makePlan);
    expect(plan).toMatchObject({
      resources: {
        MyFunction: {
          action: "create",
          bindings: [],
          resource: MyFunction!,
          props: {
            name: "test-function",
            env: {
              QUEUE_URL: expect.objectContaining({
                kind: "PropExpr",
                identifier: "queueUrl",
                expr: expect.objectContaining({
                  kind: "ResourceExpr",
                  src: MyQueue!,
                }),
              }),
            },
          },
          state: undefined,
        },
      },
      deletions: expect.toSatisfy(
        (d: any) => Object.keys(d).length === 0,
        "empty object",
      ),
    });
  }),
);

test(
  "detect that queueUrl will change and pass through the PropExpr instead of old output",
  Effect.gen(function* () {
    yield* seed({
      MyQueue: {
        instanceId,
        providerVersion: 0,
        logicalId: "MyQueue",
        fqn: "MyQueue",
        namespace: undefined,
        resourceType: "Test.Queue",
        status: "created",
        props: {
          name: "test-queue-old",
        },
        attr: {
          queueUrl: "https://test.queue.com/test-queue-old",
        },
        downstream: [],
        bindings: [],
      },
    });
    let MyQueue: Queue;
    let MyFunction: Function;
    const plan = yield* Effect.gen(function* () {
      MyQueue = yield* Queue("MyQueue");
      MyFunction = yield* Function("MyFunction", {
        name: "test-function",
        env: {
          QUEUE_URL: MyQueue.queueUrl,
        },
      });
    }).pipe(makePlan);
    expect(plan).toMatchObject({
      resources: {
        MyFunction: {
          action: "create",
          bindings: [],
          resource: MyFunction!,
          props: {
            name: "test-function",
            env: {
              QUEUE_URL: expect.objectContaining({
                kind: "PropExpr",
                identifier: "queueUrl",
                expr: expect.objectContaining({
                  kind: "ResourceExpr",
                  src: MyQueue!,
                }),
              }),
            },
          },
          state: undefined,
        },
      },
      deletions: expect.toSatisfy(
        (d: any) => Object.keys(d).length === 0,
        "empty object",
      ),
    });
  }),
);

describe("Outputs should resolve to old values", () => {
  const stateResources: Record<string, ResourceState> = {
    A: {
      instanceId,
      providerVersion: 0,
      logicalId: "A",
      fqn: "A",
      namespace: undefined,
      resourceType: "Test.TestResource",
      status: "created",
      props: {
        string: "test-string",
        stringArray: ["test-string"],
      },
      attr: {
        string: "test-string",
        stringArray: ["test-string"],
      },
      downstream: [],
      bindings: [],
    },
  };

  const expected = (props: Input.Resolve<InputProps<TestResourceProps>>) => ({
    resources: {
      A: {
        action: "noop",
        bindings: [],
      },
      B: {
        action: "create",
        bindings: [],
        props: props,
      },
    },
    deletions: expect.toSatisfy(
      (d: any) => Object.keys(d).length === 0,
      "empty object",
    ),
  });

  const subtest = <const I extends InputProps<TestResourceProps>>(
    description: string,
    input: (resource: TestResource) => I,
    attr: Input.Resolve<I>,
  ) =>
    test(
      description,
      Effect.gen(function* () {
        yield* seed(stateResources);
        expect(
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "test-string",
              stringArray: ["test-string"],
            });
            yield* TestResource("B", input(A));
          }).pipe(makePlan),
        ).toMatchObject(expected(attr));
      }),
    );

  subtest(
    "string",
    (A) => ({
      string: A.string,
    }),
    {
      string: "test-string",
    },
  );

  subtest(
    "string.apply(string => undefined)",
    (A) => ({
      string: A.string.pipe(Output.map(() => undefined)),
    }),
    {
      string: undefined,
    },
  );

  subtest(
    "string.effect(string => Effect.succeed(undefined))",
    (A) => ({
      string: A.string.pipe(Output.mapEffect(() => Effect.succeed(undefined))),
    }),
    {
      string: undefined,
    },
  );

  subtest(
    "string.flatMap(() => Output.literal(undefined))",
    (A) => ({
      string: A.string.pipe(Output.flatMap(() => Output.literal(undefined))),
    }),
    {
      string: undefined,
    },
  );

  subtest(
    "string.flatMap(string => A.stringArray.map(([first]) => first))",
    (A) => ({
      string: A.string.pipe(
        Output.flatMap(() =>
          A.stringArray.pipe(
            Output.map((stringArray) => stringArray[0]!.toUpperCase()),
          ),
        ),
      ),
    }),
    {
      string: "TEST-STRING",
    },
  );

  subtest(
    "stringArray[0].toUpperCase()",
    (A) => ({
      string: A.stringArray.pipe(
        Output.map((stringArray) => stringArray[0]!.toUpperCase()),
      ),
    }),
    {
      string: "TEST-STRING",
    },
  );

  subtest(
    "resource object",
    (A) => ({
      object: A as any,
    }),
    {
      object: {
        string: "test-string",
      },
    } as any,
  );
});

describe("raw Resource refs in props are tracked as upstream dependencies", () => {
  test(
    "raw Resource passed directly as a prop value populates the upstream's downstream",
    Effect.gen(function* () {
      const plan = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-value" });
        yield* TestResource("B", {
          object: A as any,
        });
      }).pipe(makePlan);

      expect(plan.resources.A!.downstream).toEqual(["B"]);
      expect(plan.resources.B!.downstream).toEqual([]);
    }),
  );

  test(
    "raw Resources nested in arrays/objects are tracked as upstream dependencies",
    Effect.gen(function* () {
      const plan = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", { string: "a-value" });
        const B = yield* TestResource("B", { string: "b-value" });
        yield* TestResource("C", {
          stringArray: [A] as any,
          object: { ref: B } as any,
        });
      }).pipe(makePlan);

      expect(plan.resources.A!.downstream).toEqual(["C"]);
      expect(plan.resources.B!.downstream).toEqual(["C"]);
      expect(plan.resources.C!.downstream).toEqual([]);
    }),
  );
});

describe("stable properties should not cause downstream changes", () => {
  const subtest = (
    description: string,
    input: (A: TestResource) => InputProps<TestResourceProps>,
  ) => {
    // @ts-expect-error - get the keys
    const props = input(Output.of({}));
    test(
      description,
      Effect.gen(function* () {
        yield* seed({
          A: {
            instanceId,
            providerVersion: 0,
            logicalId: "A",
            fqn: "A",
            namespace: undefined,
            resourceType: "Test.TestResource",
            status: "created",
            props: {
              string: "test-string-old",
            },
            attr: {
              string: "test-string-old",
              stableString: "A",
              stableArray: ["A"],
            },
            downstream: [],
            bindings: [],
          },
          B: {
            instanceId,
            providerVersion: 0,
            logicalId: "B",
            fqn: "B",
            namespace: undefined,
            resourceType: "Test.TestResource",
            status: "created",
            props: Object.fromEntries(
              Object.entries({
                string: "A",
                stringArray: ["A"],
              }).filter(([key]) => key in props),
            ),
            attr: {
              stableString: "A",
            },
            downstream: [],
            bindings: [],
          },
        });
        expect(
          yield* Effect.gen(function* () {
            const A = yield* TestResource("A", {
              string: "test-string",
            });
            yield* TestResource("B", input(A));
          }).pipe(makePlan),
        ).toMatchObject({
          resources: {
            A: {
              action: "update",
              props: {
                string: "test-string",
              },
            },
            B: {
              action: "noop",
            },
          },
          deletions: expect.toSatisfy(
            (d: any) => Object.keys(d).length === 0,
            "empty object",
          ),
        });
      }),
    );
  };

  subtest("A.stableString", (A) => ({
    string: A.stableString,
  }));

  subtest("A.stableString.apply((string) => string.toUpperCase())", (A) => ({
    string: A.stableString.pipe(Output.map((string) => string.toUpperCase())),
  }));

  subtest(
    "A.stableString.effect((string) => Effect.succeed(string.toUpperCase()))",
    (A) => ({
      string: A.stableString.pipe(
        Output.mapEffect((string) => Effect.succeed(string.toUpperCase())),
      ),
    }),
  );

  subtest(
    "A.stableString.flatMap((string) => Output.literal(string.toUpperCase()))",
    (A) => ({
      string: A.stableString.pipe(
        Output.flatMap((string) => Output.literal(string.toUpperCase())),
      ),
    }),
  );

  subtest("A.stableArray", (A) => ({
    stringArray: A.stableArray,
  }));

  subtest("A.stableArray[0]", (A) => ({
    string: A.stableArray.pipe(Output.map((stableArray) => stableArray[0]!)),
  }));

  subtest("A.stableArray[0].apply((string) => string.toUpperCase())", (A) => ({
    string: A.stableArray.pipe(
      Output.map((stableArray) => stableArray[0]!.toUpperCase()),
    ),
  }));

  subtest(
    "A.stableArray[0].effect((string) => Effect.succeed(string.toUpperCase()))",
    (A) => ({
      string: A.stableArray.pipe(
        Output.mapEffect((stableArray) =>
          Effect.succeed(stableArray[0]!.toUpperCase()),
        ),
      ),
    }),
  );
});

describe("whole-resource refs resolve to the upstream's stable attributes", () => {
  // Regression: when a resource is referenced *whole* (e.g. `object: A`)
  // rather than via a single prop (`A.stableString`), and the upstream is
  // being updated in place, `resolveResource` returns a `ResourceExpr`
  // carrying only the stable attributes. Previously `resolveInput` handed
  // that `ResourceExpr` to the downstream verbatim, so its `news` looked
  // unresolved (`isResolved(news) === false`) and the stable values never
  // reached the downstream `diff`. This forced the Neon `Branch` to manually
  // extract `project.projectId` as a workaround. The engine must instead
  // materialize the known stable attributes into a plain object so the
  // stable values flow into the diff and the downstream can no-op.
  const seedUpdatingUpstream = () =>
    seed({
      A: {
        instanceId,
        providerVersion: 0,
        logicalId: "A",
        fqn: "A",
        namespace: undefined,
        resourceType: "Test.TestResource",
        status: "created",
        props: {
          string: "old-value",
        },
        attr: {
          string: "old-value",
          stableString: "A",
          stableArray: ["A"],
        },
        downstream: [],
        bindings: [],
      },
    });

  test(
    "the whole-resource ref resolves to the upstream's stable attributes (not an Expr)",
    Effect.gen(function* () {
      yield* seedUpdatingUpstream();

      let A: TestResource;
      const plan = yield* Effect.gen(function* () {
        // A is updated in place: `string` changes, but `stableString` /
        // `stableArray` are declared stable by its diff.
        A = yield* TestResource("A", { string: "new-value" });
        // B (created fresh) references the WHOLE upstream resource, not a
        // single prop — so its plan node carries the resolved `props`.
        yield* TestResource("B", { object: A as any });
      }).pipe(makePlan);

      expect(plan.resources.A!.action).toBe("update");

      const bProps = (plan.resources.B as any).props as TestResourceProps;
      // The whole-resource ref must resolve to a fully-resolved plain object
      // of the upstream's stable attributes — NOT an unresolved Expr.
      expect(Output.isExpr(bProps.object)).toBe(false);
      expect(bProps.object).toEqual({
        stableString: "A",
        stableArray: ["A"],
      });
    }),
  );

  test(
    "a whole-resource ref to an updating upstream does not drag the downstream into an update",
    Effect.gen(function* () {
      yield* seedUpdatingUpstream();
      yield* seed({
        B: {
          instanceId,
          providerVersion: 0,
          logicalId: "B",
          fqn: "B",
          namespace: undefined,
          resourceType: "Test.TestResource",
          status: "created",
          // B's prior props captured the upstream's stable attributes —
          // exactly what a materialized whole-resource ref resolves to.
          props: {
            object: { stableString: "A", stableArray: ["A"] } as any,
          },
          attr: {
            string: "B",
            stableString: "B",
            stableArray: ["B"],
          },
          downstream: [],
          bindings: [],
        },
      });

      let A: TestResource;
      const plan = yield* Effect.gen(function* () {
        A = yield* TestResource("A", { string: "new-value" });
        yield* TestResource("B", { object: A as any });
      }).pipe(makePlan);

      expect(plan.resources.A!.action).toBe("update");
      // Only stable attributes flow in and they are unchanged, so the
      // downstream no-ops instead of being dragged into a needless update.
      expect(plan.resources.B!.action).toBe("noop");
    }),
  );
});

describe("diff.stables overrides provider.stables", () => {
  // `A` is an OverrideStablesResource: provider `stables` is
  // ["providerStable", "sharedStable"], but its `diff` returns
  // ["diffStable", "sharedStable"] on a `string` change. The two lists
  // disagree, so this exercises the override (not merge) semantics.
  const seedUpstreamAndDownstream = (downstreamOldString: string) =>
    seed({
      A: {
        instanceId,
        providerVersion: 0,
        logicalId: "A",
        fqn: "A",
        namespace: undefined,
        resourceType: "Test.OverrideStablesResource",
        status: "created",
        props: { string: "old" },
        attr: {
          string: "old",
          providerStable: "provider-A",
          diffStable: "diff-A",
          sharedStable: "shared-A",
        },
        downstream: [],
        bindings: [],
      },
      B: {
        instanceId,
        providerVersion: 0,
        logicalId: "B",
        fqn: "B",
        namespace: undefined,
        resourceType: "Test.TestResource",
        status: "created",
        props: { string: downstreamOldString },
        attr: {
          string: downstreamOldString,
          stableString: "B",
          stableArray: ["B"],
        },
        downstream: [],
        bindings: [],
      },
    });

  const subtest = (
    description: string,
    accessor: (A: OverrideStablesResource) => any,
    downstreamOldString: string,
    expectedBAction: "update" | "noop",
  ) =>
    test(
      description,
      Effect.gen(function* () {
        yield* seedUpstreamAndDownstream(downstreamOldString);
        const plan = yield* Effect.gen(function* () {
          const A = yield* OverrideStablesResource("A", { string: "new" });
          yield* TestResource("B", { string: accessor(A) });
        }).pipe(makePlan);

        // A always updates: its `string` prop changed.
        expect(plan.resources.A!.action).toBe("update");
        expect(plan.resources.B!.action).toBe(expectedBAction);
      }),
    );

  // `providerStable` is in `provider.stables` but OMITTED from the
  // `diff.stables` returned for this update. Because `diff.stables` now
  // overrides `provider.stables`, it is treated as changed and the
  // downstream re-plans (update). Under the old merge it would wrongly
  // stay stable and the downstream would no-op.
  subtest(
    "provider-only stable omitted by diff is treated as changed downstream",
    (A) => A.providerStable,
    "provider-A",
    "update",
  );

  // `diffStable` is only in `diff.stables` -> stays stable -> downstream no-op.
  subtest(
    "diff-only stable keeps downstream stable",
    (A) => A.diffStable,
    "diff-A",
    "noop",
  );

  // `sharedStable` is in both lists -> stays stable -> downstream no-op.
  subtest(
    "shared stable keeps downstream stable",
    (A) => A.sharedStable,
    "shared-A",
    "noop",
  );
});

describe("unsatisfied cycle detection", () => {
  const extractCycleDefect = <A, E>(
    exit: Exit.Exit<A, E>,
  ): UnsatisfiedResourceCycle | undefined => {
    if (!Exit.isFailure(exit)) return undefined;
    const die = exit.cause.reasons.find(Cause.isDieReason);
    return die?.defect as UnsatisfiedResourceCycle | undefined;
  };

  test(
    "binding cycle between resources without precreate dies",
    Effect.gen(function* () {
      const exit = yield* makePlan(
        Effect.gen(function* () {
          const A = yield* NoPrecreateBindingTarget("A", {
            string: "a-value",
          });
          const B = yield* NoPrecreateBindingTarget("B", {
            string: "b-value",
          });

          yield* A.bind("FromB", { env: { PEER: B.string } });
          yield* B.bind("FromA", { env: { PEER: A.string } });

          return { A, B };
        }),
      ).pipe(Effect.exit);

      const err = extractCycleDefect(exit);
      expect(err).toBeDefined();
      expect(err!._tag).toBe("UnsatisfiedResourceCycle");
      expect(err!.cycle.sort()).toEqual(["A", "B"]);
      expect(err!.missingPrecreate.sort()).toEqual(["A", "B"]);
    }),
  );

  test(
    "binding cycle with all precreate resources succeeds",
    Effect.gen(function* () {
      const exit = yield* makePlan(
        Effect.gen(function* () {
          const A = yield* BindingTarget("A", { string: "a-value" });
          const B = yield* BindingTarget("B", { string: "b-value" });

          yield* A.bind("FromB", {
            env: { PEER: B.string },
          });
          yield* B.bind("FromA", {
            env: { PEER: A.string },
          });

          return { A, B };
        }),
      ).pipe(Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  test(
    "mixed cycle succeeds when precreate resource breaks it",
    Effect.gen(function* () {
      const exit = yield* makePlan(
        Effect.gen(function* () {
          const A = yield* BindingTarget("A", { string: "a-value" });
          const B = yield* NoPrecreateBindingTarget("B", {
            string: A.string,
          });

          yield* A.bind("FromB", {
            env: { PEER: B.string },
          });

          return { A, B };
        }),
      ).pipe(Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );

  test(
    "three-node binding cycle dies when none have precreate",
    Effect.gen(function* () {
      const exit = yield* makePlan(
        Effect.gen(function* () {
          const A = yield* NoPrecreateBindingTarget("A", { string: "a" });
          const B = yield* NoPrecreateBindingTarget("B", { string: "b" });
          const C = yield* NoPrecreateBindingTarget("C", { string: "c" });

          yield* A.bind("FromC", { env: { PEER: C.string } });
          yield* B.bind("FromA", { env: { PEER: A.string } });
          yield* C.bind("FromB", { env: { PEER: B.string } });

          return { A, B, C };
        }),
      ).pipe(Effect.exit);

      const err = extractCycleDefect(exit);
      expect(err).toBeDefined();
      expect(err!._tag).toBe("UnsatisfiedResourceCycle");
      expect(err!.cycle.sort()).toEqual(["A", "B", "C"]);
      expect(err!.missingPrecreate.sort()).toEqual(["A", "B", "C"]);
    }),
  );

  test(
    "acyclic binding graph succeeds even without precreate",
    Effect.gen(function* () {
      const exit = yield* makePlan(
        Effect.gen(function* () {
          const A = yield* NoPrecreateBindingTarget("A", {
            string: "a-value",
          });
          const B = yield* NoPrecreateBindingTarget("B", {
            string: A.string,
          });

          yield* B.bind("FromA", { env: { PEER: A.string } });

          return { A, B };
        }),
      ).pipe(Effect.exit);

      expect(Exit.isSuccess(exit)).toBe(true);
    }),
  );
});

describe("unresolved plan inputs in diff should conservatively update", () => {
  test(
    "update when upstream resource is new and downstream news contains exprs",
    Effect.gen(function* () {
      yield* seed({
        B: {
          instanceId,
          providerVersion: 0,
          logicalId: "B",
          fqn: "B",
          namespace: undefined,
          resourceType: "Test.TestResource",
          status: "created",
          props: {
            string: "old-value",
          },
          attr: {
            string: "old-value",
            stableString: "B",
            stableArray: ["B"],
          },
          downstream: [],
          bindings: [],
        },
      });
      const plan = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "hello",
        });
        yield* TestResource("B", {
          string: A.string,
        });
      }).pipe(makePlan);

      expect(plan.resources.A.action).toBe("create");
      expect(plan.resources.B.action).toBe("update");
    }),
  );
});

describe("Config props are resolved through plan", () => {
  test(
    "a Config prop is resolved to its concrete value in the plan",
    Effect.gen(function* () {
      const plan = yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: Config.succeed("resolved-config-value") as any,
        });
      }).pipe(makePlan);

      const node: any = plan.resources.A!;
      expect(node.action).toBe("create");
      const props = node.props as TestResourceProps;
      expect(Config.isConfig(props.string)).toBe(false);
      expect(props.string).toBe("resolved-config-value");
    }),
  );

  test(
    "a Config resolving to a Redacted keeps it wrapped in the plan",
    Effect.gen(function* () {
      const plan = yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "x",
          redacted: Config.succeed(Redacted.make("hunter2")) as any,
        });
      }).pipe(makePlan);

      const node: any = plan.resources.A!;
      expect(node.action).toBe("create");
      const props = node.props as TestResourceProps;
      expect(Redacted.isRedacted(props.redacted)).toBe(true);
      expect(Redacted.value(props.redacted!)).toBe("hunter2");
    }),
  );

  test(
    "a Config nested inside an object prop is resolved in the plan",
    Effect.gen(function* () {
      const plan = yield* Effect.gen(function* () {
        yield* TestResource("A", {
          object: { string: Config.succeed("nested") as any },
        });
      }).pipe(makePlan);

      const node: any = plan.resources.A!;
      expect(node.action).toBe("create");
      const props = node.props as TestResourceProps;
      expect(props.object).toEqual({ string: "nested" });
    }),
  );
});

describe("Redacted props/outputs are preserved through plan", () => {
  test(
    "Redacted prop on a new resource is preserved as a Redacted in the plan",
    Effect.gen(function* () {
      const plan = yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "x",
          redacted: Redacted.make("hunter2"),
        });
      }).pipe(makePlan);

      const node: any = plan.resources.A!;
      expect(node.action).toBe("create");
      const props = node.props as TestResourceProps;
      expect(Redacted.isRedacted(props.redacted)).toBe(true);
      expect(Redacted.value(props.redacted!)).toBe("hunter2");
    }),
  );

  test(
    "Redacted prop nested inside an array is preserved through the plan",
    Effect.gen(function* () {
      const plan = yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "x",
          redactedArray: [Redacted.make("a"), Redacted.make("b")],
        });
      }).pipe(makePlan);

      const node: any = plan.resources.A!;
      expect(node.action).toBe("create");
      const props = node.props as TestResourceProps;
      expect(props.redactedArray).toBeDefined();
      expect(props.redactedArray!.length).toBe(2);
      expect(Redacted.isRedacted(props.redactedArray![0]!)).toBe(true);
      expect(Redacted.isRedacted(props.redactedArray![1]!)).toBe(true);
      expect(Redacted.value(props.redactedArray![0]!)).toBe("a");
      expect(Redacted.value(props.redactedArray![1]!)).toBe("b");
    }),
  );

  test(
    "no-op when prior state has the same Redacted value",
    Effect.gen(function* () {
      yield* seed({
        A: {
          instanceId,
          providerVersion: 0,
          logicalId: "A",
          fqn: "A",
          namespace: undefined,
          resourceType: "Test.TestResource",
          status: "created",
          props: {
            string: "x",
            redacted: Redacted.make("hunter2"),
          },
          attr: {
            string: "x",
            stringArray: [],
            stableString: "A",
            stableArray: ["A"],
            replaceString: undefined,
            redacted: Redacted.make("hunter2"),
            redactedArray: undefined,
          },
          downstream: [],
          bindings: [],
        },
      });
      const plan = yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "x",
          redacted: Redacted.make("hunter2"),
        });
      }).pipe(makePlan);

      expect(plan.resources.A!.action).toBe("noop");
    }),
  );

  test(
    "update when Redacted prop value changes",
    Effect.gen(function* () {
      yield* seed({
        A: {
          instanceId,
          providerVersion: 0,
          logicalId: "A",
          fqn: "A",
          namespace: undefined,
          resourceType: "Test.TestResource",
          status: "created",
          props: {
            string: "x",
            redacted: Redacted.make("old"),
          },
          attr: {
            string: "x",
            stringArray: [],
            stableString: "A",
            stableArray: ["A"],
            replaceString: undefined,
            redacted: Redacted.make("old"),
            redactedArray: undefined,
          },
          downstream: [],
          bindings: [],
        },
      });
      const plan = yield* Effect.gen(function* () {
        yield* TestResource("A", {
          string: "x",
          redacted: Redacted.make("new"),
        });
      }).pipe(makePlan);

      expect(plan.resources.A!.action).toBe("update");
      const node: any = plan.resources.A!;
      const props = node.props as TestResourceProps;
      expect(Redacted.isRedacted(props.redacted)).toBe(true);
      expect(Redacted.value(props.redacted!)).toBe("new");
    }),
  );

  test(
    "Redacted output flowing into a downstream resource preserves its redaction",
    Effect.gen(function* () {
      yield* seed({
        A: {
          instanceId,
          providerVersion: 0,
          logicalId: "A",
          fqn: "A",
          namespace: undefined,
          resourceType: "Test.TestResource",
          status: "created",
          props: {
            string: "x",
            redacted: Redacted.make("hunter2"),
          },
          attr: {
            string: "x",
            stringArray: [],
            stableString: "A",
            stableArray: ["A"],
            replaceString: undefined,
            redacted: Redacted.make("hunter2"),
            redactedArray: undefined,
          },
          downstream: [],
          bindings: [],
        },
      });
      const plan = yield* Effect.gen(function* () {
        const A = yield* TestResource("A", {
          string: "x",
          redacted: Redacted.make("hunter2"),
        });
        yield* TestResource("B", {
          string: "y",
          redacted: A.redacted as any,
        });
      }).pipe(makePlan);

      const bNode: any = plan.resources.B!;
      const bProps = bNode.props as TestResourceProps;
      expect(Redacted.isRedacted(bProps.redacted)).toBe(true);
      expect(Redacted.value(bProps.redacted!)).toBe("hunter2");
    }),
  );
});

describe("engine-level adoption", () => {
  // Build a plan, optionally with an explicit AdoptPolicy and a read hook
  // that simulates a pre-existing cloud resource.
  const ownedAttrs: TestResource["Attributes"] = {
    string: "hello",
    stringArray: [],
    stableString: "Adopted",
    stableArray: ["Adopted"],
    replaceString: undefined,
    redacted: undefined,
    redactedArray: undefined,
  };

  const makeAdoptPlan = <A>(
    effect: Effect.Effect<A, any, any>,
    opts: {
      adopt?: boolean;
      readHook?: (
        id: string,
      ) => Effect.Effect<TestResource["Attributes"] | undefined, any>;
    },
  ): Effect.Effect<Plan.Plan<A>, any, State> =>
    Effect.gen(function* () {
      const { name, stage } = yield* resolveStackId;
      const hooksLayer = opts.readHook
        ? Layer.succeed(TestResourceHooks, { read: opts.readHook })
        : Layer.empty;
      const adoptLayer =
        opts.adopt === undefined
          ? Layer.empty
          : Layer.succeed(AdoptPolicy, opts.adopt);
      return yield* (effect as Effect.Effect<A, any, any>).pipe(
        Stack.make({
          name,
          providers: Layer.empty,
          state: inMemoryState(),
        } as any) as any,
        Effect.provideService(Stage, stage),
        Effect.flatMap((stackSpec: any) => Plan.make(stackSpec)),
        Effect.provide(TestLayers()),
        Effect.provide(hooksLayer),
        Effect.provide(adoptLayer),
      ) as Effect.Effect<Plan.Plan<A>, any, State>;
    }) as Effect.Effect<Plan.Plan<A>, any, State>;

  test(
    "owned read result is silently adopted (no AdoptPolicy needed) and forced to update",
    Effect.gen(function* () {
      const plan = yield* makeAdoptPlan(
        Effect.gen(function* () {
          yield* TestResource("Adopted", { string: "hello" });
        }),
        { readHook: () => Effect.succeed(ownedAttrs) },
      );

      // Cold-start adoption forces an update so the provider can re-sync
      // tags / config against `news` — even when read returns plain
      // (owned) attrs, the cloud resource may carry drift the engine
      // can't detect from `props` alone.
      expect(plan.resources.Adopted!.action).toBe("update");

      // Planning no longer persists the adopted state (issue #793): it rides
      // on the plan node and is only committed to the store at apply time.
      const node = plan.resources.Adopted!;
      expect(node.state?.status).toBe("created");
      expect((node.state as any)?.attr).toMatchObject({ string: "hello" });

      const state = yield* yield* State;
      expect(
        yield* state.get({
          stack: TEST_STACK,
          stage: TEST_STAGE,
          fqn: "Adopted",
        }),
      ).toBeUndefined();
    }),
  );

  test(
    "Unowned read result + adopt enabled -> takeover forces an update",
    Effect.gen(function* () {
      const plan = yield* makeAdoptPlan(
        Effect.gen(function* () {
          yield* TestResource("Adopted", { string: "hello" });
        }),
        {
          adopt: true,
          readHook: () => Effect.succeed(Unowned(ownedAttrs)),
        },
      );

      // Takeover of an Unowned resource forces `update` so the provider's
      // update path can rewrite ownership tags / config to match this
      // logical id (a plain noop would leave the resource looking
      // foreign-owned to subsequent deploys).
      expect(plan.resources.Adopted!.action).toBe("update");

      // The adopted state rides on the plan node, not the store (issue #793).
      const node = plan.resources.Adopted!;
      expect(node.state?.status).toBe("created");

      // The Unowned brand must be fully scrubbed from anything that
      // reaches the plan node (and, at apply, the state store) — both via
      // the public `Unowned.is` check *and* via direct symbol inspection
      // (in case someone accidentally uses `Symbol.for` rather than
      // `Unowned.is`).
      const adoptedAttr = (node.state as any)?.attr as object;
      expect(Unowned.is(adoptedAttr)).toBe(false);
      expect(Object.getOwnPropertySymbols(adoptedAttr).length).toBe(0);
      expect(JSON.stringify(adoptedAttr)).not.toContain("Unowned");

      // Planning wrote nothing to the store.
      const state = yield* yield* State;
      expect(
        yield* state.get({
          stack: TEST_STACK,
          stage: TEST_STAGE,
          fqn: "Adopted",
        }),
      ).toBeUndefined();
    }),
  );

  test(
    "Unowned read result + adopt disabled -> OwnedBySomeoneElse",
    Effect.gen(function* () {
      const exit = yield* makeAdoptPlan(
        Effect.gen(function* () {
          yield* TestResource("Foreign", { string: "hello" });
        }),
        {
          adopt: false,
          readHook: () => Effect.succeed(Unowned(ownedAttrs)),
        },
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons.find(Cause.isFailReason);
        expect((reason?.error as any)?._tag).toBe("OwnedBySomeoneElse");
        expect((reason?.error as any)?.resourceType).toBe("Test.TestResource");
      }
    }),
  );

  test(
    "read returns undefined -> ordinary create",
    Effect.gen(function* () {
      const plan = yield* makeAdoptPlan(
        Effect.gen(function* () {
          yield* TestResource("Fresh", { string: "hello" });
        }),
        { readHook: () => Effect.succeed(undefined) },
      );

      expect(plan.resources.Fresh!.action).toBe("create");
      expect(plan.resources.Fresh!.state).toBeUndefined();
    }),
  );

  test(
    "Unowned read result + resource-scoped adopt(true) -> takeover even when the stack default is disabled",
    Effect.gen(function* () {
      const plan = yield* makeAdoptPlan(
        Effect.gen(function* () {
          yield* TestResource("Adopted", { string: "hello" }).pipe(adopt(true));
        }),
        {
          // Stack/CLI default is OFF — only the per-resource scope opts in.
          adopt: false,
          readHook: () => Effect.succeed(Unowned(ownedAttrs)),
        },
      );

      expect(plan.resources.Adopted!.action).toBe("update");

      // Adopted state rides on the plan node; planning persists nothing
      // (issue #793).
      const node = plan.resources.Adopted!;
      expect(node.state?.status).toBe("created");

      const state = yield* yield* State;
      expect(
        yield* state.get({
          stack: TEST_STACK,
          stage: TEST_STAGE,
          fqn: "Adopted",
        }),
      ).toBeUndefined();
    }),
  );

  test(
    "Unowned read result + resource-scoped adopt(false) -> OwnedBySomeoneElse even when the stack default is enabled",
    Effect.gen(function* () {
      const exit = yield* makeAdoptPlan(
        Effect.gen(function* () {
          yield* TestResource("Foreign", { string: "hello" }).pipe(
            adopt(false),
          );
        }),
        {
          // Stack/CLI default is ON, but the resource opts out.
          adopt: true,
          readHook: () => Effect.succeed(Unowned(ownedAttrs)),
        },
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const reason = exit.cause.reasons.find(Cause.isFailReason);
        expect((reason?.error as any)?._tag).toBe("OwnedBySomeoneElse");
        expect((reason?.error as any)?.resourceType).toBe("Test.TestResource");
      }
    }),
  );

  test(
    "providers without a `read` method skip the adoption probe entirely",
    Effect.gen(function* () {
      // Bucket has no `read` implementation. The engine should fall back
      // to a normal `create` action without any side effects.
      const plan = yield* makeAdoptPlan(
        Effect.gen(function* () {
          yield* Bucket("FreshBucket", { name: "fresh" });
        }),
        { adopt: true },
      );

      expect(plan.resources.FreshBucket!.action).toBe("create");
    }),
  );
});

describe("RefExpr resolution", () => {
  const seedAt = (
    stack: string,
    stage: string,
    resources: Record<string, ResourceState>,
  ) =>
    Effect.gen(function* () {
      const state = yield* yield* State;
      for (const [fqn, value] of Object.entries(resources)) {
        yield* state.set({ stack, stage, fqn, value });
      }
    });

  const sharedAttr = {
    string: "shared-string",
    stringArray: ["shared"],
    stableString: "shared-stable",
    stableArray: ["shared-stable"],
    replaceString: undefined,
    redacted: undefined,
    redactedArray: undefined,
  };

  const sharedResourceState = {
    instanceId,
    providerVersion: 0,
    logicalId: "Shared",
    fqn: "Shared",
    namespace: undefined,
    resourceType: "Test.TestResource",
    status: "created" as ResourceStatus,
    props: { string: "shared-string" },
    attr: sharedAttr,
    bindings: [],
    downstream: [],
  } as ResourceState;

  test(
    "resolves a cross-stage Ref to the seeded resource's attributes",
    Effect.gen(function* () {
      yield* seedAt(TEST_STACK, "other", { Shared: sharedResourceState });
      const plan = yield* Effect.gen(function* () {
        const shared = yield* TestResource.ref("Shared", { stage: "other" });
        yield* TestResource("Consumer", { string: shared.string });
      }).pipe(makePlan);

      expect(plan.resources.Consumer?.action).toBe("create");
      expect((plan.resources.Consumer as any)?.props).toMatchObject({
        string: "shared-string",
      });
    }),
  );

  test(
    "resolves a cross-stack Ref using the explicit stack option",
    Effect.gen(function* () {
      yield* seedAt("other-stack", TEST_STAGE, {
        Shared: sharedResourceState,
      });
      const plan = yield* Effect.gen(function* () {
        const shared = yield* TestResource.ref("Shared", {
          stack: "other-stack",
        });
        yield* TestResource("Consumer", {
          string: shared.string,
        });
      }).pipe(makePlan);

      expect((plan.resources.Consumer as any)?.props).toMatchObject({
        string: "shared-string",
      });
    }),
  );

  test(
    "Ref to a resource in the current stack/stage is resolved",
    Effect.gen(function* () {
      yield* seed({ Shared: sharedResourceState });
      const plan = yield* Effect.gen(function* () {
        const shared = yield* TestResource.ref("Shared");
        yield* TestResource("Consumer", { string: shared.string });
      }).pipe(makePlan);

      expect((plan.resources.Consumer as any)?.props).toMatchObject({
        string: "shared-string",
      });
    }),
  );

  test(
    "missing Ref target dies with InvalidReferenceError",
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const shared = yield* TestResource.ref("Ghost", { stage: "other" });
          yield* TestResource("Consumer", { string: shared.string });
        }).pipe(makePlan),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause) as Output.InvalidReferenceError;
        expect(err._tag).toBe("InvalidReferenceError");
        expect(err.resourceId).toBe("Ghost");
        expect(err.stage).toBe("other");
      }
    }),
  );
});

describe("StackRefExpr resolution", () => {
  const setStackOutput = (stack: string, stage: string, value: unknown) =>
    Effect.gen(function* () {
      const state = yield* yield* State;
      yield* state.setOutput({ stack, stage, value });
    });

  test(
    "resolves an Output.stackRef to the persisted stack output",
    Effect.gen(function* () {
      yield* setStackOutput("Backend", TEST_STAGE, {
        url: "https://api.example.com",
      });
      const plan = yield* Effect.gen(function* () {
        const backend = yield* Output.stackRef<{ url: string }>("Backend");
        yield* TestResource("Consumer", {
          string: (backend as any).url,
        });
      }).pipe(makePlan);

      expect(plan.resources.Consumer?.action).toBe("create");
      expect((plan.resources.Consumer as any)?.props).toMatchObject({
        string: "https://api.example.com",
      });
    }),
  );

  test(
    "resolves an explicit stage on the stackRef",
    Effect.gen(function* () {
      yield* setStackOutput("Backend", "prod", {
        url: "https://prod.example.com",
      });
      const plan = yield* Effect.gen(function* () {
        const backend = yield* Output.stackRef<{ url: string }>("Backend", {
          stage: "prod",
        });
        yield* TestResource("Consumer", {
          string: (backend as any).url,
        });
      }).pipe(makePlan);

      expect((plan.resources.Consumer as any)?.props).toMatchObject({
        string: "https://prod.example.com",
      });
    }),
  );

  test(
    "missing stack output dies with InvalidReferenceError",
    Effect.gen(function* () {
      const exit = yield* Effect.exit(
        Effect.gen(function* () {
          const backend = yield* Output.stackRef<{ url: string }>("Backend", {
            stage: "ghost",
          });
          yield* TestResource("Consumer", {
            string: (backend as any).url,
          });
        }).pipe(makePlan),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const err = Cause.squash(exit.cause) as Output.InvalidReferenceError;
        expect(err._tag).toBe("InvalidReferenceError");
        expect(err.stack).toBe("Backend");
        expect(err.stage).toBe("ghost");
      }
    }),
  );
});

describe("type aliases", () => {
  // State rows persisted before a type rename carry the legacy name
  // ("Test.Widget"). Provider lookup must fall back to the canonical type
  // ("Test.Widgets.Widget") via the alias declared on the resource.
  const legacyWidgetState = (fqn: string): ResourceState => ({
    instanceId,
    providerVersion: 0,
    logicalId: fqn,
    fqn,
    namespace: undefined,
    resourceType: "Test.Widget",
    status: "created",
    props: {
      name: "widget",
    },
    attr: {
      name: "widget",
    },
    bindings: [],
    downstream: [],
  });

  test(
    "orphan persisted under a legacy type name plans a delete via alias",
    Effect.gen(function* () {
      yield* seed({ LegacyOrphan: legacyWidgetState("LegacyOrphan") });
      expect(
        yield* makePlan(Effect.void).pipe(
          Effect.provide(aliasedWidgetProvider()),
        ),
      ).toMatchObject({
        deletions: {
          LegacyOrphan: {
            action: "delete",
            resource: {
              LogicalId: "LegacyOrphan",
              Type: "Test.Widget",
            },
          },
        },
      });
    }),
  );

  test(
    "declared resource with legacy-typed state plans as a noop update",
    Effect.gen(function* () {
      yield* seed({ MyWidget: legacyWidgetState("MyWidget") });
      const plan = yield* makePlan(
        Effect.gen(function* () {
          yield* AliasedWidget("MyWidget", { name: "widget" });
        }),
      ).pipe(Effect.provide(aliasedWidgetProvider()));
      expect(plan).toMatchObject({
        resources: {
          MyWidget: {
            action: "noop",
            state: {
              resourceType: "Test.Widget",
            },
          },
        },
      });
      expect(Object.keys(plan.deletions)).toEqual([]);
    }),
  );

  describe("via provider collection", () => {
    class AliasPlanProviders extends Provider.ProviderCollection<AliasPlanProviders>()(
      "Test.AliasPlanProviders",
    ) {}

    // The bare provider layer is consumed while building the collection and
    // is NOT exported — lookup can only succeed through the collection.
    const widgetCollection = () =>
      Layer.effect(
        AliasPlanProviders,
        Provider.collection([AliasedWidget]),
      ).pipe(Layer.provide(aliasedWidgetProvider()));

    test(
      "orphan persisted under a legacy type name plans a delete via alias",
      Effect.gen(function* () {
        yield* seed({ LegacyOrphan: legacyWidgetState("LegacyOrphan") });
        expect(
          yield* makePlan(Effect.void).pipe(Effect.provide(widgetCollection())),
        ).toMatchObject({
          deletions: {
            LegacyOrphan: {
              action: "delete",
              resource: {
                LogicalId: "LegacyOrphan",
                Type: "Test.Widget",
              },
            },
          },
        });
      }),
    );
  });
});

describe("zombie rows", () => {
  // A state row whose resource type has no registered provider (the type
  // was removed from the program, or renamed without an alias) is FATAL:
  // the program and state disagree, and without the provider the row's
  // physical resource cannot be deleted anyway. Planning dies with a typed
  // MissingProviderError naming the row and the remediation (see
  // destroy-robustness.test.ts for the deploy/destroy behavior).
  test(
    "a row whose resource type has no provider fails the plan",
    Effect.gen(function* () {
      yield* seed({
        Ghost: {
          instanceId,
          providerVersion: 0,
          logicalId: "Ghost",
          fqn: "Ghost",
          namespace: undefined,
          resourceType: "Test.Vanished",
          status: "created",
          props: { name: "ghost" },
          attr: { name: "ghost" },
          bindings: [],
          downstream: [],
        },
      });
      const exit = yield* makePlan(
        Effect.gen(function* () {
          yield* Bucket("Survivor", { name: "survivor" });
        }),
      ).pipe(Effect.exit);

      expect(Exit.isFailure(exit)).toBe(true);
      const defect = Exit.isFailure(exit)
        ? exit.cause.reasons.find(
            (r) =>
              Cause.isDieReason(r) &&
              r.defect instanceof Provider.MissingProviderError,
          )
        : undefined;
      expect(defect && Cause.isDieReason(defect)).toBe(true);
      if (defect && Cause.isDieReason(defect)) {
        const error = defect.defect as Provider.MissingProviderError;
        expect(error.resourceType).toBe("Test.Vanished");
        expect(error.fqn).toBe("Ghost");
        expect(error.message).toContain("aliases");
      }
    }),
  );
});

describe("read is never handed unresolved persisted props", () => {
  // A failed create persists `creating` state carrying the RAW plan-time
  // props, which may contain unresolved Output expressions (e.g. a prop
  // referencing an upstream resource that was never created). Providers
  // derive identity from `olds` inside `read` when `output` is undefined,
  // so the engine must skip the read probe entirely rather than hand it
  // unresolved exprs (see the isResolved guards in Plan.ts).

  const creatingWithUnresolvedProps = (fqn: string): ResourceState => ({
    instanceId,
    providerVersion: 0,
    logicalId: fqn,
    fqn,
    namespace: undefined,
    resourceType: "Test.TestResource",
    status: "creating",
    props: {
      // an unresolved Output expression, exactly as persisted by a create
      // that failed before its upstream dependencies resolved
      string: Output.literal("unresolved") as any,
    },
    attr: undefined,
    bindings: [],
    downstream: [],
  });

  const trackReads = () => {
    const reads: string[] = [];
    const layer = Layer.succeed(TestResourceHooks, {
      read: (id: string) =>
        Effect.sync(() => {
          reads.push(id);
          return undefined;
        }),
    });
    return { reads, layer };
  };

  test(
    "destroy after failed create with unresolved props skips read and deletes with attr undefined",
    Effect.gen(function* () {
      yield* seed({ Zombie: creatingWithUnresolvedProps("Zombie") });
      const { reads, layer } = trackReads();
      const plan = yield* makePlan(Effect.void).pipe(Effect.provide(layer));
      expect(reads).not.toContain("Zombie");
      expect(plan.deletions.Zombie).toMatchObject({ action: "delete" });
      expect((plan.deletions.Zombie as any).state.attr).toBeUndefined();
    }),
  );

  test(
    "creating-state recovery with unresolved persisted props skips the read probe and re-drives create",
    Effect.gen(function* () {
      yield* seed({ Half: creatingWithUnresolvedProps("Half") });
      const { reads, layer } = trackReads();
      const plan = yield* makePlan(
        Effect.gen(function* () {
          yield* TestResource("Half", { string: "resolved-now" });
        }),
      ).pipe(Effect.provide(layer));
      expect(reads).not.toContain("Half");
      expect(plan.resources.Half!.action).toBe("create");
    }),
  );

  test(
    "destroy of a creating row defers read recovery to apply even with resolved props",
    Effect.gen(function* () {
      // Plan never probes a deleted attr-less row — resolved or not. Apply's
      // `deleteResource` owns the authoritative read-then-delete recovery
      // (it also covers replaced-chain old generations that never pass
      // through plan); see the apply.test.ts destroy-recovery cases.
      yield* seed({
        Zombie: {
          ...creatingWithUnresolvedProps("Zombie"),
          props: { string: "resolved" },
        },
      });
      const { reads, layer } = trackReads();
      const plan = yield* makePlan(Effect.void).pipe(Effect.provide(layer));
      expect(reads).not.toContain("Zombie");
      expect(plan.deletions.Zombie).toMatchObject({ action: "delete" });
      expect((plan.deletions.Zombie as any).state.attr).toBeUndefined();
    }),
  );

  test(
    "resolved persisted creating props still go through read recovery when re-declared (control)",
    Effect.gen(function* () {
      yield* seed({
        Half: {
          ...creatingWithUnresolvedProps("Half"),
          props: { string: "resolved" },
        },
      });
      const { reads, layer } = trackReads();
      const plan = yield* makePlan(
        Effect.gen(function* () {
          yield* TestResource("Half", { string: "resolved-now" });
        }),
      ).pipe(Effect.provide(layer));
      expect(reads).toContain("Half");
      expect(plan.resources.Half!.action).toBe("create");
    }),
  );
});
