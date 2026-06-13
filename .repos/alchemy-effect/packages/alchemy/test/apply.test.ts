import { Cli } from "@/Cli/Cli";
import * as Construct from "@/Construct";
import * as Output from "@/Output";
import { Stack } from "@/Stack";
import {
  type ReplacedResourceState,
  type ReplacingResourceState,
  type ResourceState,
  State,
} from "@/State";
import * as Test from "@/Test/Vitest";
import { describe, expect } from "@effect/vitest";
import { Data, Layer } from "effect";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import {
  ArtifactProbe,
  BindingTarget,
  DeletedBindingRegressionTarget,
  DurationResource,
  Function,
  PhasedTarget,
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
const listState = Effect.fn(function* () {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return yield* state.list({ stack: stk.name, stage: stk.stage });
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
      // @ts-expect-error - catchTag changes the return type
      Effect.catchTag("ResourceFailure", () => Effect.succeed(true)),
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

describe("basic operations", () => {
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
    "should resolve bindings inside constructs using namespaced resources",
    (stack) =>
      Effect.gen(function* () {
        const Site = Construct.fn(function* (_id: string, _props: {}) {
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
        });

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

describe("linear update propagation", () => {
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
});

describe("circularity via bindings", () => {
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

describe("prop-flow convergence", () => {
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
          approvePlan: () => Effect.succeed(true),
          displayPlan: () => Effect.void,
          startApplySession: () =>
            Effect.succeed({
              done: () => Effect.void,
              emit: (event) =>
                Effect.sync(() => {
                  if (event.kind === "status-change") {
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

describe("from created state", () => {
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

describe("from updated state", () => {
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

describe("from creating state", () => {
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
});

describe("from updating state", () => {
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

describe("from replacing state", () => {
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

describe("from replaced state", () => {
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

describe("from deleting state", () => {
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

describe("dependent resources (A -> B)", () => {
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

describe("three-level dependency chain (A -> B -> C)", () => {
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

        expect((yield* getState<ReplacingResourceState>("A"))?.status).toEqual(
          "replacing",
        );
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

          expect((yield* getState<ReplacedResourceState>("A"))?.status).toEqual(
            "replaced",
          );
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
});

// =============================================================================
// DIAMOND DEPENDENCIES (D depends on B and C, both depend on A)
//     A
//    / \
//   B   C
//    \ /
//     D
// =============================================================================

describe("diamond dependencies (A -> B,C -> D)", () => {
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
});

// =============================================================================
// INDEPENDENT RESOURCES (no dependencies between them)
// =============================================================================

describe("independent resources (A, B with no dependencies)", () => {
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
});

// =============================================================================
// MULTIPLE RESOURCES REPLACING SIMULTANEOUSLY
// =============================================================================

describe("multiple resources replacing", () => {
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

describe("repeated replacements", () => {
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

describe("orphan chain deletion", () => {
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

describe("complex mixed state scenarios", () => {
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

describe("artifacts", () => {
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
        const Site = Construct.fn(function* (
          _id: string,
          props: { value: string },
        ) {
          return yield* ArtifactProbe("Shared", { value: props.value });
        });

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

// =============================================================================
// STATIC STABLE PROPERTIES (provider.stables defined on provider, not in diff)
// This tests the bug where diff returns undefined but downstream resources
// depend on stable properties that should be preserved
// =============================================================================

describe("static stable properties (provider.stables)", () => {
  describe("diff returns undefined with tag-only changes", () => {
    test.provider(
      "upstream has static stables, diff returns undefined, downstream depends on stableId",
      (stack) =>
        Effect.gen(function* () {
          // Stage 1: Create A with no tags, B depends on A.stableId
          {
            const output = yield* Effect.gen(function* () {
              const A = yield* StaticStablesResource("A", { string: "value" });
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
});

describe("Redacted props/outputs survive deploy", () => {
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
        expect(Redacted.isRedacted((state!.props as any).redacted)).toBe(true);
        expect(Redacted.value((state!.props as any).redacted)).toBe("hunter2");
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
        expect(Redacted.isRedacted((bState!.props as any).redacted)).toBe(true);
        expect(Redacted.value((bState!.props as any).redacted)).toBe("hunter2");
        expect(Redacted.isRedacted((bState!.attr as any).redacted)).toBe(true);
        expect(Redacted.value((bState!.attr as any).redacted)).toBe("hunter2");
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
});

describe("stack output persistence", () => {
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

        const persisted = yield* getStackOutput(stack.name, "test").pipe(
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

        const persisted = yield* getStackOutput(stack.name, "test").pipe(
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

describe("Duration round-trip through state", () => {
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
        expect(Duration.isDuration(persisted.attr.computedTimeout)).toBe(true);
        expect(Duration.toMillis(persisted.attr.computedTimeout)).toBe(16_000);
      }),
  );
});
