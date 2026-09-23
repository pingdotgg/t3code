/**
 * Destroy/state consistency: a destroy that cannot see the stack's
 * persisted state must FAIL LOUDLY — never report "no changes" and leak
 * the stack's cloud resources.
 *
 * Regression coverage for the 2026-08-05 full-suite leak: two Cloudflare
 * test stacks' `afterAll destroy(Stack)` planned "no changes" while their
 * committed localState rows sat on disk, silently leaking 3 real workers.
 * The destroy session behaved as if pointed at an empty state tree for its
 * entire lifetime (plan list, row gets, and the final `deleteStack` all
 * missed), so the engine now:
 *
 *  1. anchors the local state tree to the process's INITIAL working
 *     directory (captured at module load) so no session can be built
 *     against a different tree,
 *  2. cross-checks directory-level NotFound answers in LocalState with a
 *     synchronous `existsSync` before degrading to "empty",
 *  3. verifies after every destroy that the stage is actually empty, and
 *     fails with `StateStoreError` when rows survive.
 */
import { apply } from "@/Apply.ts";
import { provideFreshArtifactStore } from "@/Artifacts";
import * as Plan from "@/Plan.ts";
import { Stack } from "@/Stack";
import * as State from "@/State/index";
import { makeLocalState } from "@/State/LocalState.ts";
import { Stage } from "@/Stage.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { TestLayers, TestResourceHooks } from "../test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

const STAGE = "test";
const instanceId = "852f6ec2e19b66589825efe14dca2971";

const row = (fqn: string): State.ResourceState =>
  ({
    instanceId,
    providerVersion: 0,
    logicalId: fqn,
    fqn,
    namespace: undefined,
    resourceType: "Test.TestResource",
    status: "created",
    props: { string: "a" },
    attr: {
      string: "a",
      stringArray: [],
      stableString: fqn,
      stableArray: [fqn],
      replaceString: undefined,
      redacted: undefined,
      redactedArray: undefined,
    },
    bindings: [],
    downstream: [],
  }) as State.ResourceState;

/** Run `Plan.destroy -> apply` against an explicit state layer. */
const runDestroy = (
  stackName: string,
  stateLayer: Layer.Layer<State.State, never, never>,
  deleted: string[],
) =>
  Plan.destroy({ name: stackName, stage: STAGE }).pipe(
    Effect.flatMap(apply),
    Effect.asVoid,
    Effect.provide(stateLayer),
    Effect.provide(TestLayers() as Layer.Layer<any, never, any>),
    Effect.provide(
      Layer.succeed(TestResourceHooks, {
        delete: (id) => Effect.sync(() => void deleted.push(id)),
      }),
    ),
    Effect.provide(
      Layer.succeed(Stack, {
        name: stackName,
        stage: STAGE,
        resources: {},
        bindings: {},
        actions: {},
      }),
    ),
    Effect.provide(Layer.succeed(Stage, STAGE)),
    provideFreshArtifactStore,
  ) as Effect.Effect<void, any, never>;

const stateStoreErrorOf = (
  exit: Exit.Exit<unknown, unknown>,
): State.StateStoreError | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const error = Cause.squash(exit.cause);
  return error instanceof State.StateStoreError ? error : undefined;
};

test(
  "a destroy that cannot see committed state fails loudly instead of reporting success",
  Effect.gen(function* () {
    const stackName = "destroy-consistency-blind-session";
    const inner = yield* State.InMemoryService({
      [stackName]: { [STAGE]: { A: row("A") } },
    });

    // Simulate the observed failure: the store answers "no state" for the
    // whole destroy session (plan lists nothing, deleteStack silently
    // deletes nothing) and only recovers afterwards — the shape of a
    // transient state outage or a mispointed session.
    let blind = true;
    const flaky: State.StateService = {
      ...inner,
      list: (req) => (blind ? Effect.succeed([]) : inner.list(req)),
      deleteStack: (req) =>
        blind
          ? Effect.sync(() => {
              // The outage "ends" right after the swallowed deleteStack, so
              // the engine's post-destroy verification reads honest state.
              blind = false;
            })
          : inner.deleteStack(req),
    };
    const flakyLayer = Layer.succeed(State.State, Effect.succeed(flaky));

    const deleted: string[] = [];
    const exit = yield* runDestroy(stackName, flakyLayer, deleted).pipe(
      Effect.exit,
    );

    // The destroy must NOT report success: its plan saw no rows, so the
    // provider never deleted the cloud resource — reporting success here
    // is exactly the silent-leak bug.
    const error = stateStoreErrorOf(exit);
    expect(error?._tag).toBe("StateStoreError");
    expect(error?.message).toContain("state row(s) remain");
    expect(deleted).toEqual([]);
    // The row survives for the next (healthy) destroy to reclaim.
    expect(
      yield* inner.get({ stack: stackName, stage: STAGE, fqn: "A" }),
    ).toBeDefined();

    // A healthy session then destroys normally: provider delete runs, the
    // row is dropped, and the post-destroy verification passes.
    yield* runDestroy(stackName, flakyLayer, deleted);
    expect(deleted).toEqual(["A"]);
    expect(
      yield* inner.get({ stack: stackName, stage: STAGE, fqn: "A" }),
    ).toBeUndefined();
  }),
);

test(
  "local state is anchored to the process's initial cwd, not the cwd at store build",
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stackName = "destroy-consistency-cwd-anchor";
    const writer = yield* makeLocalState();
    yield* writer.set({
      stack: stackName,
      stage: STAGE,
      fqn: "A",
      value: row("A"),
    });

    const tmp = yield* fs.makeTempDirectory({ prefix: "alchemy-cwd-anchor" });
    const original = yield* Effect.sync(() => process.cwd());
    yield* Effect.gen(function* () {
      yield* Effect.sync(() => process.chdir(tmp));
      // A store built while the process cwd points elsewhere must still
      // resolve the same state tree — a destroy building its store during
      // a transient cwd excursion would otherwise see an empty tree and
      // plan "no changes" over live state.
      const reader = yield* makeLocalState();
      expect(yield* reader.list({ stack: stackName, stage: STAGE })).toEqual([
        "A",
      ]);
    }).pipe(Effect.ensuring(Effect.sync(() => process.chdir(original))));

    yield* writer.deleteStack({ stack: stackName });
  }),
  // mutates process-global cwd
  { exclusive: true },
);
