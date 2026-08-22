import * as NodeTimersPromises from "node:timers/promises";

import { describe, expect, it } from "vite-plus/test";

import type { PluginDefinition, PluginRuntimeFactory, PluginRuntimeSnapshot } from "./contract.ts";

const contributionLabels = (snapshot: PluginRuntimeSnapshot, slot: string) =>
  snapshot.contributions[slot]?.map((item) => item.label) ?? [];

const withOperationTimeout = async <Result>(operation: Promise<Result>): Promise<Result> => {
  const controller = new AbortController();
  const timeout = NodeTimersPromises.setTimeout(100, undefined, {
    ref: false,
    signal: controller.signal,
  }).then(() => {
    throw new Error("operation timed out");
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    controller.abort();
  }
};

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

export function defineRuntimeContract(name: string, createRuntime: PluginRuntimeFactory) {
  describe(name, () => {
    it("activates providers before consumers regardless of manifest order", async () => {
      const runtime = createRuntime();

      const snapshot = await runtime.reconcile([consumer(), provider()]);

      expect(snapshot.active).toEqual(["acme.database", "acme.issues"]);
      expect(contributionLabels(snapshot, "commands")).toEqual(["database-1.0.0"]);
      await runtime.dispose();
    });

    it("blocks missing dependencies without blocking independent plugins", async () => {
      const runtime = createRuntime();
      const independent: PluginDefinition = {
        id: "acme.clock",
        version: "1.0.0",
        activate(context) {
          context.register("status", { id: "clock", label: "clock" });
        },
      };

      const snapshot = await runtime.reconcile([consumer(), independent]);

      expect(snapshot.active).toEqual(["acme.clock"]);
      expect(snapshot.blocked["acme.issues"]).toContain("acme.database@1");
      expect(contributionLabels(snapshot, "status")).toEqual(["clock"]);
      await runtime.dispose();
    });

    it("deactivates dependents before providers", async () => {
      const lifecycle: Array<string> = [];
      const runtime = createRuntime({
        onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
      });
      await runtime.reconcile([provider(), consumer()]);
      lifecycle.length = 0;

      await runtime.reconcile([]);

      expect(lifecycle).toEqual(["deactivate:acme.issues", "deactivate:acme.database"]);
      await runtime.dispose();
    });

    it("runs plugin finalizers in reverse registration order", async () => {
      const disposed: Array<string> = [];
      const runtime = createRuntime();
      await runtime.reconcile([
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

      await runtime.reconcile([]);

      expect(disposed).toEqual(["second", "first"]);
      await runtime.dispose();
    });

    it("keeps unchanged plugin scopes alive across reconciliation", async () => {
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
      const runtime = createRuntime();

      await runtime.reconcile([stable]);
      await runtime.reconcile([stable]);

      expect(activations).toBe(1);
      expect(disposals).toBe(0);
      await runtime.dispose();
      expect(disposals).toBe(1);
    });

    it("treats reordered requirements and providers as the same definition", async () => {
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
      const runtime = createRuntime();
      await runtime.reconcile([
        ...dependencies,
        {
          id: "acme.stable-order",
          version: "1.0.0",
          requires: ["acme.first@1", "acme.second@1"],
          provides: { "acme.output-one@1": firstService, "acme.output-two@1": secondService },
          activate,
        },
      ]);

      await runtime.reconcile([
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
      await runtime.dispose();
    });

    it("restarts a plugin when its activation implementation changes", async () => {
      const runtime = createRuntime();
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

      await runtime.reconcile([first]);
      const snapshot = await runtime.reconcile([second]);

      expect(contributionLabels(snapshot, "commands")).toEqual(["second"]);
      await runtime.dispose();
    });

    it("restarts a changed provider and its dependents without touching independent plugins", async () => {
      let independentActivations = 0;
      const lifecycle: Array<string> = [];
      const independent: PluginDefinition = {
        id: "acme.independent",
        version: "1.0.0",
        activate() {
          independentActivations += 1;
        },
      };
      const runtime = createRuntime({
        onLifecycle: ({ phase, pluginId }) => lifecycle.push(`${phase}:${pluginId}`),
      });
      await runtime.reconcile([consumer(), independent, provider()]);
      lifecycle.length = 0;

      const snapshot = await runtime.reconcile([consumer(), independent, provider("2.0.0")]);

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
      await runtime.dispose();
    });

    it("returns deeply frozen snapshots", async () => {
      const runtime = createRuntime();

      const snapshot = await runtime.reconcile([provider()]);
      const status = snapshot.contributions.status;

      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(Object.isFrozen(snapshot.active)).toBe(true);
      expect(Object.isFrozen(snapshot.blocked)).toBe(true);
      expect(Object.isFrozen(snapshot.contributions)).toBe(true);
      expect(Object.isFrozen(status)).toBe(true);
      expect(Object.isFrozen(status?.[0])).toBe(true);
      await runtime.dispose();
    });

    it("treats every plugin id and contribution slot as data", async () => {
      const runtime = createRuntime();
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

      const snapshot = await runtime.reconcile([unusualConsumer, unusualProvider, unusualBlocked]);

      expect(snapshot.active).toEqual(["toString", "constructor"]);
      expect(Object.hasOwn(snapshot.blocked, "__proto__")).toBe(true);
      expect(snapshot.blocked.__proto__).toContain("acme.missing@1");
      expect(Object.hasOwn(snapshot.contributions, "__proto__")).toBe(true);
      expect(Object.hasOwn(snapshot.contributions, "toString")).toBe(true);
      expect(contributionLabels(snapshot, "__proto__")).toEqual(["provider"]);
      expect(contributionLabels(snapshot, "toString")).toEqual(["consumer"]);
      await runtime.dispose();
    });

    it("restarts dependents when a provided value changes", async () => {
      const lifecycle: Array<string> = [];
      const runtime = createRuntime({
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
      await runtime.reconcile([serviceProvider("first"), serviceConsumer]);
      lifecycle.length = 0;

      const snapshot = await runtime.reconcile([serviceProvider("second"), serviceConsumer]);

      expect(contributionLabels(snapshot, "commands")).toEqual(["second"]);
      expect(lifecycle.filter((event) => event.startsWith("activate:"))).toEqual([
        "activate:acme.service",
        "activate:acme.service-consumer",
      ]);
      await runtime.dispose();
    });

    it("does not report a rolled-back candidate as activated", async () => {
      const lifecycle: Array<string> = [];
      const runtime = createRuntime({
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

      let stagingFailure: unknown;
      try {
        await runtime.reconcile([staged, broken]);
      } catch (error) {
        stagingFailure = error;
      }
      expect(failureMessage(stagingFailure)).toContain("activation failed");

      expect(lifecycle).toEqual([]);
      await runtime.dispose();
    });

    it("preserves activation failures when rollback cleanup also fails", async () => {
      const activationError = new Error("activation failed");
      const cleanupError = new Error("rollback cleanup failed");
      const cleanupEvents: Array<{ readonly phase: string; readonly error: unknown }> = [];
      const runtime = createRuntime({
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

      let activationFailure: unknown;
      try {
        await runtime.reconcile([broken]);
      } catch (error) {
        activationFailure = error;
      }
      expect(failureCause(activationFailure)).toBe(activationError);
      expect(cleanupEvents).toHaveLength(1);
      expect(cleanupEvents[0]?.phase).toBe("rollback");
      expect(failureCause(cleanupEvents[0]?.error)).toBe(cleanupError);
      await runtime.dispose();
    });

    it("returns the committed snapshot when retiring an old plugin reports cleanup errors", async () => {
      const cleanupError = new Error("retirement cleanup failed");
      const cleanupEvents: Array<{ readonly phase: string; readonly error: unknown }> = [];
      const runtime = createRuntime({
        onCleanupError: (event) => {
          cleanupEvents.push(event);
          throw new Error("cleanup observer failed");
        },
      });
      await runtime.reconcile([
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

      const snapshot = await runtime.reconcile([
        {
          id: "acme.retirement-error",
          version: "2.0.0",
          activate(context) {
            context.register("commands", { id: "retirement", label: "new" });
          },
        },
      ]);

      expect(contributionLabels(snapshot, "commands")).toEqual(["new"]);
      expect(runtime.snapshot()).toBe(snapshot);
      expect(cleanupEvents).toHaveLength(1);
      expect(cleanupEvents[0]?.phase).toBe("retire");
      expect(failureCause(cleanupEvents[0]?.error)).toBe(cleanupError);
      await runtime.dispose();
    });

    it("does not let lifecycle observers interrupt a committed transition", async () => {
      let oldDisposed = false;
      const observerErrors: Array<string> = [];
      const runtime = createRuntime({
        onLifecycle: ({ phase, pluginId }) => {
          throw new Error(`${phase}:${pluginId}`);
        },
        onLifecycleError: ({ phase, pluginId }) => {
          observerErrors.push(`${phase}:${pluginId}`);
        },
      });
      await runtime.reconcile([
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

      const snapshot = await runtime.reconcile([
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
      await runtime.dispose();
    });

    it("rejects runtime operations reentered from plugin activation", async () => {
      const runtime = createRuntime();
      const reentrant: PluginDefinition = {
        id: "acme.reentrant",
        version: "1.0.0",
        async activate() {
          await runtime.reconcile([]);
        },
      };
      await expect(withOperationTimeout(runtime.reconcile([reentrant]))).rejects.toThrow(
        "reentrant",
      );
    });

    it("rejects runtime operations reentered from plugin finalizers", async () => {
      let nestedFailure: unknown;
      const runtime = createRuntime();
      await runtime.reconcile([
        {
          id: "acme.reentrant-finalizer",
          version: "1.0.0",
          activate(context) {
            context.onDispose(async () => {
              try {
                await runtime.dispose();
              } catch (error) {
                nestedFailure = error;
              }
            });
          },
        },
      ]);
      await expect(withOperationTimeout(runtime.reconcile([]))).resolves.toBeDefined();
      expect(nestedFailure).toBeInstanceOf(Error);
      expect((nestedFailure as Error).message).toContain("reentrant");
      await runtime.dispose();
    });

    it("allows descendant tasks to use the runtime after their plugin callback settles", async () => {
      let releaseBackground!: () => void;
      const gate = new Promise<void>((resolve) => {
        releaseBackground = resolve;
      });
      let backgroundResult: Promise<PluginRuntimeSnapshot> | undefined;
      const runtime = createRuntime();

      await runtime.reconcile([
        {
          id: "acme.background-task",
          version: "1.0.0",
          activate() {
            backgroundResult = gate.then(() => runtime.reconcile([]));
          },
        },
      ]);

      releaseBackground();
      await expect(withOperationTimeout(backgroundResult!)).resolves.toBeDefined();
      await runtime.dispose();
    });

    it("allows microtasks spawned by synchronous plugin callbacks to use the runtime", async () => {
      let backgroundResult: Promise<PluginRuntimeSnapshot> | undefined;
      const runtime = createRuntime();

      await runtime.reconcile([
        {
          id: "acme.microtask",
          version: "1.0.0",
          activate() {
            queueMicrotask(() => {
              backgroundResult = runtime.reconcile([]);
            });
          },
        },
      ]);

      expect(backgroundResult).toBeDefined();
      await expect(withOperationTimeout(backgroundResult!)).resolves.toBeDefined();
      await runtime.dispose();
    });

    it("allows microtasks spawned by synchronous callbacks that return plain functions", async () => {
      let backgroundResult: Promise<PluginRuntimeSnapshot> | undefined;
      const runtime = createRuntime();
      const activate = (() => {
        queueMicrotask(() => {
          backgroundResult = runtime.reconcile([]);
        });
        return () => undefined;
      }) as unknown as PluginDefinition["activate"];

      await runtime.reconcile([
        {
          id: "acme.function-return",
          version: "1.0.0",
          activate,
        },
      ]);

      expect(backgroundResult).toBeDefined();
      await expect(withOperationTimeout(backgroundResult!)).resolves.toBeDefined();
      await runtime.dispose();
    });

    it("rejects activation-context calls from microtasks queued by synchronous callbacks", async () => {
      let lateFailure: unknown;
      let disposed = false;
      const runtime = createRuntime();

      await runtime.reconcile([
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
      await runtime.dispose();
      expect(disposed).toBe(false);
    });

    it("rejects finalizers registered after activation settles", async () => {
      let registerLateFinalizer!: () => void;
      let disposed = false;
      const runtime = createRuntime();
      await runtime.reconcile([
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
      await runtime.dispose();
      expect(disposed).toBe(false);
    });

    it("snapshots the requested definitions before waiting for an earlier transition", async () => {
      let releaseActivation!: () => void;
      const activationGate = new Promise<void>((resolve) => {
        releaseActivation = resolve;
      });
      const runtime = createRuntime();
      const first = runtime.reconcile([
        {
          id: "acme.blocking",
          version: "1.0.0",
          async activate() {
            await activationGate;
          },
        },
      ]);
      const requested: Array<PluginDefinition> = [provider()];
      const second = runtime.reconcile(requested);
      requested.splice(0);

      releaseActivation();
      await first;
      const snapshot = await second;

      expect(snapshot.active).toEqual(["acme.database"]);
      await runtime.dispose();
    });

    it("attempts every plugin cleanup when one finalizer fails", async () => {
      const disposed: Array<string> = [];
      const runtime = createRuntime();
      await runtime.reconcile([
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

      await expect(runtime.dispose()).rejects.toThrow();

      expect(disposed).toEqual(["second", "first"]);
    });

    it("keeps the old plugin active when a replacement fails", async () => {
      const runtime = createRuntime();
      await runtime.reconcile([provider()]);
      const broken: PluginDefinition = {
        ...provider("2.0.0"),
        async activate(context) {
          context.register("status", { id: "database", label: "database 2.0.0" });
          throw new Error("candidate failed");
        },
      };

      let candidateFailure: unknown;
      try {
        await runtime.reconcile([broken]);
      } catch (error) {
        candidateFailure = error;
      }
      expect(failureMessage(candidateFailure)).toContain("candidate failed");

      expect(runtime.snapshot().active).toEqual(["acme.database"]);
      expect(contributionLabels(runtime.snapshot(), "status")).toEqual(["database 1.0.0"]);
      await runtime.dispose();
    });

    it("rejects dependency cycles without disturbing the current composition", async () => {
      const runtime = createRuntime();
      await runtime.reconcile([provider()]);
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

      await expect(runtime.reconcile([alpha, beta])).rejects.toThrow("cycle");

      expect(runtime.snapshot().active).toEqual(["acme.database"]);
      await runtime.dispose();
    });
  });
}
