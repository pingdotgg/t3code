import { Unowned } from "@/AdoptPolicy";
import type { ApplyEvent } from "@/Cli/Event";
import * as Namespace from "@/Namespace.ts";
import { Stack } from "@/Stack";
import { State, type ResourceState } from "@/State";
import * as Sync from "@/Sync";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  Bucket,
  DriftResource,
  makeTestCloud,
  ResourceFailure,
  TestCloud,
  TestLayers,
  TestResource,
  TestResourceHooks,
  failOn,
  type TestCloudService,
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

const seed = Effect.fn(function* (rows: Record<string, any>) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  for (const [fqn, value] of Object.entries(rows)) {
    yield* state.set({ stack: stk.name, stage: stk.stage, fqn, value });
  }
});

const runSync = (options?: Sync.SyncOptions) =>
  Effect.gen(function* () {
    const stk = yield* Stack;
    return yield* Sync.sync({ name: stk.name, stage: stk.stage }, options);
  });

const withCloud =
  (cloud: TestCloudService) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(Layer.succeed(TestCloud, cloud)));

const reconcileCalls = (cloud: TestCloudService) =>
  cloud.calls.filter((c) => c.op === "reconcile").map((c) => c.id);

const readCalls = (cloud: TestCloudService) =>
  cloud.calls.filter((c) => c.op === "read").map((c) => c.id);

const instanceId = "852f6ec2e19b66589825efe14dca2971";

describe("drift detection and repair", () => {
  test.provider(
    "clean deployment: every resource is unchanged and reconcile is not invoked",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* DriftResource("A", { value: "a" });
            yield* DriftResource("B", { value: "b" });
          }),
        );

        cloud.calls.length = 0;
        const result = yield* runSync();

        expect(result.resources).toMatchObject({
          A: { action: "unchanged", resourceType: "Test.DriftResource" },
          B: { action: "unchanged", resourceType: "Test.DriftResource" },
        });
        // sync observed both resources but touched neither
        expect(readCalls(cloud).sort()).toEqual(["A", "B"]);
        expect(reconcileCalls(cloud)).toEqual([]);
        // cloud and state are untouched
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
        expect((yield* getState("A"))?.status).toEqual("created");
      }).pipe(withCloud(cloud));
    },
  );

  test.provider(
    "out-of-band value drift is repaired back to the desired state",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(DriftResource("A", { value: "a" }));

        // someone edits the resource in the console
        cloud.resources.get("A")!.value = "hijacked";

        cloud.calls.length = 0;
        const result = yield* runSync();

        expect(result.resources.A).toMatchObject({
          action: "repaired",
          attr: { value: "a" },
        });
        // cloud converged back to the last-deployed desired state
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
        expect(reconcileCalls(cloud)).toEqual(["A"]);
        // state refreshed with the reconciled attributes
        expect(yield* getState("A")).toMatchObject({
          status: "updated",
          attr: { value: "a" },
          props: { value: "a" },
        });
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("nested tag drift is detected and repaired", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        DriftResource("A", { value: "a", tags: { team: "alchemy" } }),
      );

      // foreign tags appear and an owned tag is clobbered
      cloud.resources.get("A")!.tags = { team: "intruder", extra: "tag" };

      const result = yield* runSync();

      expect(result.resources.A?.action).toEqual("repaired");
      expect(cloud.resources.get("A")!.tags).toEqual({ team: "alchemy" });
      expect((yield* getState("A"))?.attr?.tags).toEqual({ team: "alchemy" });
    }).pipe(withCloud(cloud));
  });

  test.provider(
    "a resource deleted out-of-band is recreated under the same instance id",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(DriftResource("A", { value: "a" }));
        const before = yield* getState("A");

        // someone deletes the resource in the console
        cloud.resources.delete("A");

        const result = yield* runSync();

        expect(result.resources.A).toMatchObject({
          action: "recreated",
          attr: { id: "A", value: "a" },
        });
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
        expect(yield* getState("A")).toMatchObject({
          status: "created",
          // same instance id so deterministic physical names converge
          instanceId: before!.instanceId,
          attr: { value: "a" },
        });
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("sync is idempotent", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      cloud.resources.get("A")!.value = "hijacked";

      const first = yield* runSync();
      expect(first.resources.A?.action).toEqual("repaired");

      cloud.calls.length = 0;
      const second = yield* runSync();
      expect(second.resources.A?.action).toEqual("unchanged");
      expect(reconcileCalls(cloud)).toEqual([]);
    }).pipe(withCloud(cloud));
  });

  test.provider(
    "mixed fleet: only drifted and missing resources are reconciled",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* DriftResource("Clean", { value: "clean" });
            yield* DriftResource("Drifted", { value: "drifted" });
            yield* DriftResource("Missing", { value: "missing" });
          }),
        );

        cloud.resources.get("Drifted")!.value = "hijacked";
        cloud.resources.delete("Missing");

        cloud.calls.length = 0;
        const result = yield* runSync();

        expect(result.resources).toMatchObject({
          Clean: { action: "unchanged" },
          Drifted: { action: "repaired" },
          Missing: { action: "recreated" },
        });
        expect(reconcileCalls(cloud).sort()).toEqual(["Drifted", "Missing"]);
        expect(cloud.resources.get("Drifted")).toMatchObject({
          value: "drifted",
        });
        expect(cloud.resources.get("Missing")).toMatchObject({
          value: "missing",
        });
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("empty state: sync succeeds with no resources", () =>
    Effect.gen(function* () {
      const result = yield* runSync();
      expect(result.resources).toEqual({});
    }),
  );

  test.provider(
    "a provider whose read reflects state back never drifts",
    (stack) =>
      Effect.gen(function* () {
        // TestResource.read returns the persisted output when no hook is
        // installed — the degenerate "cannot observe drift" case.
        yield* stack.deploy(TestResource("A", { string: "test-string" }));
        const result = yield* runSync();
        expect(result.resources.A?.action).toEqual("unchanged");
      }),
  );
});

describe("dry run", () => {
  test.provider(
    "reports drift without repairing the cloud or touching state",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(DriftResource("A", { value: "a" }));
        cloud.resources.get("A")!.value = "hijacked";

        cloud.calls.length = 0;
        const result = yield* runSync({ dryRun: true });

        expect(result.resources.A).toMatchObject({
          action: "drifted",
          // dry-run reports the OBSERVED (drifted) attributes
          attr: { value: "hijacked" },
        });
        expect(reconcileCalls(cloud)).toEqual([]);
        // neither the cloud nor the state store were touched
        expect(cloud.resources.get("A")).toMatchObject({ value: "hijacked" });
        expect(yield* getState("A")).toMatchObject({
          status: "created",
          attr: { value: "a" },
        });
      }).pipe(withCloud(cloud));
    },
  );

  test.provider(
    "reports missing resources without recreating them",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(DriftResource("A", { value: "a" }));
        cloud.resources.delete("A");

        cloud.calls.length = 0;
        const result = yield* runSync({ dryRun: true });

        expect(result.resources.A?.action).toEqual("missing");
        expect(reconcileCalls(cloud)).toEqual([]);
        expect(cloud.resources.has("A")).toBe(false);
        // state still remembers the last-deployed attributes
        expect((yield* getState("A"))?.attr).toMatchObject({ value: "a" });
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("reports unchanged resources as unchanged", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      const result = yield* runSync({ dryRun: true });
      expect(result.resources.A?.action).toEqual("unchanged");
    }).pipe(withCloud(cloud));
  });
});

describe("skipped resources", () => {
  test.provider("a provider without read is skipped with a reason", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(Bucket("MyBucket", { name: "test-bucket" }));

      const result = yield* runSync();

      expect(result.resources.MyBucket).toMatchObject({
        action: "skipped",
        resourceType: "Test.Bucket",
      });
      expect(result.resources.MyBucket?.reason).toContain("read");
      // skipping is not destructive
      expect((yield* getState("MyBucket"))?.status).toEqual("created");
    }),
  );

  test.provider("resources stuck in a non-terminal status are skipped", () => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* seed({
        Stuck: {
          status: "creating",
          fqn: "Stuck",
          logicalId: "Stuck",
          instanceId,
          resourceType: "Test.DriftResource",
          namespace: undefined,
          providerVersion: 0,
          props: { value: "v" },
          bindings: [],
          downstream: [],
        },
      });

      const result = yield* runSync();

      expect(result.resources.Stuck?.action).toEqual("skipped");
      expect(result.resources.Stuck?.reason).toContain("creating");
      // no lifecycle operation ran against the unstable resource
      expect(cloud.calls).toEqual([]);
    }).pipe(withCloud(cloud));
  });

  test.provider("resources with a pending replacement chain are skipped", () =>
    Effect.gen(function* () {
      const oldGeneration = {
        status: "created",
        fqn: "R",
        logicalId: "R",
        instanceId: "00000000000000000000000000000000",
        resourceType: "Test.DriftResource",
        namespace: undefined,
        providerVersion: 0,
        props: { value: "v1" },
        attr: { id: "R", value: "v1", tags: {}, env: {} },
        bindings: [],
        downstream: [],
      };
      yield* seed({
        R: {
          status: "replaced",
          fqn: "R",
          logicalId: "R",
          instanceId,
          resourceType: "Test.DriftResource",
          namespace: undefined,
          providerVersion: 0,
          props: { value: "v2" },
          attr: { id: "R", value: "v2", tags: {}, env: {} },
          bindings: [],
          downstream: [],
          deleteFirst: false,
          old: oldGeneration,
        },
      });

      const result = yield* runSync();

      expect(result.resources.R?.action).toEqual("skipped");
      expect(result.resources.R?.reason).toContain("replacement");
    }),
  );

  test.provider("action state rows are ignored", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      yield* seed({
        MyTask: {
          kind: "action",
          status: "ran",
          fqn: "MyTask",
          logicalId: "MyTask",
          actionType: "Test.Task",
          namespace: undefined,
          inputHash: "abc",
          input: {},
          output: { ok: true },
          downstream: [],
        },
      });

      const result = yield* runSync();

      expect(result.resources.MyTask).toBeUndefined();
      expect(result.resources.A?.action).toEqual("unchanged");
      // the action row survives untouched
      expect(yield* getState("MyTask")).toMatchObject({
        kind: "action",
        status: "ran",
      });
    }).pipe(withCloud(cloud));
  });
});

describe("failures", () => {
  test.provider(
    "a failing repair does not prevent sibling repairs, and fails the sync",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* DriftResource("A", { value: "a" });
            yield* DriftResource("B", { value: "b" });
          }),
        );

        cloud.resources.get("A")!.value = "hijacked-a";
        cloud.resources.get("B")!.value = "hijacked-b";

        // drift repair goes through the provider's update intent
        const exit = yield* runSync().pipe(
          Effect.provide(
            Layer.succeed(TestResourceHooks, failOn("B", "update")),
          ),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        // A was still repaired even though B failed
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
        expect(yield* getState("A")).toMatchObject({
          status: "updated",
          attr: { value: "a" },
        });
        // B's cloud state is still drifted and its state row untouched
        expect(cloud.resources.get("B")).toMatchObject({
          value: "hijacked-b",
        });
        expect(yield* getState("B")).toMatchObject({
          status: "created",
          attr: { value: "b" },
        });

        // a follow-up sync (without the failure) converges B too
        const result = yield* runSync();
        expect(result.resources).toMatchObject({
          A: { action: "unchanged" },
          B: { action: "repaired" },
        });
        expect(cloud.resources.get("B")).toMatchObject({ value: "b" });
      }).pipe(withCloud(cloud));
    },
  );

  test.provider(
    "a failing recreate goes through the provider's create intent",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(DriftResource("A", { value: "a" }));
        cloud.resources.delete("A");

        const exit = yield* runSync().pipe(
          Effect.provide(
            Layer.succeed(TestResourceHooks, failOn("A", "create")),
          ),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        expect(cloud.resources.has("A")).toBe(false);

        // recovery: the next sync recreates it
        const result = yield* runSync();
        expect(result.resources.A?.action).toEqual("recreated");
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("a failing read fails the sync", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(TestResource("A", { string: "test-string" }));

      const exit = yield* runSync().pipe(
        Effect.provide(
          Layer.succeed(TestResourceHooks, {
            read: () => Effect.fail(new ResourceFailure("read exploded")),
          }),
        ),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      // state untouched by the failed observation
      expect(yield* getState("A")).toMatchObject({
        status: "created",
        attr: { string: "test-string" },
      });
    }),
  );
});

describe("ownership", () => {
  test.provider(
    "an unowned read result with matching attributes is unchanged",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(DriftResource("A", { value: "a" }));

        // ownership markers drifted but the attributes still match — the
        // Unowned brand is a plan-time routing hint, not drift by itself
        cloud.unowned.add("A");

        cloud.calls.length = 0;
        const result = yield* runSync();

        expect(result.resources.A?.action).toEqual("unchanged");
        expect(reconcileCalls(cloud)).toEqual([]);
      }).pipe(withCloud(cloud));
    },
  );

  test.provider(
    "an unowned, drifted resource is repaired and the brand never persists",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(DriftResource("A", { value: "a" }));

        cloud.unowned.add("A");
        cloud.resources.get("A")!.value = "hijacked";

        const result = yield* runSync();

        expect(result.resources.A?.action).toEqual("repaired");
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
        const state = yield* getState("A");
        expect(state).toMatchObject({
          status: "updated",
          attr: { value: "a" },
        });
        expect(Unowned.is(state!.attr)).toBe(false);
      }).pipe(withCloud(cloud));
    },
  );
});

describe("bindings", () => {
  test.provider(
    "binding-derived attributes are repaired from the persisted bindings",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        const created = yield* stack.deploy(
          Effect.gen(function* () {
            const a = yield* DriftResource("A", { value: "a" });
            yield* a.bind("Env", {
              env: { FEATURE_FLAG: "on" },
            });
            return a;
          }),
        );
        expect(created.env).toEqual({ FEATURE_FLAG: "on" });

        // the binding-derived env is wiped out-of-band
        cloud.resources.get("A")!.env = {};

        const result = yield* runSync();

        expect(result.resources.A?.action).toEqual("repaired");
        // reconcile received the persisted bindings and restored the env
        expect(cloud.resources.get("A")!.env).toEqual({ FEATURE_FLAG: "on" });
        expect((yield* getState("A"))?.attr?.env).toEqual({
          FEATURE_FLAG: "on",
        });
      }).pipe(withCloud(cloud));
    },
  );
});

describe("plan", () => {
  test.provider(
    "projects detection results onto plan node actions",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* DriftResource("Clean", { value: "clean" });
            yield* DriftResource("Drifted", { value: "drifted" });
            yield* DriftResource("Missing", { value: "missing" });
          }),
        );

        cloud.resources.get("Drifted")!.value = "hijacked";
        cloud.resources.delete("Missing");

        cloud.calls.length = 0;
        const stk = yield* Stack;
        const { result, plan } = yield* Sync.plan({
          name: stk.name,
          stage: stk.stage,
        });

        // drifted -> update, missing -> create, unchanged -> noop
        expect(plan.resources.Clean?.action).toEqual("noop");
        expect(plan.resources.Drifted?.action).toEqual("update");
        expect(plan.resources.Missing?.action).toEqual("create");
        // detection result rides along
        expect(result.resources).toMatchObject({
          Clean: { action: "unchanged" },
          Drifted: { action: "drifted" },
          Missing: { action: "missing" },
        });
        // the synthetic resource carries what the renderers need
        expect(plan.resources.Drifted?.resource).toMatchObject({
          FQN: "Drifted",
          LogicalId: "Drifted",
          Type: "Test.DriftResource",
        });
        // resource-only view: no deletions/actions in a sync plan
        expect(plan.deletions).toEqual({});
        expect(plan.actions).toEqual({});
        expect(plan.actionDeletions).toEqual({});
        // planning is detection-only: nothing was repaired
        expect(cloud.resources.get("Drifted")).toMatchObject({
          value: "hijacked",
        });
        expect(reconcileCalls(cloud)).toEqual([]);
      }).pipe(withCloud(cloud));
    },
  );

  test.provider(
    "skipped resources render as noop nodes carrying persisted state",
    (stack) =>
      Effect.gen(function* () {
        yield* stack.deploy(Bucket("MyBucket", { name: "test-bucket" }));

        const stk = yield* Stack;
        const { result, plan } = yield* Sync.plan({
          name: stk.name,
          stage: stk.stage,
        });

        expect(result.resources.MyBucket?.action).toEqual("skipped");
        expect(plan.resources.MyBucket).toMatchObject({
          action: "noop",
          state: { status: "created" },
          resource: { LogicalId: "MyBucket", Type: "Test.Bucket" },
        });
      }),
  );

  test.provider(
    "namespaced resources keep their namespace, FQN and bindings",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        const Site = (id: string) =>
          Effect.gen(function* () {
            const a = yield* DriftResource("A", { value: "a" });
            yield* a.bind("Env", { env: { KEY: "on" } });
            return a;
          }).pipe(Namespace.push(id));

        yield* stack.deploy(Site("Site"));

        cloud.resources.get("A")!.value = "hijacked";

        const stk = yield* Stack;
        const { plan } = yield* Sync.plan({
          name: stk.name,
          stage: stk.stage,
        });

        const node = plan.resources["Site/A"];
        expect(node?.action).toEqual("update");
        expect(node?.resource).toMatchObject({
          FQN: "Site/A",
          LogicalId: "A",
        });
        expect(node?.resource.Namespace).toBeDefined();
        // persisted bindings surface as noop rows (topology, not changes)
        expect(node?.bindings).toMatchObject([{ sid: "Env", action: "noop" }]);
      }).pipe(withCloud(cloud));
    },
  );
});

describe("session events", () => {
  test.provider(
    "repair reports progress through the provided session",
    (stack) => {
      const cloud = makeTestCloud();
      const events: ApplyEvent[] = [];
      const session = {
        emit: (event: ApplyEvent) =>
          Effect.sync(() => {
            events.push(event);
          }),
        done: () => Effect.void,
      };
      return Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            yield* DriftResource("Drifted", { value: "drifted" });
            yield* DriftResource("Missing", { value: "missing" });
            yield* Bucket("MyBucket", { name: "test-bucket" });
          }),
        );

        cloud.resources.get("Drifted")!.value = "hijacked";
        cloud.resources.delete("Missing");

        yield* runSync({ session });

        // drift repair reports the update lifecycle
        expect(events).toContainEqual({
          kind: "status-change",
          id: "Drifted",
          type: "Test.DriftResource",
          status: "updating",
        });
        expect(events).toContainEqual({
          kind: "status-change",
          id: "Drifted",
          type: "Test.DriftResource",
          status: "updated",
        });
        // recreation reports the create lifecycle
        expect(events).toContainEqual({
          kind: "status-change",
          id: "Missing",
          type: "Test.DriftResource",
          status: "creating",
        });
        expect(events).toContainEqual({
          kind: "status-change",
          id: "Missing",
          type: "Test.DriftResource",
          status: "created",
        });
        // skipped resources settle with a terminal status and a reason note
        expect(events).toContainEqual({
          kind: "status-change",
          id: "MyBucket",
          type: "Test.Bucket",
          status: "skipped",
        });
        expect(
          events.some(
            (e) =>
              e.kind === "annotate" &&
              e.id === "MyBucket" &&
              e.message.includes("read"),
          ),
        ).toBe(true);
      }).pipe(withCloud(cloud));
    },
  );
});
