import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";
import type { PluginToolDescriptor } from "@t3tools/plugin-sdk";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

import { PLUGIN_TOOL_MAX_CONCURRENT_PER_TOOL } from "../mcp/toolkits/plugins/pluginToolBounds.ts";
import * as PluginRuntimeRegistry from "./PluginRuntimeRegistry.ts";
import * as PluginToolCatalog from "./PluginToolCatalog.ts";

const EchoInput = Schema.Struct({
  message: Schema.String,
});

const textOf = (result: {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}) => {
  const first = result.content[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
};

const makeTool = (overrides: Partial<PluginToolDescriptor> = {}): PluginToolDescriptor => ({
  name: "echo",
  description: "Echo a message for catalog unit tests.",
  inputSchema: EchoInput,
  scope: "read",
  handle: (input) => {
    const message =
      typeof input === "object" && input !== null && "message" in input
        ? String((input as { message: unknown }).message)
        : "";
    return Effect.succeed({
      content: [{ type: "text" as const, text: `echo:${message}` }],
      structuredContent: { message },
    });
  },
  ...overrides,
});

const TestLayer = PluginToolCatalog.layer.pipe(
  Layer.provideMerge(PluginRuntimeRegistry.layer),
  Layer.provideMerge(TestClock.layer()),
);

const withRuntime = <E, R>(
  pluginId: PluginId,
  tools: ReadonlyArray<PluginToolDescriptor>,
  effect: Effect.Effect<
    void,
    E,
    R | PluginToolCatalog.PluginToolCatalog | PluginRuntimeRegistry.PluginRuntimeRegistry
  >,
): Effect.Effect<
  void,
  E | PluginToolCatalog.PluginToolCatalogError,
  R | PluginToolCatalog.PluginToolCatalog | PluginRuntimeRegistry.PluginRuntimeRegistry
> =>
  Effect.gen(function* () {
    const registry = yield* PluginRuntimeRegistry.PluginRuntimeRegistry;
    const catalog = yield* PluginToolCatalog.PluginToolCatalog;
    yield* catalog.reserve(pluginId, tools, { hasToolsCapability: true });
    const readiness = yield* Deferred.make<void>();
    yield* Deferred.succeed(readiness, undefined);
    const scope = yield* Scope.make("sequential");
    yield* registry.put(pluginId, {
      manifest: {
        id: pluginId,
        name: "Tool Fixture",
        version: "1.0.0",
        hostApi: "^1.0.0",
        capabilities: ["tools"],
        entries: { server: "server.js" },
      },
      registration: { tools },
      readiness,
      scope,
    });
    yield* catalog.activate(pluginId);
    return yield* effect;
  });

it.layer(TestLayer)("PluginToolCatalog", (it) => {
  it.effect("lists tools as inactive until activate, then callable via trampoline", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("tool-call");
      const finalName = "plugin_tool_call__echo";
      const catalog = yield* PluginToolCatalog.PluginToolCatalog;
      yield* catalog.reserve(pluginId, [makeTool()], { hasToolsCapability: true });
      assert.equal(catalog.isActive(finalName), false);

      const disabled = yield* catalog.makeTrampolineHandle(pluginId, "echo")({ message: "x" });
      assert.equal(disabled.isError, true);
      assert.match(textOf(disabled), /not enabled/i);

      yield* withRuntime(
        pluginId,
        [makeTool()],
        Effect.gen(function* () {
          const ok = yield* catalog.makeTrampolineHandle(pluginId, "echo")({ message: "hi" });
          assert.equal(ok.isError, false);
          assert.deepEqual(ok.content, [{ type: "text", text: "echo:hi" }]);
        }),
      );
    }),
  );

  it.effect("rejects metadata drift across reserve with restart required", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("tool-drift");
      const catalog = yield* PluginToolCatalog.PluginToolCatalog;
      yield* catalog.reserve(pluginId, [makeTool({ description: "first description here" })], {
        hasToolsCapability: true,
      });
      const drift = yield* Effect.exit(
        catalog.reserve(
          pluginId,
          [makeTool({ description: "second description that differs enough" })],
          { hasToolsCapability: true },
        ),
      );
      assert.equal(drift._tag, "Failure");
      if (drift._tag === "Failure") {
        assert.match(String(drift.cause), /restart required/i);
      }
    }),
  );

  it.effect("deactivate clears visibility and fails calls closed", () => {
    const pluginId = PluginId.make("tool-gate");
    const finalName = "plugin_tool_gate__echo";
    return withRuntime(
      pluginId,
      [makeTool()],
      Effect.gen(function* () {
        const catalog = yield* PluginToolCatalog.PluginToolCatalog;
        const registry = yield* PluginRuntimeRegistry.PluginRuntimeRegistry;
        assert.equal(catalog.isActive(finalName), true);

        yield* registry.remove(pluginId);
        yield* catalog.deactivate(pluginId);
        assert.equal(catalog.isActive(finalName), false);

        const result = yield* catalog.makeTrampolineHandle(pluginId, "echo")({ message: "nope" });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /not enabled/i);

        yield* catalog.reserve(pluginId, [makeTool()], { hasToolsCapability: true });
        const readiness = yield* Deferred.make<void>();
        yield* Deferred.succeed(readiness, undefined);
        const scope = yield* Scope.make("sequential");
        yield* registry.put(pluginId, {
          manifest: {
            id: pluginId,
            name: "Tool Fixture",
            version: "1.0.0",
            hostApi: "^1.0.0",
            capabilities: ["tools"],
            entries: { server: "server.js" },
          },
          registration: { tools: [makeTool()] },
          readiness,
          scope,
        });
        yield* catalog.activate(pluginId);
        const again = yield* catalog.makeTrampolineHandle(pluginId, "echo")({ message: "back" });
        assert.equal(again.isError, false);
        assert.deepEqual(again.content, [{ type: "text", text: "echo:back" }]);
      }),
    );
  });

  it.effect("maps handler defects to isError without killing the catalog", () => {
    const pluginId = PluginId.make("tool-die");
    return withRuntime(
      pluginId,
      [
        makeTool({
          handle: () => Effect.die(new Error("boom")),
        }),
      ],
      Effect.gen(function* () {
        const catalog = yield* PluginToolCatalog.PluginToolCatalog;
        const result = yield* catalog.makeTrampolineHandle(pluginId, "echo")({ message: "x" });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /failed/i);

        const again = yield* catalog.makeTrampolineHandle(pluginId, "echo")({ message: "y" });
        assert.equal(again.isError, true);
      }),
    );
  });

  it.effect("times out hanging handlers", () => {
    const pluginId = PluginId.make("tool-hang");
    return withRuntime(
      pluginId,
      [
        makeTool({
          handle: () =>
            Effect.sleep("5 minutes").pipe(
              Effect.as({
                content: [{ type: "text" as const, text: "late" }],
              }),
            ),
        }),
      ],
      Effect.gen(function* () {
        const catalog = yield* PluginToolCatalog.PluginToolCatalog;
        const fiber = yield* catalog
          .makeTrampolineHandle(
            pluginId,
            "echo",
          )({ message: "hang" })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("61 seconds");
        const result = yield* Fiber.join(fiber);
        assert.equal(result.isError, true);
        assert.match(textOf(result), /timed out/i);
      }),
    );
  });

  // Plain vitest `it` (not it.effect) so this is NOT under TestClock — concurrent
  // Deferred latches need a live scheduler/clock to make progress.
  it("enforces per-tool concurrency cap", async () => {
    const pluginId = PluginId.make("tool-conc");
    const LiveLayer = PluginToolCatalog.layer.pipe(Layer.provideMerge(PluginRuntimeRegistry.layer));
    await Effect.runPromise(
      Effect.gen(function* () {
        const release = yield* Deferred.make<void>();
        const entered = yield* Deferred.make<void>();
        const started = yield* Ref.make(0);
        const blocking = makeTool({
          handle: () =>
            Effect.gen(function* () {
              const count = yield* Ref.updateAndGet(started, (n) => n + 1);
              if (count === PLUGIN_TOOL_MAX_CONCURRENT_PER_TOOL) {
                yield* Deferred.succeed(entered, undefined).pipe(Effect.ignore);
              }
              yield* Deferred.await(release);
              return {
                content: [{ type: "text" as const, text: "done" }],
              };
            }),
        });

        const registry = yield* PluginRuntimeRegistry.PluginRuntimeRegistry;
        const catalog = yield* PluginToolCatalog.PluginToolCatalog;
        yield* catalog.reserve(pluginId, [blocking], { hasToolsCapability: true });
        const readiness = yield* Deferred.make<void>();
        yield* Deferred.succeed(readiness, undefined);
        const scope = yield* Scope.make("sequential");
        yield* registry.put(pluginId, {
          manifest: {
            id: pluginId,
            name: "Tool Fixture",
            version: "1.0.0",
            hostApi: "^1.0.0",
            capabilities: ["tools"],
            entries: { server: "server.js" },
          },
          registration: { tools: [blocking] },
          readiness,
          scope,
        });
        yield* catalog.activate(pluginId);

        const handle = catalog.makeTrampolineHandle(pluginId, "echo");
        const batchFiber = yield* Effect.all(
          Array.from({ length: PLUGIN_TOOL_MAX_CONCURRENT_PER_TOOL }, (_, i) =>
            handle({ message: `slot-${i}` }),
          ),
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild({ startImmediately: true }));

        yield* Deferred.await(entered);
        assert.equal(yield* Ref.get(started), PLUGIN_TOOL_MAX_CONCURRENT_PER_TOOL);

        const overflow = yield* handle({ message: "overflow" });
        assert.equal(overflow.isError, true);
        assert.match(textOf(overflow), /concurrency limit/i);

        yield* Deferred.succeed(release, undefined);
        const results = yield* Fiber.join(batchFiber);
        assert.equal(results.length, PLUGIN_TOOL_MAX_CONCURRENT_PER_TOOL);
        for (const result of results) {
          assert.equal(result.isError, false);
        }
      }).pipe(Effect.provide(LiveLayer), Effect.scoped),
    );
  });

  it.effect("rejects oversized results with a host-owned isError", () => {
    const pluginId = PluginId.make("tool-size");
    return withRuntime(
      pluginId,
      [
        makeTool({
          handle: () =>
            Effect.succeed({
              content: Array.from({ length: 8 }, () => ({
                type: "text" as const,
                text: "x".repeat(100_000),
              })),
              structuredContent: { blob: "y".repeat(400_000) },
            }),
        }),
      ],
      Effect.gen(function* () {
        const catalog = yield* PluginToolCatalog.PluginToolCatalog;
        const result = yield* catalog.makeTrampolineHandle(pluginId, "echo")({ message: "big" });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /exceeded/i);
        assert.ok(textOf(result).length < 500);
      }),
    );
  });

  it.effect("rejects tools declared without tools capability", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("tool-cap");
      const catalog = yield* PluginToolCatalog.PluginToolCatalog;
      const exit = yield* Effect.exit(
        catalog.reserve(pluginId, [makeTool()], { hasToolsCapability: false }),
      );
      assert.equal(exit._tag, "Failure");
      if (exit._tag === "Failure") {
        assert.match(String(exit.cause), /tools.*capability/);
      }
    }),
  );
});
