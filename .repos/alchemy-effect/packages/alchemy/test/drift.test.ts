import { describe, expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { Unowned } from "@/AdoptPolicy";
import * as Drift from "@/Drift";
import { onEvent, type ApplyEvent, type Event } from "@/Events.ts";
import * as Namespace from "@/Namespace.ts";
import * as RemovalPolicy from "@/RemovalPolicy.ts";
import { Stack } from "@/Stack";
import { State, type ResourceState } from "@/State";
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
  failOnMultiple,
  inDev,
  ModalResource,
  modalCalls,
  type TestCloudService,
} from "./test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

const getState = Effect.fn(function* <S = ResourceState>(resourceId: string) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return (yield* state.get({ stack: stk.name, stage: stk.stage, fqn: resourceId })) as S;
});

const seed = Effect.fn(function* (rows: Record<string, any>) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  for (const [fqn, value] of Object.entries(rows)) {
    yield* state.set({ stack: stk.name, stage: stk.stage, fqn, value });
  }
});

/** Run drift; `events` collects the apply events a repair emits. */
const runDrift = (options: { readonly dryRun?: boolean; readonly events?: ApplyEvent[] } = {}) =>
  Effect.gen(function* () {
    const stk = yield* Stack;
    const identity = { name: stk.name, stage: stk.stage };
    return yield* options.dryRun
      ? Drift.detect(identity)
      : Drift.repair(identity).pipe(
          onEvent((event) =>
            Effect.sync(() => {
              if (event.type === "apply.resource.status" || event.type === "apply.resource.note") {
                options.events?.push(event);
              }
            }),
          ),
        );
  });

const withCloud =
  (cloud: TestCloudService) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(Effect.provide(Layer.succeed(TestCloud, cloud)));

const reconcileCalls = (cloud: TestCloudService) =>
  cloud.calls.filter((c) => c.op === "reconcile").map((c) => c.id);

// `id[sid,…]` per reconcile, in call order — shows both the order and which
// bindings each reconcile carried.
const reconcileTrace = (cloud: TestCloudService) =>
  cloud.calls
    .filter((c) => c.op === "reconcile")
    .map((c) => `${c.id}[${(c.bindings ?? []).join(",")}]`);

const statusesOf = (events: ApplyEvent[], fqn: string) =>
  events.flatMap((e) => (e.type === "apply.resource.status" && e.fqn === fqn ? [e.status] : []));

const readCalls = (cloud: TestCloudService) =>
  cloud.calls.filter((c) => c.op === "read").map((c) => c.id);

const instanceId = "852f6ec2e19b66589825efe14dca2971";

describe("drift detection and repair", { tags: ["unit", "local"] }, () => {
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
        const result = yield* runDrift();

        expect(result.resources).toMatchObject({
          A: { action: "unchanged", resourceType: "Test.DriftResource" },
          B: { action: "unchanged", resourceType: "Test.DriftResource" },
        });
        // drift observed both resources but touched neither
        expect(readCalls(cloud).sort()).toEqual(["A", "B"]);
        expect(reconcileCalls(cloud)).toEqual([]);
        // cloud and state are untouched
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
        expect((yield* getState("A"))?.status).toEqual("created");
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("out-of-band value drift is repaired back to the desired state", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));

      // someone edits the resource in the console
      cloud.resources.get("A")!.value = "hijacked";

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources.A).toMatchObject({ action: "repaired", attr: { value: "a" } });
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
  });

  test.provider("a scoped repair leaves resources outside its scope alone", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* DriftResource("A", { value: "a" });
          yield* DriftResource("B", { value: "b" });
        }),
      );

      // A drifted before the scan was approved; B drifts afterwards.
      cloud.resources.get("A")!.value = "hijacked";
      cloud.resources.get("B")!.value = "hijacked";

      cloud.calls.length = 0;
      const stk = yield* Stack;
      const result = yield* Drift.repair({ name: stk.name, stage: stk.stage }, { only: ["A"] });

      expect(Object.keys(result.resources)).toEqual(["A"]);
      expect(reconcileCalls(cloud)).toEqual(["A"]);
      expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
      expect(cloud.resources.get("B")).toMatchObject({ value: "hijacked" });
    }).pipe(withCloud(cloud));
  });

  test.provider("nested tag drift is detected and repaired", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a", tags: { team: "alchemy" } }));

      // foreign tags appear and an owned tag is clobbered
      cloud.resources.get("A")!.tags = { team: "intruder", extra: "tag" };

      const result = yield* runDrift();

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

        const result = yield* runDrift();

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

  test.provider("drift is idempotent", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      cloud.resources.get("A")!.value = "hijacked";

      const first = yield* runDrift();
      expect(first.resources.A?.action).toEqual("repaired");

      cloud.calls.length = 0;
      const second = yield* runDrift();
      expect(second.resources.A?.action).toEqual("unchanged");
      expect(reconcileCalls(cloud)).toEqual([]);
    }).pipe(withCloud(cloud));
  });

  test.provider("mixed fleet: only drifted and missing resources are reconciled", (stack) => {
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
      const result = yield* runDrift();

      expect(result.resources).toMatchObject({
        Clean: { action: "unchanged" },
        Drifted: { action: "repaired" },
        Missing: { action: "recreated" },
      });
      expect(reconcileCalls(cloud).sort()).toEqual(["Drifted", "Missing"]);
      expect(cloud.resources.get("Drifted")).toMatchObject({ value: "drifted" });
      expect(cloud.resources.get("Missing")).toMatchObject({ value: "missing" });
    }).pipe(withCloud(cloud));
  });

  test.provider("empty state: drift succeeds with no resources", () =>
    Effect.gen(function* () {
      const result = yield* runDrift();
      expect(result.resources).toEqual({});
    }),
  );

  test.provider("a provider whose read reflects state back never drifts", (stack) =>
    Effect.gen(function* () {
      // TestResource.read returns the persisted output when no hook is
      // installed — the degenerate "cannot observe drift" case.
      yield* stack.deploy(TestResource("A", { string: "test-string" }));
      const result = yield* runDrift();
      expect(result.resources.A?.action).toEqual("unchanged");
    }),
  );
});

describe("dry run", { tags: ["unit", "local"] }, () => {
  test.provider("reports drift without repairing the cloud or touching state", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      cloud.resources.get("A")!.value = "hijacked";

      cloud.calls.length = 0;
      const result = yield* runDrift({ dryRun: true });

      expect(result.resources.A).toMatchObject({
        action: "drifted",
        // dry-run reports the OBSERVED (drifted) attributes
        attr: { value: "hijacked" },
      });
      expect(reconcileCalls(cloud)).toEqual([]);
      // neither the cloud nor the state store were touched
      expect(cloud.resources.get("A")).toMatchObject({ value: "hijacked" });
      expect(yield* getState("A")).toMatchObject({ status: "created", attr: { value: "a" } });
    }).pipe(withCloud(cloud));
  });

  test.provider("reports missing resources without recreating them", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      cloud.resources.delete("A");

      cloud.calls.length = 0;
      const result = yield* runDrift({ dryRun: true });

      expect(result.resources.A?.action).toEqual("missing");
      expect(reconcileCalls(cloud)).toEqual([]);
      expect(cloud.resources.has("A")).toBe(false);
      // state still remembers the last-deployed attributes
      expect((yield* getState("A"))?.attr).toMatchObject({ value: "a" });
    }).pipe(withCloud(cloud));
  });

  test.provider("reports unchanged resources as unchanged", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      const result = yield* runDrift({ dryRun: true });
      expect(result.resources.A?.action).toEqual("unchanged");
    }).pipe(withCloud(cloud));
  });
});

describe("skipped resources", { tags: ["unit", "local"] }, () => {
  test.provider("a provider without read is skipped with a reason", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(Bucket("MyBucket", { name: "test-bucket" }));

      const result = yield* runDrift();

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

      const result = yield* runDrift();

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

      const result = yield* runDrift();

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

      const result = yield* runDrift();

      expect(result.resources.MyTask).toBeUndefined();
      expect(result.resources.A?.action).toEqual("unchanged");
      // the action row survives untouched
      expect(yield* getState("MyTask")).toMatchObject({ kind: "action", status: "ran" });
    }).pipe(withCloud(cloud));
  });
});

describe("failures", { tags: ["unit", "local"] }, () => {
  test.provider(
    "a failing repair does not prevent sibling repairs, and fails the drift",
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
        const exit = yield* runDrift().pipe(
          Effect.provide(Layer.succeed(TestResourceHooks, failOn("B", "update"))),
          Effect.exit,
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const rendered = Cause.pretty(exit.cause);
          expect(rendered).toContain("Resource 'B' (Test.DriftResource) failed during update");
          expect(rendered).toContain("Failed to create");
        }
        // A was still repaired even though B failed
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
        expect(yield* getState("A")).toMatchObject({ status: "updated", attr: { value: "a" } });
        // B's cloud state is still drifted and its state row untouched
        expect(cloud.resources.get("B")).toMatchObject({ value: "hijacked-b" });
        expect(yield* getState("B")).toMatchObject({ status: "created", attr: { value: "b" } });

        // a follow-up drift (without the failure) converges B too
        const result = yield* runDrift();
        expect(result.resources).toMatchObject({
          A: { action: "unchanged" },
          B: { action: "repaired" },
        });
        expect(cloud.resources.get("B")).toMatchObject({ value: "b" });
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("a failing recreate goes through the provider's create intent", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      cloud.resources.delete("A");

      const exit = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("A", "create"))),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(cloud.resources.has("A")).toBe(false);

      // recovery: the next drift recreates it
      const result = yield* runDrift();
      expect(result.resources.A?.action).toEqual("recreated");
      expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
    }).pipe(withCloud(cloud));
  });

  test.provider("a failing read fails the drift", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(TestResource("A", { string: "test-string" }));

      const exit = yield* runDrift().pipe(
        Effect.provide(
          Layer.succeed(TestResourceHooks, {
            read: () => Effect.fail(new ResourceFailure("read exploded")),
          }),
        ),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const rendered = Cause.pretty(exit.cause);
        expect(rendered).toContain("Resource 'A' (Test.TestResource) failed during read");
        expect(rendered).toContain("read exploded");
      }
      // state untouched by the failed observation
      expect(yield* getState("A")).toMatchObject({
        status: "created",
        attr: { string: "test-string" },
      });
    }),
  );
});

describe("ownership", { tags: ["unit", "local"] }, () => {
  test.provider("an unowned read result with matching attributes is unchanged", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));

      // ownership markers drifted but the attributes still match — the
      // Unowned brand is a plan-time routing hint, not drift by itself
      cloud.unowned.add("A");

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources.A?.action).toEqual("unchanged");
      expect(reconcileCalls(cloud)).toEqual([]);
    }).pipe(withCloud(cloud));
  });

  test.provider(
    "an unowned, drifted resource is repaired and the brand never persists",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(DriftResource("A", { value: "a" }));

        cloud.unowned.add("A");
        cloud.resources.get("A")!.value = "hijacked";

        const result = yield* runDrift();

        expect(result.resources.A?.action).toEqual("repaired");
        expect(cloud.resources.get("A")).toMatchObject({ value: "a" });
        const state = yield* getState("A");
        expect(state).toMatchObject({ status: "updated", attr: { value: "a" } });
        expect(Unowned.is(state!.attr)).toBe(false);
      }).pipe(withCloud(cloud));
    },
  );
});

describe("bindings", { tags: ["unit", "local"] }, () => {
  test.provider("binding-derived attributes are repaired from the persisted bindings", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* DriftResource("A", { value: "a" });
          yield* a.bind("Env", { env: { FEATURE_FLAG: "on" } });
          return a;
        }),
      );
      expect(created.env).toEqual({ FEATURE_FLAG: "on" });

      // the binding-derived env is wiped out-of-band
      cloud.resources.get("A")!.env = {};

      const result = yield* runDrift();

      expect(result.resources.A?.action).toEqual("repaired");
      // reconcile received the persisted bindings and restored the env
      expect(cloud.resources.get("A")!.env).toEqual({ FEATURE_FLAG: "on" });
      expect((yield* getState("A"))?.attr?.env).toEqual({ FEATURE_FLAG: "on" });
    }).pipe(withCloud(cloud));
  });
});

describe("plan", { tags: ["unit", "local"] }, () => {
  test.provider("projects detection results onto plan node actions", (stack) => {
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
      const { result, plan } = yield* Drift.plan({ name: stk.name, stage: stk.stage });

      // drifted -> update, missing -> create, unchanged -> noop
      expect(plan.resources.Clean?.action).toEqual("noop");
      expect(plan.resources.Clean?.drift).toBeUndefined();
      expect(plan.resources.Drifted?.action).toEqual("update");
      expect(plan.resources.Missing?.action).toEqual("create");
      expect(plan.resources.Drifted).toMatchObject({
        drift: { expected: { value: "drifted" }, actual: { value: "hijacked" } },
      });
      expect(plan.resources.Missing).toMatchObject({
        drift: { expected: { value: "missing" }, missing: true },
      });
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
      // resource-only view: no deletions/actions in a drift plan
      expect(plan.deletions).toEqual({});
      expect(plan.actions).toEqual({});
      expect(plan.actionDeletions).toEqual({});
      // planning is detection-only: nothing was repaired
      expect(cloud.resources.get("Drifted")).toMatchObject({ value: "hijacked" });
      expect(reconcileCalls(cloud)).toEqual([]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a deleted chain plans every member as a create, carrying its edges", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", {});
          yield* DriftResource("Subscription", { dependsOn: [topic.id] });
        }),
      );
      cloud.resources.delete("Topic");
      cloud.resources.delete("Subscription");

      cloud.calls.length = 0;
      const stk = yield* Stack;
      const { plan } = yield* Drift.plan({ name: stk.name, stage: stk.stage });

      expect(plan.resources.Topic).toMatchObject({
        action: "create",
        drift: { missing: true },
        downstream: ["Subscription"],
      });
      expect(plan.resources.Subscription).toMatchObject({ action: "create", downstream: [] });
      expect(reconcileCalls(cloud)).toEqual([]);
    }).pipe(withCloud(cloud));
  });

  test.provider("reports each observed resource as events", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* DriftResource("Clean", { value: "clean" });
          yield* DriftResource("Drifted", { value: "drifted" });
        }),
      );
      cloud.resources.get("Drifted")!.value = "hijacked";

      const events: Array<Event> = [];
      const stk = yield* Stack;
      yield* Drift.plan({ name: stk.name, stage: stk.stage }).pipe(
        onEvent((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
      );

      // Phase markers bracket the observation fan-out.
      expect(
        events.filter((event) => event.type === "plan.phase").map(({ phase }) => phase),
      ).toEqual(["loading-state", "computing-plan"]);
      // Every read emits a start (so renderers can show in-flight rows)
      // paired with a completion.
      expect(
        events
          .filter((event) => event.type === "plan.resource.started")
          .map(({ logicalId }) => logicalId)
          .sort(),
      ).toEqual(["Clean", "Drifted"]);
      const nodes = events.filter((event) => event.type === "plan.resource.completed");
      expect(nodes).toHaveLength(2);
      expect(nodes.map(({ completed }) => completed).sort()).toEqual([1, 2]);
      expect(Object.fromEntries(nodes.map((event) => [event.logicalId, event.action]))).toEqual({
        Clean: "noop",
        Drifted: "update",
      });
      for (const event of nodes) {
        expect(event).toMatchObject({ type: "plan.resource.completed", total: 2 });
      }
    }).pipe(withCloud(cloud));
  });

  test.provider("skipped resources render as noop nodes carrying persisted state", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(Bucket("MyBucket", { name: "test-bucket" }));

      const stk = yield* Stack;
      const { result, plan } = yield* Drift.plan({ name: stk.name, stage: stk.stage });

      expect(result.resources.MyBucket?.action).toEqual("skipped");
      expect(plan.resources.MyBucket).toMatchObject({
        action: "noop",
        state: { status: "created" },
        resource: { LogicalId: "MyBucket", Type: "Test.Bucket" },
      });
    }),
  );

  test.provider("namespaced resources keep their namespace, FQN and bindings", (stack) => {
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
      const { plan } = yield* Drift.plan({ name: stk.name, stage: stk.stage });

      const node = plan.resources["Site/A"];
      expect(node?.action).toEqual("update");
      expect(node?.resource).toMatchObject({ FQN: "Site/A", LogicalId: "A" });
      expect(node?.resource.Namespace).toBeDefined();
      // persisted bindings surface as noop rows (topology, not changes)
      expect(node?.bindings).toMatchObject([{ sid: "Env", action: "noop" }]);
    }).pipe(withCloud(cloud));
  });
});

describe("repair events", { tags: ["unit", "local"] }, () => {
  test.provider("repair reports progress as events", (stack) => {
    const cloud = makeTestCloud();
    const events: ApplyEvent[] = [];
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

      yield* runDrift({ events });

      // drift repair reports the update lifecycle
      expect(events).toContainEqual({
        type: "apply.resource.status",
        fqn: "Drifted",
        id: "Drifted",
        resourceType: "Test.DriftResource",
        status: "updating",
      });
      expect(events).toContainEqual({
        type: "apply.resource.status",
        fqn: "Drifted",
        id: "Drifted",
        resourceType: "Test.DriftResource",
        status: "updated",
      });
      // recreation reports the create lifecycle
      expect(events).toContainEqual({
        type: "apply.resource.status",
        fqn: "Missing",
        id: "Missing",
        resourceType: "Test.DriftResource",
        status: "creating",
      });
      expect(events).toContainEqual({
        type: "apply.resource.status",
        fqn: "Missing",
        id: "Missing",
        resourceType: "Test.DriftResource",
        status: "created",
      });
      // skipped resources settle with a terminal status and a reason note
      expect(events).toContainEqual({
        type: "apply.resource.status",
        fqn: "MyBucket",
        id: "MyBucket",
        resourceType: "Test.Bucket",
        status: "skipped",
      });
      expect(
        events.some(
          (e) =>
            e.type === "apply.resource.note" && e.id === "MyBucket" && e.message.includes("read"),
        ),
      ).toBe(true);
    }).pipe(withCloud(cloud));
  });
});

// Repairs follow the persisted `downstream` edges, like Apply: an upstream
// is recreated before anything that points at it. The TestCloud enforces
// this — a DriftResource reconcile fails when a `dependsOn` id is missing.
describe("dependency order", { tags: ["unit", "local"] }, () => {
  test.provider("a deleted chain is recreated upstream first", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", { value: "topic" });
          const queue = yield* DriftResource("Queue", { value: "queue", dependsOn: [topic.id] });
          yield* DriftResource("Subscription", { value: "sub", dependsOn: [queue.id] });
        }),
      );
      expect((yield* getState("Topic"))?.downstream).toEqual(["Queue"]);

      for (const id of ["Topic", "Queue", "Subscription"]) cloud.resources.delete(id);
      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources).toMatchObject({
        Topic: { action: "recreated" },
        Queue: { action: "recreated" },
        Subscription: { action: "recreated" },
      });
      expect(reconcileCalls(cloud)).toEqual(["Topic", "Queue", "Subscription"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a diamond waits for every upstream", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const root = yield* DriftResource("Root", {});
          const left = yield* DriftResource("Left", { dependsOn: [root.id] });
          const right = yield* DriftResource("Right", { dependsOn: [root.id] });
          yield* DriftResource("Leaf", { dependsOn: [left.id, right.id] });
        }),
      );

      for (const id of ["Root", "Left", "Right", "Leaf"]) cloud.resources.delete(id);
      cloud.calls.length = 0;
      yield* runDrift();

      const order = reconcileCalls(cloud);
      expect(order[0]).toEqual("Root");
      expect(order.slice(1, 3).sort()).toEqual(["Left", "Right"]);
      expect(order[3]).toEqual("Leaf");
    }).pipe(withCloud(cloud));
  });

  test.provider("independent resources are repaired concurrently", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* DriftResource("X", {});
          yield* DriftResource("Y", {});
        }),
      );
      cloud.resources.delete("X");
      cloud.resources.delete("Y");

      // Each create waits for the other to start: only a concurrent
      // repair can finish.
      const started = {
        X: yield* Deferred.make<void>(),
        Y: yield* Deferred.make<void>(),
      };
      const hooks = {
        create: (id: string) =>
          id === "X" || id === "Y"
            ? Deferred.succeed(started[id], undefined).pipe(
                Effect.andThen(Deferred.await(started[id === "X" ? "Y" : "X"])),
                Effect.timeout("2 seconds"),
              )
            : Effect.void,
      };
      const result = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, hooks)),
      );

      expect(result.resources).toMatchObject({
        X: { action: "recreated" },
        Y: { action: "recreated" },
      });
    }).pipe(withCloud(cloud));
  });

  test.provider("a missing resource under an intact upstream recreates directly", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", { value: "topic" });
          yield* DriftResource("Subscription", { value: "sub", dependsOn: [topic.id] });
        }),
      );
      cloud.resources.delete("Subscription");

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources).toMatchObject({
        Topic: { action: "unchanged" },
        Subscription: { action: "recreated" },
      });
      expect(reconcileCalls(cloud)).toEqual(["Subscription"]);
    }).pipe(withCloud(cloud));
  });

  test.provider(
    "a drifted resource is repaired after its missing upstream is recreated",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            const topic = yield* DriftResource("Topic", { value: "topic" });
            yield* DriftResource("Subscription", { value: "sub", dependsOn: [topic.id] });
          }),
        );
        cloud.resources.delete("Topic");
        cloud.resources.get("Subscription")!.value = "hijacked";

        cloud.calls.length = 0;
        const result = yield* runDrift();

        expect(result.resources).toMatchObject({
          Topic: { action: "recreated" },
          Subscription: { action: "repaired", attr: { value: "sub" } },
        });
        expect(reconcileCalls(cloud)).toEqual(["Topic", "Subscription"]);
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("namespaced resources order by FQN", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", {});
          yield* DriftResource("Subscription", { dependsOn: [topic.id] });
        }).pipe(Namespace.push("Uploads")),
      );
      expect((yield* getState("Uploads/Topic"))?.downstream).toEqual(["Uploads/Subscription"]);
      cloud.resources.delete("Topic");
      cloud.resources.delete("Subscription");

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources["Uploads/Subscription"]?.action).toEqual("recreated");
      expect(reconcileCalls(cloud)).toEqual(["Topic", "Subscription"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("cyclic or dangling persisted edges do not deadlock the repair", () => {
    const cloud = makeTestCloud();
    const row = (fqn: string, downstream: string[]) => ({
      status: "created",
      fqn,
      logicalId: fqn,
      instanceId,
      resourceType: "Test.DriftResource",
      namespace: undefined,
      providerVersion: 0,
      props: { value: fqn },
      attr: { id: fqn, value: fqn, tags: {}, env: {} },
      bindings: [],
      downstream,
    });
    return Effect.gen(function* () {
      // Merged historical edges can disagree with each other; a cycle among
      // them, or an edge to a row that no longer exists, must not block.
      yield* seed({ A: row("A", ["B", "Ghost"]), B: row("B", ["A"]), C: row("C", ["A"]) });

      const result = yield* runDrift().pipe(Effect.timeout("2 seconds"));

      expect(result.resources).toMatchObject({
        A: { action: "recreated" },
        B: { action: "recreated" },
        C: { action: "recreated" },
      });
      // the acyclic edge still orders C before A
      const order = reconcileCalls(cloud);
      expect(order.indexOf("C")).toBeLessThan(order.indexOf("A"));
    }).pipe(withCloud(cloud));
  });

  test.provider("dry run reports a deleted chain without ordering any repair", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", {});
          yield* DriftResource("Subscription", { dependsOn: [topic.id] });
        }),
      );
      cloud.resources.delete("Topic");
      cloud.resources.delete("Subscription");

      cloud.calls.length = 0;
      const result = yield* runDrift({ dryRun: true });

      expect(result.resources).toMatchObject({
        Topic: { action: "missing" },
        Subscription: { action: "missing" },
      });
      expect(reconcileCalls(cloud)).toEqual([]);
    }).pipe(withCloud(cloud));
  });
});

// Missing resources are recreated bare, then bound once every missing
// resource exists again: binding data can point at a resource recreated
// later, and a binding edge inside a cycle is not a persisted `downstream`
// edge. The TestCloud fails a reconcile whose binding `targets` are missing.
describe("bindings of recreated resources", { tags: ["unit", "local"] }, () => {
  test.provider("a missing resource is recreated bare, then bound", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* DriftResource("A", { value: "a" });
          yield* a.bind("Env", { env: { FEATURE_FLAG: "on" } });
        }),
      );
      cloud.resources.delete("A");

      cloud.calls.length = 0;
      const events: ApplyEvent[] = [];
      const result = yield* runDrift({ events });

      expect(result.resources.A).toMatchObject({
        action: "recreated",
        attr: { env: { FEATURE_FLAG: "on" } },
      });
      expect(reconcileTrace(cloud)).toEqual(["A[]", "A[Env]"]);
      expect(cloud.resources.get("A")!.env).toEqual({ FEATURE_FLAG: "on" });
      expect(yield* getState("A")).toMatchObject({
        status: "created",
        bindings: [{ sid: "Env" }],
        attr: { env: { FEATURE_FLAG: "on" } },
      });
      // one create lifecycle, even across both reconciles
      expect(statusesOf(events, "A")).toEqual(["creating", "created"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a missing resource without bindings is reconciled once", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      cloud.resources.delete("A");

      cloud.calls.length = 0;
      yield* runDrift();

      expect(reconcileTrace(cloud)).toEqual(["A[]"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a drifted resource keeps its bindings in a single reconcile", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* DriftResource("A", { value: "a" });
          yield* a.bind("Env", { env: { FEATURE_FLAG: "on" } });
        }),
      );
      cloud.resources.get("A")!.value = "hijacked";

      cloud.calls.length = 0;
      yield* runDrift();

      expect(reconcileTrace(cloud)).toEqual(["A[Env]"]);
    }).pipe(withCloud(cloud));
  });

  // The #1536 shape: the topic's props point at the bucket, and the bucket's
  // notification binding points back at the topic.
  test.provider("a binding cycle is recreated bare, then bound", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* DriftResource("Bucket", { value: "bucket" });
          const topic = yield* DriftResource("Topic", { value: "topic", dependsOn: [bucket.id] });
          yield* bucket.bind("Notifications", { targets: [topic.id] });
        }),
      );
      // the cyclic binding edge is not persisted as a downstream edge
      expect((yield* getState("Topic"))?.downstream).toEqual([]);
      cloud.resources.delete("Bucket");
      cloud.resources.delete("Topic");

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources).toMatchObject({
        Bucket: { action: "recreated" },
        Topic: { action: "recreated" },
      });
      expect(reconcileTrace(cloud)).toEqual(["Bucket[]", "Topic[]", "Bucket[Notifications]"]);
      expect((yield* getState("Bucket"))?.bindings).toMatchObject([{ sid: "Notifications" }]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a binding pointing at a later-recreated resource is attached last", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* DriftResource("A", {});
          const b = yield* DriftResource("B", { dependsOn: [a.id] });
          yield* a.bind("Points", { targets: [b.id] });
        }),
      );
      cloud.resources.delete("A");
      cloud.resources.delete("B");

      cloud.calls.length = 0;
      yield* runDrift();

      expect(reconcileTrace(cloud)).toEqual(["A[]", "B[]", "A[Points]"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("bindings are attached in dependency order", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* DriftResource("A", {});
          yield* a.bind("Env", { env: { KEY: "a" } });
          const b = yield* DriftResource("B", { dependsOn: [a.id] });
          yield* b.bind("Env", { env: { KEY: "b" } });
        }),
      );
      cloud.resources.delete("A");
      cloud.resources.delete("B");

      cloud.calls.length = 0;
      yield* runDrift();

      expect(reconcileTrace(cloud)).toEqual(["A[]", "B[]", "A[Env]", "B[Env]"]);
    }).pipe(withCloud(cloud));
  });

  test.provider(
    "a recreated dependent is bound after its drifted upstream is repaired",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(
          Effect.gen(function* () {
            const a = yield* DriftResource("A", { value: "a" });
            const b = yield* DriftResource("B", { dependsOn: [a.id] });
            yield* b.bind("Env", { env: { KEY: "b" } });
          }),
        );
        cloud.resources.get("A")!.value = "hijacked";
        cloud.resources.delete("B");

        cloud.calls.length = 0;
        const result = yield* runDrift();

        expect(result.resources).toMatchObject({
          A: { action: "repaired" },
          B: { action: "recreated", attr: { env: { KEY: "b" } } },
        });
        expect(reconcileTrace(cloud)).toEqual(["B[]", "A[]", "B[Env]"]);
      }).pipe(withCloud(cloud));
    },
  );

  test.provider("a failed bind leaves an unbound row that the next deploy binds", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const a = yield* DriftResource("A", { value: "a" });
        yield* a.bind("Env", { env: { FEATURE_FLAG: "on" } });
        return a;
      });
      yield* stack.deploy(program);
      cloud.resources.delete("A");

      // the bare recreate succeeds; attaching the binding (an update of the
      // recreated resource) fails
      const exit = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("A", "update"))),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(cloud.resources.get("A")).toMatchObject({ value: "a", env: {} });
      // state records the resource without the binding it does not have
      expect(yield* getState("A")).toMatchObject({ status: "created", bindings: [] });

      // so the next deploy plans the binding and attaches it
      const deployed = yield* stack.deploy(program);
      expect(deployed.env).toEqual({ FEATURE_FLAG: "on" });
      expect(cloud.resources.get("A")!.env).toEqual({ FEATURE_FLAG: "on" });
    }).pipe(withCloud(cloud));
  });
});

// Like Apply, a dependent never runs against an upstream whose repair
// failed: it settles as skipped, and the drift fails with the upstream's
// error alone.
describe("dependency failures", { tags: ["unit", "local"] }, () => {
  const chain = (...ids: string[]) =>
    Effect.gen(function* () {
      let previous: DriftResource | undefined;
      for (const id of ids) {
        previous = yield* DriftResource(id, {
          value: id,
          dependsOn: previous ? [previous.id] : undefined,
        });
      }
    });

  const failureOf = <A, E>(exit: Exit.Exit<A, E>) => {
    expect(Exit.isFailure(exit)).toBe(true);
    return Exit.isFailure(exit) ? Cause.pretty(exit.cause) : "";
  };

  test.provider("a failed upstream recreate skips its dependents", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* chain("Topic", "Subscription");
          yield* DriftResource("Other", {});
        }),
      );
      for (const id of ["Topic", "Subscription", "Other"]) cloud.resources.delete(id);

      cloud.calls.length = 0;
      const events: ApplyEvent[] = [];
      const exit = yield* runDrift({ events }).pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("Topic", "create"))),
        Effect.exit,
      );

      const rendered = failureOf(exit);
      expect(rendered).toContain("Resource 'Topic' (Test.DriftResource) failed during create");
      expect(rendered).not.toContain("'Subscription'");
      // the dependent never reached its provider
      expect(reconcileCalls(cloud).sort()).toEqual(["Other", "Topic"]);
      expect(cloud.resources.has("Other")).toBe(true);
      expect(statusesOf(events, "Subscription")).toEqual(["skipped"]);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: "apply.resource.note",
          id: "Subscription",
          message: "not repaired: upstream 'Topic' failed",
        }),
      );
      // the dependent's row is untouched
      expect(yield* getState("Subscription")).toMatchObject({ status: "created" });

      // the next drift converges the rest of the chain
      const result = yield* runDrift();
      expect(result.resources).toMatchObject({
        Topic: { action: "recreated" },
        Subscription: { action: "recreated" },
        Other: { action: "unchanged" },
      });
    }).pipe(withCloud(cloud));
  });

  test.provider("a failed upstream repair skips its drifted dependents", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(chain("Topic", "Subscription"));
      cloud.resources.get("Topic")!.value = "hijacked";
      cloud.resources.get("Subscription")!.value = "hijacked";

      cloud.calls.length = 0;
      const exit = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("Topic", "update"))),
        Effect.exit,
      );

      expect(failureOf(exit)).toContain(
        "Resource 'Topic' (Test.DriftResource) failed during update",
      );
      expect(reconcileCalls(cloud)).toEqual(["Topic"]);
      expect(cloud.resources.get("Subscription")).toMatchObject({ value: "hijacked" });
    }).pipe(withCloud(cloud));
  });

  test.provider("a failed upstream bind skips dependents still to be repaired", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", {});
          yield* topic.bind("Env", { env: { KEY: "on" } });
          yield* DriftResource("Missing", { dependsOn: [topic.id] });
          yield* DriftResource("Drifted", { value: "drifted", dependsOn: [topic.id] });
        }),
      );
      cloud.resources.delete("Topic");
      cloud.resources.delete("Missing");
      cloud.resources.get("Drifted")!.value = "hijacked";

      cloud.calls.length = 0;
      // the bare recreate succeeds, attaching the binding fails
      const exit = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("Topic", "update"))),
        Effect.exit,
      );

      expect(failureOf(exit)).toContain(
        "Resource 'Topic' (Test.DriftResource) failed during create",
      );
      // the missing dependent only needed Topic to exist, so it was
      // recreated before the bind; the drifted dependent waits on the bind
      expect(reconcileTrace(cloud)).toEqual(["Topic[]", "Missing[]", "Topic[Env]"]);
      expect(cloud.resources.has("Missing")).toBe(true);
      expect(cloud.resources.get("Drifted")).toMatchObject({ value: "hijacked" });
    }).pipe(withCloud(cloud));
  });

  test.provider("skips propagate down a chain", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(chain("A", "B", "C"));
      for (const id of ["A", "B", "C"]) cloud.resources.delete(id);

      cloud.calls.length = 0;
      const events: ApplyEvent[] = [];
      const exit = yield* runDrift({ events }).pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("A", "create"))),
        Effect.exit,
      );

      failureOf(exit);
      expect(reconcileCalls(cloud)).toEqual(["A"]);
      expect(statusesOf(events, "B")).toEqual(["skipped"]);
      expect(statusesOf(events, "C")).toEqual(["skipped"]);
      // each skip names its direct upstream
      expect(events).toContainEqual(
        expect.objectContaining({ id: "C", message: "not repaired: upstream 'B' failed" }),
      );
    }).pipe(withCloud(cloud));
  });

  test.provider("a failed diamond branch skips the leaf but not the other branch", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const root = yield* DriftResource("Root", {});
          const left = yield* DriftResource("Left", { dependsOn: [root.id] });
          const right = yield* DriftResource("Right", { dependsOn: [root.id] });
          yield* DriftResource("Leaf", { dependsOn: [left.id, right.id] });
        }),
      );
      for (const id of ["Root", "Left", "Right", "Leaf"]) cloud.resources.delete(id);

      cloud.calls.length = 0;
      const exit = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("Left", "create"))),
        Effect.exit,
      );

      failureOf(exit);
      expect(reconcileCalls(cloud).sort()).toEqual(["Left", "Right", "Root"]);
      expect(cloud.resources.has("Right")).toBe(true);
      expect(cloud.resources.has("Leaf")).toBe(false);
    }).pipe(withCloud(cloud));
  });

  test.provider("a failed dependent leaves its upstream repaired", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(chain("Topic", "Subscription"));
      cloud.resources.delete("Topic");
      cloud.resources.delete("Subscription");

      const exit = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("Subscription", "create"))),
        Effect.exit,
      );

      failureOf(exit);
      expect(cloud.resources.has("Topic")).toBe(true);
      expect(yield* getState("Topic")).toMatchObject({ status: "created" });
      const detected = yield* runDrift({ dryRun: true });
      expect(detected.resources).toMatchObject({
        Topic: { action: "unchanged" },
        Subscription: { action: "missing" },
      });
    }).pipe(withCloud(cloud));
  });

  test.provider("independent failures are all reported", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* DriftResource("X", {});
          yield* DriftResource("Y", {});
        }),
      );
      cloud.resources.delete("X");
      cloud.resources.get("Y")!.value = "hijacked";

      const exit = yield* runDrift().pipe(
        Effect.provide(
          Layer.succeed(
            TestResourceHooks,
            failOnMultiple([
              { id: "X", hook: "create" },
              { id: "Y", hook: "update" },
            ]),
          ),
        ),
        Effect.exit,
      );

      const rendered = failureOf(exit);
      expect(rendered).toContain("Resource 'X' (Test.DriftResource) failed during create");
      expect(rendered).toContain("Resource 'Y' (Test.DriftResource) failed during update");
    }).pipe(withCloud(cloud));
  });

  test.provider("a failed bare recreate skips attaching its bindings", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* DriftResource("A", {});
          yield* a.bind("Env", { env: { KEY: "on" } });
        }),
      );
      cloud.resources.delete("A");

      cloud.calls.length = 0;
      const exit = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("A", "create"))),
        Effect.exit,
      );

      failureOf(exit);
      expect(reconcileTrace(cloud)).toEqual(["A[]"]);
      // the row is untouched, so the resource is still reported missing
      expect(yield* getState("A")).toMatchObject({ bindings: [{ sid: "Env" }] });
      const detected = yield* runDrift({ dryRun: true });
      expect(detected.resources.A?.action).toEqual("missing");
    }).pipe(withCloud(cloud));
  });

  test.provider("an interrupted repair keeps finished repairs and resumes", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(chain("A", "B"));
      cloud.resources.delete("A");
      cloud.resources.delete("B");

      const exit = yield* runDrift().pipe(
        Effect.provide(
          Layer.succeed(TestResourceHooks, {
            create: (id: string) => (id === "B" ? Effect.never : Effect.void),
          }),
        ),
        Effect.timeout("200 millis"),
        Effect.exit,
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(cloud.resources.has("A")).toBe(true);
      expect(cloud.resources.has("B")).toBe(false);
      expect(yield* getState("B")).toMatchObject({ status: "created", attr: { value: "B" } });

      const result = yield* runDrift();
      expect(result.resources).toMatchObject({
        A: { action: "unchanged" },
        B: { action: "recreated" },
      });
    }).pipe(withCloud(cloud));
  });
});

describe("dependency order of drifted resources", { tags: ["unit", "local"] }, () => {
  test.provider("a drifted chain is repaired upstream first", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", { value: "topic" });
          yield* DriftResource("Subscription", { value: "sub", dependsOn: [topic.id] });
        }),
      );
      cloud.resources.get("Topic")!.value = "hijacked";
      cloud.resources.get("Subscription")!.value = "hijacked";

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources).toMatchObject({
        Topic: { action: "repaired" },
        Subscription: { action: "repaired" },
      });
      expect(reconcileCalls(cloud)).toEqual(["Topic", "Subscription"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a missing dependent of a drifted upstream is recreated first", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", { value: "topic" });
          yield* DriftResource("Subscription", { value: "sub", dependsOn: [topic.id] });
        }),
      );
      cloud.resources.get("Topic")!.value = "hijacked";
      cloud.resources.delete("Subscription");

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources).toMatchObject({
        Topic: { action: "repaired", attr: { value: "topic" } },
        Subscription: { action: "recreated" },
      });
      // recreations only need their upstream to exist, so they run before
      // any in-place repair
      expect(reconcileCalls(cloud)).toEqual(["Subscription", "Topic"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("independent drifted resources are repaired concurrently", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* DriftResource("X", { value: "x" });
          yield* DriftResource("Y", { value: "y" });
        }),
      );
      cloud.resources.get("X")!.value = "hijacked";
      cloud.resources.get("Y")!.value = "hijacked";

      const started = {
        X: yield* Deferred.make<void>(),
        Y: yield* Deferred.make<void>(),
      };
      const hooks = {
        update: (id: string) =>
          id === "X" || id === "Y"
            ? Deferred.succeed(started[id], undefined).pipe(
                Effect.andThen(Deferred.await(started[id === "X" ? "Y" : "X"])),
                Effect.timeout("2 seconds"),
              )
            : Effect.void,
      };
      const result = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, hooks)),
      );

      expect(result.resources).toMatchObject({
        X: { action: "repaired" },
        Y: { action: "repaired" },
      });
    }).pipe(withCloud(cloud));
  });

  test.provider("a stuck upstream is skipped and does not block its dependents", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", {});
          yield* DriftResource("Subscription", { dependsOn: [topic.id] });
        }),
      );
      const topic = yield* getState("Topic");
      yield* seed({ Topic: { ...topic, status: "creating" } });
      cloud.resources.delete("Subscription");

      const result = yield* runDrift();

      expect(result.resources).toMatchObject({
        Topic: { action: "skipped" },
        Subscription: { action: "recreated" },
      });
    }).pipe(withCloud(cloud));
  });
});

describe("persisted rows", { tags: ["unit", "local"] }, () => {
  const deployed = Effect.gen(function* () {
    const a = yield* DriftResource("A", { value: "a" }).pipe(RemovalPolicy.retain(true));
    yield* DriftResource("B", { value: "b", dependsOn: [a.id] });
    return a;
  }).pipe(Namespace.push("Site"));

  const carried = (row: ResourceState | undefined) => ({
    namespace: row?.namespace,
    instanceId: row?.instanceId,
    downstream: row?.downstream,
    removalPolicy: row?.removalPolicy,
    providerVersion: row?.providerVersion,
    props: row?.props,
    bindings: row?.bindings,
  });

  test.provider("a recreated row keeps everything but its attributes", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(deployed);
      const before = yield* getState("Site/A");
      expect(before?.removalPolicy).toEqual("retain");
      cloud.resources.delete("A");

      yield* runDrift();

      const after = yield* getState("Site/A");
      expect(after?.status).toEqual("created");
      expect(carried(after)).toEqual(carried(before));
    }).pipe(withCloud(cloud));
  });

  test.provider("a recreated and rebound row keeps everything but its attributes", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* deployed;
          yield* a.bind("Env", { env: { KEY: "on" } });
        }),
      );
      const before = yield* getState("Site/A");
      cloud.resources.delete("A");

      yield* runDrift();

      const after = yield* getState("Site/A");
      expect(after?.status).toEqual("created");
      expect(carried(after)).toEqual(carried(before));
    }).pipe(withCloud(cloud));
  });

  test.provider("a repaired row keeps everything but its attributes", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(deployed);
      const before = yield* getState("Site/A");
      cloud.resources.get("A")!.value = "hijacked";

      yield* runDrift();

      const after = yield* getState("Site/A");
      expect(after?.status).toEqual("updated");
      expect(carried(after)).toEqual(carried(before));
    }).pipe(withCloud(cloud));
  });

  test.provider("a recreated, rebound graph is unchanged on the next drift", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* DriftResource("Bucket", {});
          const topic = yield* DriftResource("Topic", { dependsOn: [bucket.id] });
          yield* bucket.bind("Notifications", { targets: [topic.id], env: { KEY: "on" } });
        }),
      );
      cloud.resources.delete("Bucket");
      cloud.resources.delete("Topic");
      yield* runDrift();

      cloud.calls.length = 0;
      const result = yield* runDrift();

      expect(result.resources).toMatchObject({
        Bucket: { action: "unchanged" },
        Topic: { action: "unchanged" },
      });
      expect(reconcileCalls(cloud)).toEqual([]);
    }).pipe(withCloud(cloud));
  });

  test.provider("the next deploy after a recreate is a noop", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      const program = Effect.gen(function* () {
        const a = yield* DriftResource("A", { value: "a" });
        yield* a.bind("Env", { env: { KEY: "on" } });
        yield* DriftResource("B", { dependsOn: [a.id] });
      });
      yield* stack.deploy(program);
      cloud.resources.delete("A");
      cloud.resources.delete("B");
      yield* runDrift();

      cloud.calls.length = 0;
      yield* stack.deploy(program);
      expect(reconcileCalls(cloud)).toEqual([]);
    }).pipe(withCloud(cloud));
  });
});

// Drift repairs a row with the provider variant of the mode that created it,
// and the repaired row keeps its stamp.
describe("provider modes", { tags: ["unit", "local"] }, () => {
  const callsFor = (stackName: string, op: "reconcile" | "delete") =>
    modalCalls.filter((c) => c.stack === stackName && c.op === op).map((c) => c.mode);

  test.provider("a local row is recreated by the local provider and stays local", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* inDev(stack.deploy(ModalResource("A", { value: "v" })));
      expect((yield* getState("A"))?.providerMode).toEqual("local");
      cloud.resources.delete("A");

      const before = callsFor(stack.name, "reconcile").length;
      const result = yield* runDrift();

      expect(result.resources.A).toMatchObject({
        action: "recreated",
        attr: { runtime: "local" },
      });
      expect(callsFor(stack.name, "reconcile").slice(before)).toEqual(["local"]);
      expect(yield* getState("A")).toMatchObject({ status: "created", providerMode: "local" });
    }).pipe(withCloud(cloud));
  });

  test.provider("a live row is repaired by the live provider and stays live", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(ModalResource("A", { value: "v" }));
      expect((yield* getState("A"))?.providerMode).toEqual("live");
      cloud.resources.get("A")!.value = "hijacked";

      const before = callsFor(stack.name, "reconcile").length;
      const result = yield* runDrift();

      expect(result.resources.A).toMatchObject({ action: "repaired", attr: { value: "v" } });
      expect(callsFor(stack.name, "reconcile").slice(before)).toEqual(["live"]);
      expect(yield* getState("A")).toMatchObject({ status: "updated", providerMode: "live" });
    }).pipe(withCloud(cloud));
  });

  test.provider("a repaired local row is not replaced by the next dev deploy", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* inDev(stack.deploy(ModalResource("A", { value: "v" })));
      const instanceId = (yield* getState("A"))?.instanceId;
      cloud.resources.delete("A");
      yield* runDrift();

      const before = callsFor(stack.name, "delete").length;
      yield* inDev(stack.deploy(ModalResource("A", { value: "v" })));

      expect(callsFor(stack.name, "delete").slice(before)).toEqual([]);
      expect(yield* getState("A")).toMatchObject({ instanceId, providerMode: "local" });
    }).pipe(withCloud(cloud));
  });
});

describe("repair progress", { tags: ["unit", "local"] }, () => {
  test.provider("repair reports each observation as it lands", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          yield* DriftResource("Clean", {});
          yield* DriftResource("Drifted", { value: "drifted" });
          yield* DriftResource("Missing", {});
        }),
      );
      cloud.resources.get("Drifted")!.value = "hijacked";
      cloud.resources.delete("Missing");

      const events: Array<Event> = [];
      yield* runDrift().pipe(
        onEvent((event) =>
          Effect.sync(() => {
            events.push(event);
          }),
        ),
      );

      const nodes = events.filter((event) => event.type === "plan.resource.completed");
      expect(Object.fromEntries(nodes.map((event) => [event.logicalId, event.action]))).toEqual({
        Clean: "noop",
        Drifted: "update",
        Missing: "create",
      });
      expect(nodes.map(({ completed }) => completed).sort()).toEqual([1, 2, 3]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a failed bind settles the row as failed, never created", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const a = yield* DriftResource("A", {});
          yield* a.bind("Env", { env: { KEY: "on" } });
        }),
      );
      cloud.resources.delete("A");

      const events: ApplyEvent[] = [];
      yield* runDrift({ events }).pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("A", "update"))),
        Effect.exit,
      );

      expect(statusesOf(events, "A")).toEqual(["creating", "fail"]);
    }).pipe(withCloud(cloud));
  });

  test.provider("a failed repair settles the row as failed", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(DriftResource("A", { value: "a" }));
      cloud.resources.get("A")!.value = "hijacked";

      const events: ApplyEvent[] = [];
      yield* runDrift({ events }).pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, failOn("A", "update"))),
        Effect.exit,
      );

      expect(statusesOf(events, "A")).toEqual(["updating", "fail"]);
    }).pipe(withCloud(cloud));
  });
});

describe("observation", { tags: ["unit", "local"] }, () => {
  test.provider("every resource is read concurrently, regardless of dependencies", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      yield* stack.deploy(
        Effect.gen(function* () {
          const topic = yield* DriftResource("Topic", {});
          yield* DriftResource("Subscription", { dependsOn: [topic.id] });
        }),
      );

      // Each read waits for the other to start: only concurrent reads finish.
      const started = {
        Topic: yield* Deferred.make<void>(),
        Subscription: yield* Deferred.make<void>(),
      };
      cloud.onRead = (id) =>
        id === "Topic" || id === "Subscription"
          ? Deferred.succeed(started[id], undefined).pipe(
              Effect.andThen(Deferred.await(started[id === "Topic" ? "Subscription" : "Topic"])),
              Effect.timeout("2 seconds"),
              Effect.orDie,
            )
          : Effect.void;

      const result = yield* runDrift({ dryRun: true });
      expect(result.resources).toMatchObject({
        Topic: { action: "unchanged" },
        Subscription: { action: "unchanged" },
      });
    }).pipe(withCloud(cloud));
  });
});

// Drift repairs from persisted, fully-resolved props: it has no stack
// program to re-evaluate. When a recreated upstream comes back with a new
// identity (an AWS-assigned ARN), dependents keep the old value until the
// next deploy re-resolves their props.
describe("recreated identities", { tags: ["unit", "local"] }, () => {
  const program = Effect.gen(function* () {
    const topic = yield* DriftResource("Topic", {});
    const subscription = yield* DriftResource("Subscription", { ref: topic.arn });
    return { topic: topic.arn, subscription: subscription.ref };
  });

  test.provider("a dependent picks up its upstream's new identity on the next deploy", (stack) => {
    const cloud = makeTestCloud();
    return Effect.gen(function* () {
      const before = yield* stack.deploy(program);
      expect(before).toEqual({ topic: "Topic#1", subscription: "Topic#1" });
      cloud.resources.delete("Topic");

      const result = yield* runDrift();
      expect(result.resources).toMatchObject({
        Topic: { action: "recreated", attr: { arn: "Topic#2" } },
        // still consistent with its persisted props, so drift leaves it
        Subscription: { action: "unchanged", attr: { ref: "Topic#1" } },
      });

      cloud.calls.length = 0;
      const after = yield* stack.deploy(program);
      expect(after).toEqual({ topic: "Topic#2", subscription: "Topic#2" });
      expect(reconcileCalls(cloud)).toEqual(["Subscription"]);
      expect(cloud.resources.get("Subscription")).toMatchObject({ ref: "Topic#2" });
    }).pipe(withCloud(cloud));
  });

  test.provider(
    "a dependent recreated alongside its upstream is corrected by the next deploy",
    (stack) => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* stack.deploy(program);
        cloud.resources.delete("Topic");
        cloud.resources.delete("Subscription");

        yield* runDrift();
        // recreated from its persisted props
        expect(cloud.resources.get("Subscription")).toMatchObject({ ref: "Topic#1" });

        const after = yield* stack.deploy(program);
        expect(after).toEqual({ topic: "Topic#2", subscription: "Topic#2" });
      }).pipe(withCloud(cloud));
    },
  );
});

describe("unstable statuses", { tags: ["unit", "local"] }, () => {
  const base = {
    fqn: "R",
    logicalId: "R",
    instanceId,
    resourceType: "Test.DriftResource",
    namespace: undefined,
    providerVersion: 0,
    props: { value: "v" },
    attr: { id: "R", value: "v", tags: {}, env: {} },
    bindings: [],
    downstream: [],
  };
  const old = { ...base, status: "created" };
  const rows = {
    creating: { ...base, status: "creating" },
    updating: {
      ...base,
      status: "updating",
      old: { props: base.props, attr: base.attr, bindings: [] },
    },
    replacing: { ...base, status: "replacing", deleteFirst: false, old },
    replaced: { ...base, status: "replaced", deleteFirst: false, old },
    deleting: { ...base, status: "deleting" },
  };

  for (const [status, row] of Object.entries(rows)) {
    test.provider(`a '${status}' row is skipped without touching the cloud`, () => {
      const cloud = makeTestCloud();
      return Effect.gen(function* () {
        yield* seed({ R: row });

        const result = yield* runDrift();

        expect(result.resources.R?.action).toEqual("skipped");
        expect(result.resources.R?.reason).toContain(
          status === "replacing" || status === "replaced" ? "replacement" : status,
        );
        expect(cloud.calls).toEqual([]);
        expect((yield* getState("R"))?.status).toEqual(status);
      }).pipe(withCloud(cloud));
    });
  }
});

describe("Redacted props and attributes", { tags: ["unit", "local"] }, () => {
  const secretAttrs = (string: string) => ({ string, redacted: Redacted.make("hunter2") }) as never;

  test.provider("an equal Redacted attribute is not drift", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(TestResource("A", { string: "x", redacted: Redacted.make("hunter2") }));
      const persisted = yield* getState<{ attr: TestResource["Attributes"] }>("A");

      const result = yield* runDrift().pipe(
        Effect.provide(
          Layer.succeed(TestResourceHooks, {
            read: () => Effect.succeed({ ...persisted!.attr, redacted: Redacted.make("hunter2") }),
          }),
        ),
      );

      expect(result.resources.A?.action).toEqual("unchanged");
    }),
  );

  test.provider("a recreate keeps Redacted props and attributes redacted", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(TestResource("A", { string: "x", redacted: Redacted.make("hunter2") }));

      const result = yield* runDrift().pipe(
        Effect.provide(Layer.succeed(TestResourceHooks, { read: () => Effect.succeed(undefined) })),
      );

      expect(result.resources.A?.action).toEqual("recreated");
      const state = yield* getState("A");
      expect(Redacted.isRedacted((state!.props as any).redacted)).toBe(true);
      expect(Redacted.value((state!.props as any).redacted)).toBe("hunter2");
      expect(Redacted.isRedacted((state!.attr as any).redacted)).toBe(true);
      expect(Redacted.value((state!.attr as any).redacted)).toBe("hunter2");
    }),
  );

  test.provider("a repair keeps Redacted props redacted", (stack) =>
    Effect.gen(function* () {
      yield* stack.deploy(TestResource("A", { string: "x", redacted: Redacted.make("hunter2") }));

      const result = yield* runDrift().pipe(
        Effect.provide(
          Layer.succeed(TestResourceHooks, { read: () => Effect.succeed(secretAttrs("hijacked")) }),
        ),
      );

      expect(result.resources.A?.action).toEqual("repaired");
      const state = yield* getState("A");
      expect((state!.attr as any).string).toEqual("x");
      expect(Redacted.value((state!.props as any).redacted)).toBe("hunter2");
      expect(Redacted.value((state!.attr as any).redacted)).toBe("hunter2");
    }),
  );
});
