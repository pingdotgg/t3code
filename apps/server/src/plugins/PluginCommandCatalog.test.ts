import { it } from "@effect/vitest";
import { describe, expect } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import type { PluginDefinition } from "@t3tools/plugin-runtime";

import * as PluginCommandCatalog from "./PluginCommandCatalog.ts";

const testPlugin = (input: {
  readonly fail?: boolean;
  readonly message: string;
  readonly onDispose?: () => void | Promise<void>;
  readonly version: string;
}): PluginDefinition => ({
  id: "acme.command-plugin",
  version: input.version,
  activate(context) {
    if (input.fail === true) throw new Error("activation failed");
    if (input.onDispose !== undefined) context.onDispose(input.onDispose);
    PluginCommandCatalog.registerPluginCommand(context, {
      command: {
        id: "acme.hello",
        label: "Say hello",
        description: "Return a greeting from the trusted test plugin.",
        surfaces: ["web", "desktop", "mobile"],
      },
      handler: Effect.succeed({ message: input.message, tone: "success" }),
    });
  },
});

describe("plugin command catalog", () => {
  it.effect("lists and invokes the trusted built-in command", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      const listed = yield* catalog.list;
      const streamed = yield* Stream.runHead(catalog.changes);

      expect(listed.commands.map((command) => command.id)).toContain("t3.plugin-runtime.status");
      expect(Object.isFrozen(listed)).toBe(true);
      expect(Object.isFrozen(listed.commands)).toBe(true);
      expect(Object.isFrozen(listed.commands[0])).toBe(true);
      expect(Object.isFrozen(listed.commands[0]?.surfaces)).toBe(true);
      expect(Option.getOrNull(streamed)).toEqual(listed);
      expect(
        yield* catalog.invoke({
          generation: listed.generation,
          id: "t3.plugin-runtime.status",
        }),
      ).toEqual({ message: "Plugin runtime is active.", tone: "success" });
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("keeps the committed command and handler when replacement activation fails", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      const first = yield* catalog.reconcile([
        testPlugin({ message: "hello one", version: "1.0.0" }),
      ]);
      const failed = yield* Effect.exit(
        catalog.reconcile([testPlugin({ fail: true, message: "hello two", version: "2.0.0" })]),
      );

      expect(Exit.isFailure(failed)).toBe(true);
      expect(yield* catalog.list).toEqual(first);
      expect(yield* catalog.invoke({ generation: first.generation, id: "acme.hello" })).toEqual({
        message: "hello one",
        tone: "success",
      });
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("does not republish an unchanged command catalog", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      const definition = testPlugin({ message: "hello one", version: "1.0.0" });

      const first = yield* catalog.reconcile([definition]);
      const second = yield* catalog.reconcile([definition]);

      expect(second).toBe(first);
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("rolls back invalid command metadata before publishing a generation", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      const first = yield* catalog.list;
      const invalid: PluginDefinition = {
        id: "acme.invalid-command-plugin",
        version: "1.0.0",
        activate(context) {
          context.register(
            "commands",
            {
              id: "acme.invalid",
              label: "Invalid command",
              data: { surfaces: ["server"] },
            },
            Effect.succeed({ message: "invalid", tone: "success" as const }),
          );
        },
      };

      const failed = yield* Effect.exit(catalog.reconcile([invalid]));

      const shadowedIdentity: PluginDefinition = {
        id: "acme.shadowed-command-plugin",
        version: "1.0.0",
        activate(context) {
          context.register(
            "commands",
            {
              id: "acme.registered",
              label: "Registered command",
              data: {
                id: "acme.advertised",
                label: "Advertised command",
                surfaces: ["web"],
              },
            },
            Effect.succeed({ message: "shadowed", tone: "success" as const }),
          );
        },
      };
      const shadowed = yield* Effect.exit(catalog.reconcile([shadowedIdentity]));

      expect(Exit.isFailure(failed)).toBe(true);
      expect(Exit.isFailure(shadowed)).toBe(true);
      expect(yield* catalog.list).toBe(first);
      expect(
        yield* catalog.invoke({
          generation: first.generation,
          id: "t3.plugin-runtime.status",
        }),
      ).toEqual({ message: "Plugin runtime is active.", tone: "success" });
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("serializes runtime reconciliation through catalog publication", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      let markActivationStarted!: () => void;
      let releaseActivation!: () => void;
      let markSecondActivationStarted!: () => void;
      const activationStarted = new Promise<void>((resolve) => {
        markActivationStarted = resolve;
      });
      const activationGate = new Promise<void>((resolve) => {
        releaseActivation = resolve;
      });
      const secondActivationStarted = new Promise<void>((resolve) => {
        markSecondActivationStarted = resolve;
      });
      const firstPlugin: PluginDefinition = {
        id: "acme.first-command-plugin",
        version: "1.0.0",
        activate(context) {
          markActivationStarted();
          return activationGate.then(() => {
            PluginCommandCatalog.registerPluginCommand(context, {
              command: { id: "acme.first", label: "First", surfaces: ["web"] },
              handler: Effect.succeed({ message: "first", tone: "success" }),
            });
          });
        },
      };
      const secondPlugin: PluginDefinition = {
        id: "acme.second-command-plugin",
        version: "1.0.0",
        activate(context) {
          markSecondActivationStarted();
          PluginCommandCatalog.registerPluginCommand(context, {
            command: { id: "acme.second", label: "Second", surfaces: ["web"] },
            handler: Effect.succeed({ message: "second", tone: "success" }),
          });
        },
      };

      const firstFiber = yield* Effect.forkChild(catalog.reconcile([firstPlugin]));
      yield* Effect.promise(() => activationStarted);
      const secondFiber = yield* Effect.forkChild(catalog.reconcile([secondPlugin]));
      yield* Effect.yieldNow;
      releaseActivation();

      const first = yield* Fiber.join(firstFiber);
      yield* Effect.promise(() => secondActivationStarted);
      const generationSeenBySecondActivation = (yield* catalog.list).generation;
      const second = yield* Fiber.join(secondFiber);
      expect(generationSeenBySecondActivation).toBe(first.generation);
      expect(yield* catalog.list).toBe(second);
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );

  it.effect("publishes a committed runtime generation before reporting interruption", () =>
    Effect.gen(function* () {
      const catalog = yield* PluginCommandCatalog.PluginCommandCatalog;
      let markRetirementStarted!: () => void;
      let releaseRetirement!: () => void;
      const retirementStarted = new Promise<void>((resolve) => {
        markRetirementStarted = resolve;
      });
      const retirementGate = new Promise<void>((resolve) => {
        releaseRetirement = resolve;
      });
      const first = yield* catalog.reconcile([
        testPlugin({
          message: "hello one",
          onDispose: async () => {
            markRetirementStarted();
            await retirementGate;
          },
          version: "1.0.0",
        }),
      ]);
      const replacement = yield* Effect.forkChild(
        catalog.reconcile([testPlugin({ message: "hello two", version: "2.0.0" })]),
      );
      yield* Effect.promise(() => retirementStarted);
      const interruption = yield* Effect.forkChild(Fiber.interrupt(replacement));
      yield* Effect.yieldNow;
      releaseRetirement();
      yield* Fiber.join(interruption);

      const second = yield* catalog.list;
      expect(second.generation).toBe(first.generation + 1);
      expect(yield* catalog.invoke({ generation: second.generation, id: "acme.hello" })).toEqual({
        message: "hello two",
        tone: "success",
      });
    }).pipe(Effect.provide(PluginCommandCatalog.layer)),
  );
});
