import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Scope from "effect/Scope";

import type { PluginRuntime, PluginRuntimeReconcileError } from "../src/runtime.ts";

import type {
  PluginDefinition,
  PluginRuntimeOptions,
  PluginRuntimeSnapshot,
} from "../src/contract.ts";

type TestPluginRuntimeFactory = (
  options?: PluginRuntimeOptions,
) => Effect.Effect<PluginRuntime["Service"], never, Scope.Scope>;

const makeEffectCallback = <A, E, R = never>() => {
  let unsafeResume: (effect: Effect.Effect<A, E, R>) => void = () => {
    throw new Error("effect callback has not started");
  };
  return {
    await: Effect.callback<A, E, R>((resume) => {
      unsafeResume = resume;
    }),
    resume: (effect: Effect.Effect<A, E, R>) => unsafeResume(effect),
  } as const;
};

const failureOf = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.exit(effect).pipe(
    Effect.map((exit) => (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined)),
  );

const settlePromise = (
  exit: Exit.Exit<unknown, unknown>,
  resolve: () => void,
  reject: (error: unknown) => void,
) => {
  if (Exit.isFailure(exit)) reject(Cause.squash(exit.cause));
  else resolve();
};

const contributionLabels = (snapshot: PluginRuntimeSnapshot, slot: string) =>
  snapshot.contributions[slot]?.map((item) => item.label) ?? [];

const failureCause = (error: unknown): unknown =>
  typeof error === "object" && error !== null && "cause" in error
    ? (error as { readonly cause: unknown }).cause
    : error;

const failureMessage = (error: unknown): string => {
  const cause = failureCause(error);
  return cause instanceof Error ? cause.message : String(cause);
};

const provider = (version = "1.0.0"): PluginDefinition => ({
  id: "acme.database",
  version,
  provides: { "acme.database@1": { name: `database-${version}` } },
  activate(context) {
    context.register("status", { id: "database", label: `database ${version}` });
  },
});

const consumer = (): PluginDefinition => ({
  id: "acme.issues",
  version: "1.0.0",
  requires: ["acme.database@1"],
  activate(context) {
    const database = context.resolve<{ readonly name: string }>("acme.database@1");
    context.register("commands", { id: "create-issue", label: database.name });
  },
});

export function defineRuntimeContract(name: string, createRuntime: TestPluginRuntimeFactory) {
  describe(name, () => {
    it.effect("activates providers before consumers regardless of manifest order", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* createRuntime();

          const snapshot = yield* runtime.reconcile([consumer(), provider()]);

          expect(snapshot.active).toEqual(["acme.database", "acme.issues"]);
          expect(contributionLabels(snapshot, "commands")).toEqual(["database-1.0.0"]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("blocks missing dependencies without blocking independent plugins", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* createRuntime();
          const independent: PluginDefinition = {
            id: "acme.clock",
            version: "1.0.0",
            activate(context) {
              context.register("status", { id: "clock", label: "clock" });
            },
          };

          const snapshot = yield* runtime.reconcile([consumer(), independent]);

          expect(snapshot.active).toEqual(["acme.clock"]);
          expect(snapshot.blocked["acme.issues"]).toContain("acme.database@1");
          expect(contributionLabels(snapshot, "status")).toEqual(["clock"]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("deactivates dependents before providers", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lifecycle: Array<string> = [];
          const runtime = yield* createRuntime({
            onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
          });
          yield* runtime.reconcile([provider(), consumer()]);
          lifecycle.length = 0;

          yield* runtime.reconcile([]);

          expect(lifecycle).toEqual(["deactivate:acme.issues", "deactivate:acme.database"]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("runs plugin finalizers in reverse registration order", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const disposed: Array<string> = [];
          const runtime = yield* createRuntime();
          yield* runtime.reconcile([
            {
              id: "acme.finalizers",
              version: "1.0.0",
              activate(context) {
                context.onDispose(() => {
                  disposed.push("first");
                });
                context.onDispose(() => {
                  disposed.push("second");
                });
              },
            },
          ]);

          yield* runtime.reconcile([]);

          expect(disposed).toEqual(["second", "first"]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("keeps unchanged plugin scopes alive across reconciliation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let activations = 0;
          let disposals = 0;
          const stable: PluginDefinition = {
            id: "acme.stable",
            version: "1.0.0",
            activate(context) {
              activations += 1;
              context.onDispose(() => {
                disposals += 1;
              });
            },
          };
          const runtime = yield* createRuntime();

          yield* runtime.reconcile([stable]);
          yield* runtime.reconcile([stable]);

          expect(activations).toBe(1);
          expect(disposals).toBe(0);
          yield* runtime.dispose;
          expect(disposals).toBe(1);
        }),
      ),
    );

    it.effect("treats reordered requirements and providers as the same definition", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let activations = 0;
          const firstService = {};
          const secondService = {};
          const activate: PluginDefinition["activate"] = () => {
            activations += 1;
          };
          const dependencies: ReadonlyArray<PluginDefinition> = [
            {
              id: "acme.first-dependency",
              version: "1.0.0",
              provides: { "acme.first@1": true },
              activate() {},
            },
            {
              id: "acme.second-dependency",
              version: "1.0.0",
              provides: { "acme.second@1": true },
              activate() {},
            },
          ];
          const runtime = yield* createRuntime();
          yield* runtime.reconcile([
            ...dependencies,
            {
              id: "acme.stable-order",
              version: "1.0.0",
              requires: ["acme.first@1", "acme.second@1"],
              provides: { "acme.output-one@1": firstService, "acme.output-two@1": secondService },
              activate,
            },
          ]);

          yield* runtime.reconcile([
            ...dependencies,
            {
              id: "acme.stable-order",
              version: "1.0.0",
              requires: ["acme.second@1", "acme.first@1"],
              provides: { "acme.output-two@1": secondService, "acme.output-one@1": firstService },
              activate,
            },
          ]);

          expect(activations).toBe(1);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("restarts a plugin when its activation implementation changes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* createRuntime();
          const first: PluginDefinition = {
            id: "acme.implementation",
            version: "1.0.0",
            activate(context) {
              context.register("commands", { id: "implementation", label: "first" });
            },
          };
          const second: PluginDefinition = {
            id: "acme.implementation",
            version: "1.0.0",
            activate(context) {
              context.register("commands", { id: "implementation", label: "second" });
            },
          };

          yield* runtime.reconcile([first]);
          const snapshot = yield* runtime.reconcile([second]);

          expect(contributionLabels(snapshot, "commands")).toEqual(["second"]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect(
      "restarts a changed provider and its dependents without touching independent plugins",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            let independentActivations = 0;
            const lifecycle: Array<string> = [];
            const independent: PluginDefinition = {
              id: "acme.independent",
              version: "1.0.0",
              activate() {
                independentActivations += 1;
              },
            };
            const runtime = yield* createRuntime({
              onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
            });
            yield* runtime.reconcile([consumer(), independent, provider()]);
            lifecycle.length = 0;

            const snapshot = yield* runtime.reconcile([consumer(), independent, provider("2.0.0")]);

            expect(independentActivations).toBe(1);
            expect(lifecycle).not.toContain("activate:acme.independent");
            expect(lifecycle).not.toContain("deactivate:acme.independent");
            expect(lifecycle.filter((event) => event.startsWith("activate:"))).toEqual([
              "activate:acme.database",
              "activate:acme.issues",
            ]);
            expect(lifecycle.filter((event) => event.startsWith("deactivate:"))).toEqual([
              "deactivate:acme.issues",
              "deactivate:acme.database",
            ]);
            expect(contributionLabels(snapshot, "commands")).toEqual(["database-2.0.0"]);
            yield* runtime.dispose;
          }),
        ),
    );

    it.effect("returns deeply frozen snapshots", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* createRuntime();

          const snapshot = yield* runtime.reconcile([provider()]);
          const status = snapshot.contributions.status;

          expect(Object.isFrozen(snapshot)).toBe(true);
          expect(Object.isFrozen(snapshot.active)).toBe(true);
          expect(Object.isFrozen(snapshot.blocked)).toBe(true);
          expect(Object.isFrozen(snapshot.contributions)).toBe(true);
          expect(Object.isFrozen(status)).toBe(true);
          expect(Object.isFrozen(status?.[0])).toBe(true);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("detaches registered contributions from later plugin mutation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const contribution = { id: "mutable", label: "original" };
          const plugin: PluginDefinition = {
            id: "acme.mutable-contribution",
            version: "1.0.0",
            activate(context) {
              context.register("commands", contribution);
            },
          };
          const unrelated: PluginDefinition = {
            id: "acme.unrelated-contribution",
            version: "1.0.0",
            activate() {},
          };
          const runtime = yield* createRuntime();
          yield* runtime.reconcile([plugin]);

          contribution.label = "changed";
          const snapshot = yield* runtime.reconcile([plugin, unrelated]);

          expect(contributionLabels(snapshot, "commands")).toEqual(["original"]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("treats every plugin id and contribution slot as data", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* createRuntime();
          const unusualProvider: PluginDefinition = {
            id: "toString",
            version: "1.0.0",
            provides: { "acme.unusual@1": "available" },
            activate(context) {
              context.register("__proto__", { id: "provider", label: "provider" });
            },
          };
          const unusualConsumer: PluginDefinition = {
            id: "constructor",
            version: "1.0.0",
            requires: ["acme.unusual@1"],
            activate(context) {
              context.resolve("acme.unusual@1");
              context.register("toString", { id: "consumer", label: "consumer" });
            },
          };
          const unusualBlocked: PluginDefinition = {
            id: "__proto__",
            version: "1.0.0",
            requires: ["acme.missing@1"],
            activate() {
              throw new Error("blocked plugin activated");
            },
          };

          const snapshot = yield* runtime.reconcile([
            unusualConsumer,
            unusualProvider,
            unusualBlocked,
          ]);

          expect(snapshot.active).toEqual(["toString", "constructor"]);
          expect(Object.hasOwn(snapshot.blocked, "__proto__")).toBe(true);
          expect(snapshot.blocked.__proto__).toContain("acme.missing@1");
          expect(Object.hasOwn(snapshot.contributions, "__proto__")).toBe(true);
          expect(Object.hasOwn(snapshot.contributions, "toString")).toBe(true);
          expect(contributionLabels(snapshot, "__proto__")).toEqual(["provider"]);
          expect(contributionLabels(snapshot, "toString")).toEqual(["consumer"]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("restarts dependents when a provided value changes", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lifecycle: Array<string> = [];
          const runtime = yield* createRuntime({
            onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
          });
          const serviceProvider = (name: string): PluginDefinition => ({
            id: "acme.service",
            version: "1.0.0",
            provides: { "acme.service@1": { name } },
            activate() {},
          });
          const serviceConsumer: PluginDefinition = {
            id: "acme.service-consumer",
            version: "1.0.0",
            requires: ["acme.service@1"],
            activate(context) {
              const service = context.resolve<{ readonly name: string }>("acme.service@1");
              context.register("commands", { id: "service", label: service.name });
            },
          };
          yield* runtime.reconcile([serviceProvider("first"), serviceConsumer]);
          lifecycle.length = 0;

          const snapshot = yield* runtime.reconcile([serviceProvider("second"), serviceConsumer]);

          expect(contributionLabels(snapshot, "commands")).toEqual(["second"]);
          expect(lifecycle.filter((event) => event.startsWith("activate:"))).toEqual([
            "activate:acme.service",
            "activate:acme.service-consumer",
          ]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("does not report a rolled-back candidate as activated", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const lifecycle: Array<string> = [];
          const runtime = yield* createRuntime({
            onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
          });
          const staged: PluginDefinition = {
            id: "acme.staged",
            version: "1.0.0",
            activate() {},
          };
          const broken: PluginDefinition = {
            id: "acme.broken",
            version: "1.0.0",
            activate() {
              throw new Error("activation failed");
            },
          };

          const stagingFailure = yield* failureOf(runtime.reconcile([staged, broken]));
          expect(failureMessage(stagingFailure)).toContain("activation failed");

          expect(lifecycle).toEqual([]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("preserves activation failures when rollback cleanup also fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const activationError = new Error("activation failed");
          const cleanupError = new Error("rollback cleanup failed");
          const cleanupEvents: Array<{ readonly phase: string; readonly error: unknown }> = [];
          const runtime = yield* createRuntime({
            onCleanupError: (event) => {
              cleanupEvents.push(event);
              throw new Error("cleanup observer failed");
            },
          });
          const broken: PluginDefinition = {
            id: "acme.rollback-error",
            version: "1.0.0",
            activate(context) {
              context.onDispose(() => {
                throw cleanupError;
              });
              throw activationError;
            },
          };

          const activationFailure = yield* failureOf(runtime.reconcile([broken]));
          expect(failureCause(activationFailure)).toBe(activationError);
          expect(cleanupEvents).toHaveLength(1);
          expect(cleanupEvents[0]?.phase).toBe("rollback");
          expect(failureCause(cleanupEvents[0]?.error)).toBe(cleanupError);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect(
      "returns the committed snapshot when retiring an old plugin reports cleanup errors",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            const cleanupError = new Error("retirement cleanup failed");
            const cleanupEvents: Array<{ readonly phase: string; readonly error: unknown }> = [];
            const runtime = yield* createRuntime({
              onCleanupError: (event) => {
                cleanupEvents.push(event);
                throw new Error("cleanup observer failed");
              },
            });
            yield* runtime.reconcile([
              {
                id: "acme.retirement-error",
                version: "1.0.0",
                activate(context) {
                  context.register("commands", { id: "retirement", label: "old" });
                  context.onDispose(() => {
                    throw cleanupError;
                  });
                },
              },
            ]);

            const snapshot = yield* runtime.reconcile([
              {
                id: "acme.retirement-error",
                version: "2.0.0",
                activate(context) {
                  context.register("commands", { id: "retirement", label: "new" });
                },
              },
            ]);

            expect(contributionLabels(snapshot, "commands")).toEqual(["new"]);
            expect(yield* runtime.snapshot).toBe(snapshot);
            expect(cleanupEvents).toHaveLength(1);
            expect(cleanupEvents[0]?.phase).toBe("retire");
            expect(failureCause(cleanupEvents[0]?.error)).toBe(cleanupError);
            yield* runtime.dispose;
          }),
        ),
    );

    it.effect("does not let lifecycle observers interrupt a committed transition", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let oldDisposed = false;
          const observerErrors: Array<string> = [];
          const runtime = yield* createRuntime({
            onLifecycle: ({ phase, pluginId }) => {
              throw new Error(`${phase}:${pluginId}`);
            },
            onLifecycleError: ({ phase, pluginId }) => {
              observerErrors.push(`${phase}:${pluginId}`);
            },
          });
          yield* runtime.reconcile([
            {
              id: "acme.lifecycle-observer",
              version: "1.0.0",
              activate(context) {
                context.onDispose(() => {
                  oldDisposed = true;
                });
              },
            },
          ]);

          const snapshot = yield* runtime.reconcile([
            {
              id: "acme.lifecycle-observer",
              version: "2.0.0",
              activate(context) {
                context.register("commands", { id: "observer", label: "committed" });
              },
            },
          ]);

          expect(oldDisposed).toBe(true);
          expect(contributionLabels(snapshot, "commands")).toEqual(["committed"]);
          expect(observerErrors).toEqual([
            "activate:acme.lifecycle-observer",
            "activate:acme.lifecycle-observer",
            "deactivate:acme.lifecycle-observer",
          ]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("rejects runtime operations reentered from plugin activation", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* createRuntime();
          const nested = makeEffectCallback<Exit.Exit<PluginRuntimeSnapshot, unknown>, never>();
          const nestedFiber = yield* Effect.forkChild(nested.await);
          yield* Effect.yieldNow;
          let settleActivation!: (exit: Exit.Exit<unknown, unknown>) => void;
          const activationGate = new Promise<void>((resolve, reject) => {
            settleActivation = (exit) => settlePromise(exit, resolve, reject);
          });
          const reentrant: PluginDefinition = {
            id: "acme.reentrant",
            version: "1.0.0",
            activate() {
              nested.resume(
                Effect.exit(runtime.reconcile([])).pipe(
                  Effect.tap((exit) => Effect.sync(() => settleActivation(exit))),
                ),
              );
              return activationGate;
            },
          };
          const activationFailure = yield* failureOf(runtime.reconcile([reentrant]));
          yield* Fiber.join(nestedFiber);

          expect(failureMessage(activationFailure)).toContain("reentrant");
        }),
      ),
    );

    it.effect("rejects runtime operations reentered from plugin finalizers", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* createRuntime();
          const nested = makeEffectCallback<Exit.Exit<void, unknown>, never>();
          const nestedFiber = yield* Effect.forkChild(nested.await);
          yield* Effect.yieldNow;
          let finishFinalizer!: (exit: Exit.Exit<void, unknown>) => void;
          const finalizerGate = new Promise<void>((resolve) => {
            finishFinalizer = () => resolve();
          });
          yield* runtime.reconcile([
            {
              id: "acme.reentrant-finalizer",
              version: "1.0.0",
              activate(context) {
                context.onDispose(() => {
                  nested.resume(
                    Effect.exit(runtime.dispose).pipe(
                      Effect.tap((exit) => Effect.sync(() => finishFinalizer(exit))),
                    ),
                  );
                  return finalizerGate;
                });
              },
            },
          ]);
          const snapshot = yield* runtime.reconcile([]);
          const nestedExit = yield* Fiber.join(nestedFiber);
          const nestedFailure = Exit.isFailure(nestedExit)
            ? Cause.squash(nestedExit.cause)
            : undefined;

          expect(snapshot).toBeDefined();
          expect(nestedFailure).toBeInstanceOf(Error);
          expect((nestedFailure as Error).message).toContain("reentrant");
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect(
      "allows descendant tasks to use the runtime after their plugin callback settles",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            let releaseBackground!: () => void;
            const gate = new Promise<void>((resolve) => {
              releaseBackground = resolve;
            });
            const runtime = yield* createRuntime();
            const background = makeEffectCallback<
              PluginRuntimeSnapshot,
              PluginRuntimeReconcileError
            >();
            const backgroundFiber = yield* Effect.forkChild(background.await);
            yield* Effect.yieldNow;

            yield* runtime.reconcile([
              {
                id: "acme.background-task",
                version: "1.0.0",
                activate() {
                  void gate.then(() => background.resume(runtime.reconcile([])));
                },
              },
            ]);

            releaseBackground();
            expect(yield* Fiber.join(backgroundFiber)).toBeDefined();
            yield* runtime.dispose;
          }),
        ),
    );

    it.effect("allows microtasks spawned by synchronous plugin callbacks to use the runtime", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let backgroundScheduled = false;
          const runtime = yield* createRuntime();
          const background = makeEffectCallback<
            PluginRuntimeSnapshot,
            PluginRuntimeReconcileError
          >();
          const backgroundFiber = yield* Effect.forkChild(background.await);
          yield* Effect.yieldNow;

          yield* runtime.reconcile([
            {
              id: "acme.microtask",
              version: "1.0.0",
              activate() {
                queueMicrotask(() => {
                  backgroundScheduled = true;
                  background.resume(runtime.reconcile([]));
                });
              },
            },
          ]);

          expect(backgroundScheduled).toBe(true);
          expect(yield* Fiber.join(backgroundFiber)).toBeDefined();
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect(
      "allows microtasks spawned by synchronous callbacks that return plain functions",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            let backgroundScheduled = false;
            const runtime = yield* createRuntime();
            const background = makeEffectCallback<
              PluginRuntimeSnapshot,
              PluginRuntimeReconcileError
            >();
            const backgroundFiber = yield* Effect.forkChild(background.await);
            yield* Effect.yieldNow;
            const activate = (() => {
              queueMicrotask(() => {
                backgroundScheduled = true;
                background.resume(runtime.reconcile([]));
              });
              return () => undefined;
            }) as unknown as PluginDefinition["activate"];

            yield* runtime.reconcile([
              {
                id: "acme.function-return",
                version: "1.0.0",
                activate,
              },
            ]);

            expect(backgroundScheduled).toBe(true);
            expect(yield* Fiber.join(backgroundFiber)).toBeDefined();
            yield* runtime.dispose;
          }),
        ),
    );

    it.effect(
      "rejects activation-context calls from microtasks queued by synchronous callbacks",
      () =>
        Effect.scoped(
          Effect.gen(function* () {
            let lateFailure: unknown;
            let disposed = false;
            const runtime = yield* createRuntime();

            yield* runtime.reconcile([
              {
                id: "acme.microtask-context",
                version: "1.0.0",
                activate(context) {
                  queueMicrotask(() => {
                    try {
                      context.onDispose(() => {
                        disposed = true;
                      });
                    } catch (error) {
                      lateFailure = error;
                    }
                  });
                },
              },
            ]);

            expect(lateFailure).toBeInstanceOf(Error);
            expect((lateFailure as Error).message).toContain("no longer active");
            yield* runtime.dispose;
            expect(disposed).toBe(false);
          }),
        ),
    );

    it.effect("rejects finalizers registered after activation settles", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let registerLateFinalizer!: () => void;
          let disposed = false;
          const runtime = yield* createRuntime();
          yield* runtime.reconcile([
            {
              id: "acme.late-finalizer",
              version: "1.0.0",
              activate(context) {
                registerLateFinalizer = () =>
                  context.onDispose(() => {
                    disposed = true;
                  });
              },
            },
          ]);

          expect(registerLateFinalizer).toThrow("no longer active");
          yield* runtime.dispose;
          expect(disposed).toBe(false);
        }),
      ),
    );

    it.effect("snapshots the requested definitions before waiting for an earlier transition", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let releaseActivation!: () => void;
          const activationGate = new Promise<void>((resolve) => {
            releaseActivation = resolve;
          });
          const runtime = yield* createRuntime();
          const first = yield* Effect.forkChild(
            runtime.reconcile([
              {
                id: "acme.blocking",
                version: "1.0.0",
                async activate() {
                  await activationGate;
                },
              },
            ]),
          );
          yield* Effect.yieldNow;
          const requested: Array<PluginDefinition> = [provider()];
          const second = yield* Effect.forkChild(runtime.reconcile(requested));
          requested.splice(0);

          releaseActivation();
          yield* Fiber.join(first);
          const snapshot = yield* Fiber.join(second);

          expect(snapshot.active).toEqual(["acme.database"]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("snapshots each requested definition and its declarations before queueing", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let releaseActivation!: () => void;
          const activationGate = new Promise<void>((resolve) => {
            releaseActivation = resolve;
          });
          const runtime = yield* createRuntime();
          const first = yield* Effect.forkChild(
            runtime.reconcile([
              {
                id: "acme.blocking",
                version: "1.0.0",
                async activate() {
                  await activationGate;
                },
              },
            ]),
          );
          yield* Effect.yieldNow;
          const requires = ["acme.database@1"];
          const provides: Record<string, unknown> = { "acme.consumer@1": true };
          const requestedDefinition: PluginDefinition = {
            id: "acme.consumer",
            version: "1.0.0",
            requires,
            provides,
            activate() {},
          };
          const second = yield* Effect.forkChild(
            runtime.reconcile([provider(), requestedDefinition]),
          );

          (requestedDefinition as { id: string }).id = "acme.changed";
          requires[0] = "acme.missing@1";
          delete provides["acme.consumer@1"];

          releaseActivation();
          yield* Fiber.join(first);
          const snapshot = yield* Fiber.join(second);

          expect(snapshot.active).toEqual(["acme.database", "acme.consumer"]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("rejects capabilities that the plugin did not declare", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* createRuntime();
          const undeclaredConsumer: PluginDefinition = {
            id: "acme.undeclared-consumer",
            version: "1.0.0",
            activate(context) {
              context.resolve("acme.database@1");
            },
          };

          const undeclaredFailure = yield* failureOf(
            runtime.reconcile([provider(), undeclaredConsumer]),
          );
          expect(failureMessage(undeclaredFailure)).toContain("did not declare");
          expect((yield* runtime.snapshot).active).toEqual([]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("rolls back a plugin scope when contribution snapshotting throws", () =>
      Effect.scoped(
        Effect.gen(function* () {
          let disposed = false;
          const runtime = yield* createRuntime();
          const badContribution = {
            get id(): string {
              throw new Error("bad contribution getter");
            },
            label: "bad",
          };

          const snapshotFailure = yield* failureOf(
            runtime.reconcile([
              {
                id: "acme.snapshot-defect",
                version: "1.0.0",
                activate(context) {
                  context.onDispose(() => {
                    disposed = true;
                  });
                  context.register("commands", badContribution);
                },
              },
            ]),
          );

          expect(failureMessage(snapshotFailure)).toContain("bad contribution getter");
          expect(disposed).toBe(true);
          expect((yield* runtime.snapshot).active).toEqual([]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("attempts every plugin cleanup when one finalizer fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const disposed: Array<string> = [];
          const runtime = yield* createRuntime();
          yield* runtime.reconcile([
            {
              id: "acme.first-cleanup",
              version: "1.0.0",
              activate(context) {
                context.onDispose(() => {
                  disposed.push("first");
                });
              },
            },
            {
              id: "acme.second-cleanup",
              version: "1.0.0",
              activate(context) {
                context.onDispose(() => {
                  disposed.push("second");
                  throw new Error("cleanup failed");
                });
              },
            },
          ]);

          expect(yield* failureOf(runtime.dispose)).toBeInstanceOf(Error);

          expect(disposed).toEqual(["second", "first"]);
        }),
      ),
    );

    it.effect("keeps the old plugin active when a replacement fails", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* createRuntime();
          yield* runtime.reconcile([provider()]);
          const broken: PluginDefinition = {
            ...provider("2.0.0"),
            async activate(context) {
              context.register("status", { id: "database", label: "database 2.0.0" });
              throw new Error("candidate failed");
            },
          };

          const candidateFailure = yield* failureOf(runtime.reconcile([broken]));
          expect(failureMessage(candidateFailure)).toContain("candidate failed");

          expect((yield* runtime.snapshot).active).toEqual(["acme.database"]);
          expect(contributionLabels(yield* runtime.snapshot, "status")).toEqual(["database 1.0.0"]);
          yield* runtime.dispose;
        }),
      ),
    );

    it.effect("rejects dependency cycles without disturbing the current composition", () =>
      Effect.scoped(
        Effect.gen(function* () {
          const runtime = yield* createRuntime();
          yield* runtime.reconcile([provider()]);
          const alpha: PluginDefinition = {
            id: "acme.alpha",
            version: "1.0.0",
            requires: ["acme.beta@1"],
            provides: { "acme.alpha@1": true },
            activate() {},
          };
          const beta: PluginDefinition = {
            id: "acme.beta",
            version: "1.0.0",
            requires: ["acme.alpha@1"],
            provides: { "acme.beta@1": true },
            activate() {},
          };

          expect(failureMessage(yield* failureOf(runtime.reconcile([alpha, beta])))).toContain(
            "cycle",
          );

          expect((yield* runtime.snapshot).active).toEqual(["acme.database"]);
          yield* runtime.dispose;
        }),
      ),
    );
  });
}
