/**
 * First-class local vs live provider modes.
 *
 * Covers the engine behavior added by ProviderMode / ProviderLayer.dual:
 *   - the resolved mode is stamped on state (`providerMode`) on every commit
 *   - dev runs resolve local providers; `remote()` opts a resource out of
 *     local emulation; mode-agnostic providers satisfy any requested mode
 *   - switching modes plans a REPLACEMENT; the old generation / orphan row
 *     is deleted with the provider variant of the mode that created it
 *   - unstamped (legacy) rows are assumed live, unless their attrs carry
 *     the `dev:` identity marker (then local)
 *   - conflicting mode decorations on the same FQN die loudly
 *   - the non-default variant is only constructed when demanded (laziness)
 *
 * Also unit-tests the LocalProvider.make lifecycle (config-hash noop/restart,
 * instanceId-guarded delete, invalidate, stop hook) by driving the generated
 * provider service directly.
 */
import { Cli } from "@/Cli/Cli.ts";
import type { AnnotateEvent, StatusChangeEvent } from "@/Cli/Event.ts";
import * as LocalProvider from "@/Local/LocalProvider.ts";
import * as Provider from "@/Provider.ts";
import { remote, type ProviderMode } from "@/ProviderMode.ts";
import { Resource } from "@/Resource";
import { Stack } from "@/Stack";
import { State, type ResourceState } from "@/State";
import * as Test from "@/Test/Alchemy";
import { describe, expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import {
  Bucket,
  inDev,
  ModalResource,
  modalBuilds,
  modalCalls,
  TestLayers,
} from "./test.resources.ts";

const { test } = Test.make({ providers: TestLayers() });

const getState = Effect.fn(function* (fqn: string) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  return (yield* state.get({
    stack: stk.name,
    stage: stk.stage,
    fqn,
  })) as ResourceState | undefined;
});

const setState = Effect.fn(function* (fqn: string, value: ResourceState) {
  const state = yield* yield* State;
  const stk = yield* Stack;
  yield* state.set({ stack: stk.name, stage: stk.stage, fqn, value });
});

const modal = (id: string, value?: string) =>
  Effect.gen(function* () {
    const a = yield* ModalResource(id, { value });
    return { runtime: a.runtime };
  });

const callsFor = (stackName: string) =>
  modalCalls.filter((c) => c.stack === stackName);
const buildsFor = (stackName: string) =>
  modalBuilds.filter((b) => b.stack === stackName);

describe("provider modes", () => {
  test.provider(
    "default mode is live; providerMode is stamped; local variant is never built",
    (stack) =>
      Effect.gen(function* () {
        const output = yield* modal("A", "v1").pipe(stack.deploy);
        expect(output.runtime).toEqual("live");

        const state = yield* getState("A");
        expect(state?.status).toEqual("created");
        expect(state?.providerMode).toEqual("live");

        // Laziness: nothing demanded the local variant in a live-default
        // run, so it must never have been constructed.
        expect(
          buildsFor(stack.name).filter((b) => b.mode === "local"),
        ).toHaveLength(0);
        expect(
          buildsFor(stack.name).filter((b) => b.mode === "live").length,
        ).toBeGreaterThan(0);

        yield* stack.destroy();
      }),
  );

  test.provider(
    "a dev run resolves the local provider; live-only resources stay live",
    (stack) =>
      Effect.gen(function* () {
        const output = yield* inDev(modal("A", "v1").pipe(stack.deploy));
        expect(output.runtime).toEqual("local");
        expect((yield* getState("A"))?.providerMode).toEqual("local");

        // A mode-agnostic resource in the same dev run deploys with its
        // single implementation and stays unstamped — constructs mixing
        // emulatable and live-only resources just work.
        yield* inDev(
          Effect.gen(function* () {
            yield* ModalResource("A", { value: "v1" });
            yield* Bucket("B", {});
            return {};
          }).pipe(stack.deploy),
        );
        expect((yield* getState("B"))?.providerMode).toBeUndefined();

        yield* stack.destroy();
      }),
  );

  test.provider(
    "remote() opts a resource out of local emulation during dev",
    (stack) =>
      Effect.gen(function* () {
        const output = yield* inDev(
          modal("A", "v1").pipe(remote(), stack.deploy),
        );
        expect(output.runtime).toEqual("live");
        expect((yield* getState("A"))?.providerMode).toEqual("live");

        // Dropping remote() in a later dev run switches it back to local —
        // a replacement like any other mode switch.
        const back = yield* inDev(modal("A", "v1").pipe(stack.deploy));
        expect(back.runtime).toEqual("local");
        expect((yield* getState("A"))?.providerMode).toEqual("local");

        yield* stack.destroy();
      }),
  );

  test.provider(
    "switching modes replaces: new mode creates, old mode deletes",
    (stack) =>
      Effect.gen(function* () {
        // 1. dev run: local instance.
        yield* inDev(modal("A", "v1").pipe(stack.deploy));
        expect((yield* getState("A"))?.providerMode).toEqual("local");
        const localInstanceId = (yield* getState("A"))?.instanceId;

        // 2. same props, deploy (live) run → the plan must be a
        //    replacement even though nothing about the props changed.
        const plan = yield* modal("A", "v1").pipe(stack.plan);
        expect(plan.resources["A"].action).toEqual("replace");

        // 3. apply: the live variant reconciles the new generation, the
        //    LOCAL variant (the mode that created it) deletes the old one.
        const before = callsFor(stack.name).length;
        const output = yield* modal("A", "v1").pipe(stack.deploy);
        expect(output.runtime).toEqual("live");

        const state = yield* getState("A");
        expect(state?.status).toEqual("created");
        expect(state?.providerMode).toEqual("live");
        expect(state?.instanceId).not.toEqual(localInstanceId);

        const calls = callsFor(stack.name).slice(before);
        expect(calls).toContainEqual({
          stack: stack.name,
          mode: "live",
          op: "reconcile",
          id: "A",
        });
        expect(calls).toContainEqual({
          stack: stack.name,
          mode: "local",
          op: "delete",
          id: "A",
        });

        // 4. switch back: live → local replaces again, deleted by LIVE.
        const beforeBack = callsFor(stack.name).length;
        const back = yield* inDev(modal("A", "v1").pipe(stack.deploy));
        expect(back.runtime).toEqual("local");
        expect((yield* getState("A"))?.providerMode).toEqual("local");
        expect(callsFor(stack.name).slice(beforeBack)).toContainEqual({
          stack: stack.name,
          mode: "live",
          op: "delete",
          id: "A",
        });

        yield* stack.destroy();
      }),
  );

  test.provider(
    "an orphaned local row is deleted by the local provider during a live run",
    (stack) =>
      Effect.gen(function* () {
        yield* inDev(modal("A", "v1").pipe(stack.deploy));

        // Remove the resource from the program and deploy in (default)
        // live mode — the orphan delete must still route to the LOCAL
        // variant, since that's the mode that created the row.
        const before = callsFor(stack.name).length;
        yield* Effect.succeed({}).pipe(stack.deploy);

        expect(yield* getState("A")).toBeUndefined();
        expect(callsFor(stack.name).slice(before)).toContainEqual({
          stack: stack.name,
          mode: "local",
          op: "delete",
          id: "A",
        });
      }),
  );

  test.provider("unstamped (legacy) rows are assumed live", (stack) =>
    Effect.gen(function* () {
      yield* modal("A", "v1").pipe(stack.deploy);
      const row = yield* getState("A");
      expect(row?.providerMode).toEqual("live");

      // Simulate a row written before providerMode existed.
      yield* setState("A", { ...row!, providerMode: undefined });

      // A live run sees no churn: unstamped = live.
      const plan = yield* modal("A", "v1").pipe(stack.plan);
      expect(plan.resources["A"].action).toEqual("noop");

      // A dev run must treat the unstamped row exactly like a stamped
      // live row: replacement, with the old generation deleted by the
      // LIVE provider. Assuming "current run's mode" instead silently
      // adopts the deployed live resource as a local instance — the
      // row re-stamps local and the live resource leaks untracked.
      const devPlan = yield* inDev(modal("A", "v1").pipe(stack.plan));
      expect(devPlan.resources["A"].action).toEqual("replace");

      const before = callsFor(stack.name).length;
      const output = yield* inDev(modal("A", "v1").pipe(stack.deploy));
      expect(output.runtime).toEqual("local");
      expect((yield* getState("A"))?.providerMode).toEqual("local");
      expect(callsFor(stack.name).slice(before)).toContainEqual({
        stack: stack.name,
        mode: "live",
        op: "delete",
        id: "A",
      });

      yield* stack.destroy();
    }),
  );

  test.provider(
    "a legacy unstamped row with dev:-marker identity is deleted by the local provider",
    (stack) =>
      Effect.gen(function* () {
        // Simulate a row written by `alchemy dev` on a pre-stamping version
        // (e.g. 2.0.0-beta.64): reconciled by the local provider (so its
        // attrs carry the `dev:` identity marker) but persisted without a
        // providerMode stamp.
        yield* inDev(modal("A", "v1").pipe(stack.deploy));
        const row = yield* getState("A");
        expect(row?.providerMode).toEqual("local");
        expect((row?.attr as { instance: string }).instance).toMatch(/^dev:/);
        yield* setState("A", { ...row!, providerMode: undefined });

        // A dev run sees no churn: the marker infers "local", matching the
        // run's mode — legacy dev rows continue seamlessly under dev.
        const devPlan = yield* inDev(modal("A", "v1").pipe(stack.plan));
        expect(devPlan.resources["A"].action).toEqual("noop");

        // A plain (live-mode) destroy must infer "local" from the marker
        // and route the delete to the local variant — never hand the `dev:`
        // identity to the live provider (the cloud API rejects it).
        const before = callsFor(stack.name).length;
        yield* stack.destroy();

        expect(yield* getState("A")).toBeUndefined();
        const deletes = callsFor(stack.name)
          .slice(before)
          .filter((c) => c.op === "delete");
        expect(deletes).toEqual([
          { stack: stack.name, mode: "local", op: "delete", id: "A" },
        ]);
      }),
  );

  test.provider(
    "a live deploy over a legacy unstamped local row replaces via the marker-inferred mode",
    (stack) =>
      Effect.gen(function* () {
        yield* inDev(modal("A", "v1").pipe(stack.deploy));
        const row = yield* getState("A");
        yield* setState("A", { ...row!, providerMode: undefined });

        // Identical props, but the marker infers the row is local and this
        // run resolves live → mode-switch replacement, not a live
        // reconcile against the `dev:` identity.
        const plan = yield* modal("A", "v1").pipe(stack.plan);
        expect(plan.resources["A"].action).toEqual("replace");

        const before = callsFor(stack.name).length;
        const output = yield* modal("A", "v1").pipe(stack.deploy);
        expect(output.runtime).toEqual("live");
        expect((yield* getState("A"))?.providerMode).toEqual("live");

        const calls = callsFor(stack.name).slice(before);
        expect(calls).toContainEqual({
          stack: stack.name,
          mode: "live",
          op: "reconcile",
          id: "A",
        });
        // The old (legacy dev) generation is torn down by the LOCAL variant.
        expect(calls).toContainEqual({
          stack: stack.name,
          mode: "local",
          op: "delete",
          id: "A",
        });

        yield* stack.destroy();
      }),
  );

  test.provider(
    "mode-agnostic providers never replace on a mode switch",
    (stack) =>
      Effect.gen(function* () {
        const program = Effect.gen(function* () {
          yield* Bucket("B", {});
          return {};
        });
        yield* inDev(program.pipe(stack.deploy));
        expect((yield* getState("B"))?.providerMode).toBeUndefined();

        const plan = yield* program.pipe(stack.plan);
        expect(plan.resources["B"].action).toEqual("noop");

        yield* stack.destroy();
      }),
  );

  test.provider(
    "conflicting mode decorations on the same resource die",
    (stack) =>
      Effect.gen(function* () {
        const exit = yield* Effect.gen(function* () {
          yield* ModalResource("A", { value: "v1" });
          yield* ModalResource("A", { value: "v1" }).pipe(remote());
          return {};
        }).pipe(stack.deploy, Effect.exit);

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          const defects = exit.cause.reasons.flatMap((reason) =>
            reason._tag === "Die" ? [reason.defect as any] : [],
          );
          expect(
            defects.some((d) => d?._tag === "ConflictingProviderModeError"),
          ).toBe(true);
        }

        // Re-registering WITHOUT an explicit ambient mode inherits the
        // original registration — the common "reference it from elsewhere"
        // pattern must keep working.
        const output = yield* inDev(
          Effect.gen(function* () {
            yield* ModalResource("A", { value: "v1" }).pipe(remote());
            const again = yield* ModalResource("A", { value: "v1" });
            return { runtime: again.runtime };
          }).pipe(stack.deploy),
        );
        expect(output.runtime).toEqual("live");

        yield* stack.destroy();
      }),
  );

  test.provider(
    "status events carry the resolved mode, the plan carries the run default, and mode switches carry the transition",
    (stack) =>
      Effect.gen(function* () {
        const events: StatusChangeEvent[] = [];
        const notes: AnnotateEvent[] = [];
        let planDefaultMode: ProviderMode | undefined;
        const cli = Cli.of({
          approvePlan: () => Effect.succeed(true),
          displayPlan: () => Effect.void,
          startApplySession: (plan) =>
            Effect.sync(() => {
              planDefaultMode = plan.defaultMode;
              return {
                done: () => Effect.void,
                emit: (event) =>
                  Effect.sync(() => {
                    if (event.kind === "status-change") events.push(event);
                    if (event.kind === "annotate") notes.push(event);
                  }),
              };
            }),
        });
        const withCli = Effect.provide(Layer.succeed(Cli, cli));

        // 1. live deploy: the plan's default mode is "live" and every
        //    status event for the dual-mode resource is stamped with it.
        yield* modal("A", "v1").pipe(stack.deploy, withCli);
        expect(planDefaultMode).toEqual("live");
        const liveEvents = events.filter((e) => e.id === "A");
        expect(liveEvents.length).toBeGreaterThan(0);
        expect(liveEvents.every((e) => e.providerMode === "live")).toBe(true);
        expect(liveEvents.every((e) => e.fromProviderMode === undefined)).toBe(
          true,
        );
        // Live rows never announce a ready-at URL.
        expect(notes.some((n) => n.message.startsWith("ready at"))).toBe(false);

        // 2. dev run: default flips to "local"; the mode switch is planned
        //    as a replacement whose events carry the transition
        //    (fromProviderMode "live" → providerMode "local"). The old
        //    generation's GC is deliberately silent (progress stays anchored
        //    on the live replacement), so no delete-status assertions here.
        events.length = 0;
        notes.length = 0;
        yield* inDev(modal("A", "v1").pipe(stack.deploy, withCli));
        expect(planDefaultMode).toEqual("local");
        const transitions = events.filter(
          (e) => e.id === "A" && e.fromProviderMode !== undefined,
        );
        expect(transitions.length).toBeGreaterThan(0);
        expect(
          transitions.every(
            (e) => e.providerMode === "local" && e.fromProviderMode === "live",
          ),
        ).toBe(true);
        // A local instance whose attrs carry a `url` announces it.
        expect(notes).toContainEqual({
          kind: "annotate",
          id: "A",
          message: "ready at http://localhost:1337",
        });

        // 3. destroy while stamped local: delete events carry the row's
        //    stamped mode even though the run default is live.
        events.length = 0;
        yield* stack.destroy().pipe(withCli);
        const destroyDeletes = events.filter(
          (e) => e.id === "A" && e.status === "deleted",
        );
        expect(destroyDeletes.length).toBeGreaterThan(0);
        expect(destroyDeletes.every((e) => e.providerMode === "local")).toBe(
          true,
        );
      }),
  );
});

// ── LocalProvider.make lifecycle ────────────────────────────────────────────
//
// Drives the generated provider service directly (no engine) so noop /
// restart / delete semantics are observable across sequential calls against
// ONE provider instance — scratch deploys rebuild providers per deploy, which
// would reset the in-memory instance registry between steps.

interface LocalThing extends Resource<
  "Test.LocalThing",
  { value?: string; ignored?: string },
  { value: string }
> {}
const LocalThing = Resource<LocalThing>("Test.LocalThing");

const localThingEvents: string[] = [];
let capturedInvalidate: Effect.Effect<void> | undefined;

type LocalThingConfig = { value: string | undefined };

const localThingProvider = () =>
  LocalProvider.make(
    LocalThing,
    import.meta.url, // unused: no RpcProviderProxy in tests → in-process
    Effect.gen(function* () {
      return {
        // `ignored` is excluded from the restart-relevant config: changing
        // it must NOT restart the instance.
        resolveConfig: ({
          news,
        }: LocalProvider.LocalProviderInput<LocalThing>) =>
          Effect.succeed<LocalThingConfig>({ value: news?.value }),
        start: Effect.fn(function* ({
          id,
          config,
          invalidate,
        }: LocalProvider.StartContext<LocalThing, LocalThingConfig>) {
          localThingEvents.push(`start:${id}:${config.value ?? ""}`);
          capturedInvalidate = invalidate;
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              localThingEvents.push(`kill:${id}`);
            }),
          );
          return { value: config.value ?? id };
        }),
        stop: ({ id }: LocalProvider.StopContext) =>
          Effect.sync(() => {
            localThingEvents.push(`stop:${id}`);
          }),
      };
    }),
  );

const fakeSession = {
  note: () => Effect.void,
  emit: () => Effect.void,
} as any;

const lifecycleInput = (instanceId: string, news: LocalThing["Props"]) => ({
  id: "A",
  fqn: "A",
  instanceId,
  news,
  // The generated diff/reconcile never consult olds — the running instance's
  // recorded config is the baseline (state can't know if the process lives).
  olds: {} as LocalThing["Props"],
  output: undefined,
  oldBindings: [] as any[],
  newBindings: [] as any[],
  bindings: [] as any[],
  session: fakeSession,
});

test(
  "LocalProvider.make: config-hash noop/restart, guarded delete, invalidate, stop",
  Effect.gen(function* () {
    const provider = yield* Provider.findProvider(LocalThing);
    localThingEvents.length = 0;

    // create
    const attrs1 = yield* provider.reconcile(
      lifecycleInput("i1", {
        value: "v1",
      }),
    );
    expect(attrs1).toEqual({ value: "v1" });
    expect(localThingEvents).toEqual(["start:A:v1"]);

    // same config → diff noop, reconcile joins the running instance
    expect(
      yield* provider.diff!(lifecycleInput("i1", { value: "v1" })),
    ).toEqual({ action: "noop" });
    yield* provider.reconcile(lifecycleInput("i1", { value: "v1" }));
    expect(localThingEvents).toEqual(["start:A:v1"]);

    // config change that normalizes away (`ignored` not in resolveConfig)
    // → still a noop
    expect(
      yield* provider.diff!(
        lifecycleInput("i1", { value: "v1", ignored: "x" }),
      ),
    ).toEqual({ action: "noop" });

    // real config change → update; reconcile kills then restarts
    expect(
      yield* provider.diff!(lifecycleInput("i1", { value: "v2" })),
    ).toEqual({ action: "update" });
    yield* provider.reconcile(lifecycleInput("i1", { value: "v2" }));
    expect(localThingEvents).toEqual(["start:A:v1", "kill:A", "start:A:v2"]);

    // delete with a STALE instanceId (replacement ordering) must not touch
    // the running instance nor run `stop`
    yield* provider.delete(lifecycleInput("i0", { value: "v2" }) as any);
    expect(localThingEvents).toEqual(["start:A:v1", "kill:A", "start:A:v2"]);

    // invalidate (process died on its own) → next diff is an update
    yield* capturedInvalidate!;
    expect(
      yield* provider.diff!(lifecycleInput("i1", { value: "v2" })),
    ).toEqual({ action: "update" });
    yield* provider.reconcile(lifecycleInput("i1", { value: "v2" }));

    // matching delete tears down and runs stop
    yield* provider.delete(lifecycleInput("i1", { value: "v2" }) as any);
    expect(localThingEvents.slice(-2)).toEqual(["kill:A", "stop:A"]);

    // idempotent: deleting again only re-runs the (idempotent) stop hook
    yield* provider.delete(lifecycleInput("i1", { value: "v2" }) as any);
    expect(localThingEvents.slice(-2)).toEqual(["stop:A", "stop:A"]);
  }).pipe(
    Effect.provide(localThingProvider()),
    Effect.provide(
      Layer.succeed(Stack, {
        name: "local-provider-test",
        stage: "test",
        resources: {},
        bindings: {},
        actions: {},
      }),
    ),
  ),
);
