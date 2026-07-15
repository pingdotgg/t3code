import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";
import type { PluginToolDescriptor } from "@t3tools/plugin-sdk";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { McpSchema, McpServer } from "effect/unstable/ai";

import * as PluginRuntimeRegistry from "../../../plugins/PluginRuntimeRegistry.ts";
import * as PluginToolCatalog from "../../../plugins/PluginToolCatalog.ts";
import { CORE_MCP_TOOL_NAMES, PluginToolsRegistrationLive } from "./PluginToolsRegistration.ts";

const pluginId = PluginId.make("hello-board");
const finalName = "plugin_hello_board__echo_note";

const clientHandshake = {
  protocolVersion: "2025-03-26",
  capabilities: {},
  clientInfo: { name: "test", version: "1.0.0" },
} as const;

/**
 * Mirrors McpServer tools/list filtering: EnabledWhen decides visibility.
 * Raw `server.tools` always includes permanently registered tools.
 */
const listToolsAsProtocol = (server: {
  readonly tools: ReadonlyArray<{
    readonly tool: { readonly name: string };
    readonly annotations: Context.Context<never>;
  }>;
}): ReadonlyArray<string> => {
  const names: Array<string> = [];
  for (const entry of server.tools) {
    const enabledWhen = Context.getOption(entry.annotations, McpSchema.EnabledWhen);
    if (enabledWhen._tag === "None" || enabledWhen.value(clientHandshake)) {
      names.push(entry.tool.name);
    }
  }
  return names;
};

const makeTool = (
  overrides: Partial<PluginToolDescriptor> & { readonly name?: string } = {},
): PluginToolDescriptor => {
  const name = overrides.name ?? "echo_note";
  return {
    name,
    description: overrides.description ?? "Echo a short message for MCP registration tests.",
    inputSchema: overrides.inputSchema ?? Schema.Struct({ message: Schema.String }),
    scope: overrides.scope ?? "read",
    title: overrides.title ?? "Echo note",
    handle:
      overrides.handle ??
      ((input) => {
        const message =
          typeof input === "object" && input !== null && "message" in input
            ? String((input as { message: unknown }).message)
            : "";
        return Effect.succeed({
          content: [{ type: "text" as const, text: `mcp:${message}` }],
        });
      }),
    ...("destructive" in overrides ? { destructive: overrides.destructive } : {}),
    ...("idempotent" in overrides ? { idempotent: overrides.idempotent } : {}),
    ...("openWorld" in overrides ? { openWorld: overrides.openWorld } : {}),
  };
};

const textOf = (result: {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}) => {
  const first = result.content[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
};

/**
 * Shared services built once in the layer graph so catalog, registry, and the
 * live registration fiber see the same instances.
 */
const RegistryLive = PluginRuntimeRegistry.layer;
const CatalogAndRegistry = PluginToolCatalog.layer.pipe(Layer.provideMerge(RegistryLive));
const ServicesLive = Layer.mergeAll(McpServer.McpServer.layer, CatalogAndRegistry);

/** Real production wiring: stream subscription registers tools on registry put/remove. */
const LiveLayer = PluginToolsRegistrationLive.pipe(Layer.provideMerge(ServicesLive));

const waitFor = (predicate: Effect.Effect<boolean>, label: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (yield* predicate) return;
      yield* Effect.sleep(Duration.millis(5));
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

const putRuntime = (registrationTools: ReadonlyArray<PluginToolDescriptor>) =>
  Effect.gen(function* () {
    const registry = yield* PluginRuntimeRegistry.PluginRuntimeRegistry;
    const readiness = yield* Deferred.make<void>();
    yield* Deferred.succeed(readiness, undefined);
    const scope = yield* Scope.make("sequential");
    yield* registry.put(pluginId, {
      manifest: {
        id: pluginId,
        name: "Hello Board",
        version: "1.0.0",
        hostApi: "^1.0.0",
        capabilities: ["tools"],
        entries: { server: "server.js" },
      },
      registration: { tools: registrationTools },
      readiness,
      scope,
    });
  });

const reserveAndPut = (tools: ReadonlyArray<PluginToolDescriptor>) =>
  Effect.gen(function* () {
    const catalog = yield* PluginToolCatalog.PluginToolCatalog;
    yield* catalog.reserve(pluginId, tools, { hasToolsCapability: true });
    yield* putRuntime(tools);
  });

/** Live scheduler (not it.layer/TestClock) so the registration fiber and sleep can progress. */
const runLive = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | McpServer.McpServer
    | McpSchema.McpServerClient
    | PluginRuntimeRegistry.PluginRuntimeRegistry
    | PluginToolCatalog.PluginToolCatalog
  >,
): Promise<A> =>
  Effect.runPromise(effect.pipe(Effect.provide(LiveLayer), Effect.scoped) as Effect.Effect<A, E>);

it("core tool name set includes preview_snapshot", () => {
  assert.equal(CORE_MCP_TOOL_NAMES.has("preview_snapshot"), true);
  assert.equal(CORE_MCP_TOOL_NAMES.has(finalName), false);
});

it("live put registers once; tools/list hides when inactive; call gate independent of runtime", async () => {
  await runLive(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const registry = yield* PluginRuntimeRegistry.PluginRuntimeRegistry;
      const catalog = yield* PluginToolCatalog.PluginToolCatalog;
      const tool = makeTool();

      yield* reserveAndPut([tool]);
      yield* waitFor(
        Effect.sync(() => catalog.isActive(finalName)),
        "tool active after put",
      );

      // Protocol tools/list (EnabledWhen), not raw server.tools membership alone.
      assert.include(listToolsAsProtocol(server), finalName);
      const permanentCount = server.tools.filter((entry) => entry.tool.name === finalName).length;
      assert.equal(permanentCount, 1);

      const callResult = yield* server.callTool({
        name: finalName,
        arguments: { message: "round-trip" },
      });
      assert.equal(callResult.isError, false);
      assert.deepEqual(callResult.content, [{ type: "text", text: "mcp:round-trip" }]);

      // Independent call-time gate: deactivate catalog while runtime remains live.
      // If the active-set gate were removed, this call would still succeed.
      yield* catalog.deactivate(pluginId);
      assert.equal(catalog.isActive(finalName), false);
      assert.notInclude(listToolsAsProtocol(server), finalName);
      const stillInRegistry = yield* registry.get(pluginId);
      assert.equal(stillInRegistry._tag, "Some");
      const gatedWhileRuntimeLive = yield* server.callTool({
        name: finalName,
        arguments: { message: "nope" },
      });
      assert.equal(gatedWhileRuntimeLive.isError, true);
      assert.match(textOf(gatedWhileRuntimeLive), /not enabled/i);

      yield* registry.remove(pluginId);
      yield* waitFor(
        Effect.sync(() => !catalog.isActive(finalName)),
        "still inactive after remove",
      );
    }),
  );
});

it("reactivation with a CHANGED handler uses the new descriptor (trampoline)", async () => {
  await runLive(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const registry = yield* PluginRuntimeRegistry.PluginRuntimeRegistry;
      const catalog = yield* PluginToolCatalog.PluginToolCatalog;

      const v1 = makeTool({
        handle: () =>
          Effect.succeed({
            content: [{ type: "text" as const, text: "version-one" }],
          }),
      });
      yield* reserveAndPut([v1]);
      yield* waitFor(
        Effect.sync(() => catalog.isActive(finalName)),
        "v1 active",
      );
      const first = yield* server.callTool({ name: finalName, arguments: { message: "x" } });
      assert.equal(textOf(first), "version-one");

      yield* registry.remove(pluginId);
      yield* waitFor(
        Effect.sync(() => !catalog.isActive(finalName)),
        "deactivated after remove",
      );

      // Same metadata (fingerprint), different handle — proves no handler capture.
      const v2 = makeTool({
        handle: () =>
          Effect.succeed({
            content: [{ type: "text" as const, text: "version-two" }],
          }),
      });
      yield* reserveAndPut([v2]);
      yield* waitFor(
        Effect.sync(() => catalog.isActive(finalName)),
        "v2 active",
      );

      const listed = listToolsAsProtocol(server).filter((name) => name === finalName);
      assert.equal(listed.length, 1);
      const second = yield* server.callTool({ name: finalName, arguments: { message: "x" } });
      assert.equal(second.isError, false);
      assert.equal(textOf(second), "version-two");
    }),
  );
});

it("rejects MCP final-name collision without activating the plugin", async () => {
  await runLive(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const catalog = yield* PluginToolCatalog.PluginToolCatalog;
      const tool = makeTool();

      // Occupy the final name before the live registration path runs.
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: finalName,
          description: "pre-existing occupant",
          inputSchema: { type: "object", properties: {} },
        }),
        annotations: Context.empty(),
        handle: () =>
          Effect.succeed(
            new McpSchema.CallToolResult({
              content: [{ type: "text", text: "occupant" }],
            }),
          ),
      });

      yield* reserveAndPut([tool]);
      // Allow the stream handler a chance to attempt (and fail) registration.
      yield* Effect.sleep(Duration.millis(50));

      assert.equal(catalog.isActive(finalName), false);
      // Occupant has no EnabledWhen, so it remains visible; plugin never activated.
      const call = yield* server.callTool({ name: finalName, arguments: { message: "x" } });
      assert.equal(textOf(call), "occupant");
    }),
  );
});
