import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";
import type { PluginToolDescriptor } from "@t3tools/plugin-sdk";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";
import * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";

class TypedHandlerFailure extends Data.TaggedError("TypedHandlerFailure")<{
  readonly message: string;
}> {}

import { PLUGIN_TOOL_MAX_CONCURRENT_PER_TOOL } from "../mcp/toolkits/plugins/pluginToolBounds.ts";
import { PluginLockfileStore } from "./PluginLockfileStore.ts";
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
      settings: undefined,
      registration: { tools },
      readiness,
      scope,
    });
    yield* catalog.activate(pluginId);
    return yield* effect;
  });

it.layer(TestLayer)("PluginToolCatalog", (it) => {
  it.effect("keeps tools inactive until activate, then callable via trampoline", () =>
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
          settings: undefined,
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

  /**
   * Catalog-method simulation of disable∩activation (no sleeps):
   *  1. activation has published runtime; catalog is active
   *  2. disable notes intent + deactivates (still before activation-lock teardown)
   *  3. catalog.activate is invoked while registry STILL has the runtime
   *     (same call a put-subscriber would make; not a real queued-fiber interleave)
   *  4. without disable-intent refuse, activate would reopen; with it, stays closed
   *     and tools/call must not be admitted while intent is pending.
   */
  it.effect("disable intent blocks queued activate while registry still live", () => {
    const pluginId = PluginId.make("tool-disable-intent");
    const finalName = "plugin_tool_disable_intent__echo";
    return withRuntime(
      pluginId,
      [makeTool()],
      Effect.gen(function* () {
        const catalog = yield* PluginToolCatalog.PluginToolCatalog;
        const registry = yield* PluginRuntimeRegistry.PluginRuntimeRegistry;
        assert.equal(catalog.isActive(finalName), true);
        assert.equal((yield* registry.get(pluginId))._tag, "Some");

        // Step 2: disable's synchronous prefix (before activation lock wait).
        yield* catalog.noteDisableIntent(pluginId);
        yield* catalog.deactivate(pluginId);
        assert.equal(catalog.isActive(finalName), false);
        assert.equal(yield* catalog.hasDisableIntent(pluginId), true);
        // Registry removal is still behind the lock — runtime remains.
        assert.equal((yield* registry.get(pluginId))._tag, "Some");

        // Step 3: direct catalog.activate (both registry checks see live).
        yield* catalog.activate(pluginId);

        // Step 4: must stay closed; calls must not be admitted.
        assert.equal(catalog.isActive(finalName), false);
        const admitted = yield* catalog.makeTrampolineHandle(
          pluginId,
          "echo",
        )({
          message: "forbidden",
        });
        assert.equal(admitted.isError, true);
        assert.match(textOf(admitted), /not enabled/i);

        // Successful enable clears intent and allows reopen.
        yield* catalog.clearDisableIntent(pluginId);
        yield* catalog.activate(pluginId);
        assert.equal(catalog.isActive(finalName), true);
        const ok = yield* catalog.makeTrampolineHandle(pluginId, "echo")({ message: "ok" });
        assert.equal(ok.isError, false);
        assert.deepEqual(ok.content, [{ type: "text", text: "echo:ok" }]);
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
  // Nested `it` from it.layer has no it.live, so Effect.runPromise is intentional.
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
          settings: undefined,
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

  it.effect("rejects descriptor-set removals as restart required", () =>
    Effect.gen(function* () {
      const pluginId = PluginId.make("tool-remove");
      const catalog = yield* PluginToolCatalog.PluginToolCatalog;
      const a = makeTool({ name: "alpha", description: "alpha tool description text" });
      const b = makeTool({ name: "beta", description: "beta tool description text" });
      yield* catalog.reserve(pluginId, [a, b], { hasToolsCapability: true });

      const shrink = yield* Effect.exit(
        catalog.reserve(pluginId, [a], { hasToolsCapability: true }),
      );
      assert.equal(shrink._tag, "Failure");
      if (shrink._tag === "Failure") {
        assert.match(String(shrink.cause), /removed since last registration; restart required/i);
      }

      const empty = yield* Effect.exit(catalog.reserve(pluginId, [], { hasToolsCapability: true }));
      assert.equal(empty._tag, "Failure");
      if (empty._tag === "Failure") {
        assert.match(String(empty.cause), /restart required/i);
      }
    }),
  );

  it.effect("maps invalid arguments to isError decode failure", () => {
    const pluginId = PluginId.make("tool-decode");
    return withRuntime(
      pluginId,
      [makeTool()],
      Effect.gen(function* () {
        const catalog = yield* PluginToolCatalog.PluginToolCatalog;
        const result = yield* catalog.makeTrampolineHandle(
          pluginId,
          "echo",
        )({
          // message must be a string
          message: 123,
        });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /invalid arguments/i);
      }),
    );
  });

  it.effect("times out hanging effectful decode (not only the handler)", () => {
    const pluginId = PluginId.make("tool-decode-hang");
    const SlowMessage = Schema.String.pipe(
      Schema.decodeTo(
        Schema.String,
        SchemaTransformation.transformOrFail({
          decode: () => Effect.sleep("5 minutes").pipe(Effect.as("never")),
          encode: (value) => Effect.succeed(value),
        }),
      ),
    );
    const SlowInput = Schema.Struct({ message: SlowMessage });
    return withRuntime(
      pluginId,
      [makeTool({ inputSchema: SlowInput })],
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

  it.effect("maps typed handler failures to isError with the failure message", () => {
    const pluginId = PluginId.make("tool-fail");
    return withRuntime(
      pluginId,
      [
        makeTool({
          handle: () => Effect.fail(new TypedHandlerFailure({ message: "typed-handler-boom" })),
        }),
      ],
      Effect.gen(function* () {
        const catalog = yield* PluginToolCatalog.PluginToolCatalog;
        const result = yield* catalog.makeTrampolineHandle(pluginId, "echo")({ message: "x" });
        assert.equal(result.isError, true);
        assert.match(textOf(result), /typed-handler-boom/);
      }),
    );
  });

  it.effect("scope close interrupts admitted handlers owned by the runtime scope", () => {
    const pluginId = PluginId.make("tool-scope-int");
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
        const registry = yield* PluginRuntimeRegistry.PluginRuntimeRegistry;
        const runtime = yield* registry.get(pluginId);
        assert.equal(runtime._tag, "Some");
        if (runtime._tag !== "Some") return;

        const fiber = yield* catalog
          .makeTrampolineHandle(
            pluginId,
            "echo",
          )({ message: "hang" })
          .pipe(Effect.forkChild);
        yield* TestClock.adjust("1 second");

        yield* catalog.deactivate(pluginId);
        yield* registry.remove(pluginId);
        yield* Scope.close(runtime.value.scope, Exit.void);

        const exit = yield* Fiber.await(fiber);
        assert.equal(Exit.isFailure(exit), true);
        if (Exit.isFailure(exit)) {
          assert.equal(Cause.hasInterrupts(exit.cause), true);
        }
      }),
    );
  });
});

/**
 * Deletion-sensitive coverage for lifecycleAllowsCall's persisted-state check.
 * Catalog stays ACTIVE and runtime stays PRESENT — only the lockfile is not
 * enabled+active. If the persisted-state check were deleted, this call would
 * succeed (other gates already pass). Do not deactivate the catalog here.
 */
const persistedGatePluginId = PluginId.make("tool-persisted-gate");
const persistedGateFinalName = "plugin_tool_persisted_gate__echo";

const disabledLockfileStoreLayer = Layer.succeed(
  PluginLockfileStore,
  PluginLockfileStore.of({
    lockfilePath: "/tmp/plugin-tool-catalog-persisted-gate.json",
    advisoryLockPath: "/tmp/plugin-tool-catalog-persisted-gate.lock",
    readLockfile: Effect.succeed({
      sources: [],
      plugins: {
        [persistedGatePluginId]: {
          version: "1.0.0",
          sha256: "test-sha",
          sourceId: "local",
          enabled: false,
          state: "disabled",
          activation: { activatingSince: null, crashCount: 0 },
          installedAt: "2026-07-03T00:00:00.000Z",
          lastError: null,
        },
      },
    }),
    updateSources: () => Effect.die(new Error("unused")),
    updatePlugin: () => Effect.die(new Error("unused")),
    removePlugin: () => Effect.die(new Error("unused")),
    transition: () => Effect.die(new Error("unused")),
  }),
);

const StoreBackedTestLayer = PluginToolCatalog.layer.pipe(
  Layer.provideMerge(PluginRuntimeRegistry.layer),
  Layer.provideMerge(disabledLockfileStoreLayer),
  Layer.provideMerge(TestClock.layer()),
);

it.layer(StoreBackedTestLayer)("PluginToolCatalog persisted lifecycle gate", (it) => {
  it.effect(
    "fails closed when lockfile enabled:false while catalog active and runtime present",
    () =>
      withRuntime(
        persistedGatePluginId,
        [makeTool()],
        Effect.gen(function* () {
          const catalog = yield* PluginToolCatalog.PluginToolCatalog;
          const registry = yield* PluginRuntimeRegistry.PluginRuntimeRegistry;

          // Both non-lockfile gates remain open — this isolates the persisted check.
          assert.equal(catalog.isActive(persistedGateFinalName), true);
          assert.equal((yield* registry.get(persistedGatePluginId))._tag, "Some");
          assert.equal(yield* catalog.hasDisableIntent(persistedGatePluginId), false);

          const result = yield* catalog.makeTrampolineHandle(
            persistedGatePluginId,
            "echo",
          )({
            message: "must-not-run",
          });
          assert.equal(result.isError, true);
          assert.match(textOf(result), /not enabled/i);

          // Still active after the rejected call — catalog was never deactivated.
          assert.equal(catalog.isActive(persistedGateFinalName), true);
          assert.equal((yield* registry.get(persistedGatePluginId))._tag, "Some");
        }),
      ),
  );
});
