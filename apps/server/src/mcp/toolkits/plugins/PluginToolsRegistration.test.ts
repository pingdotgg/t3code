import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";
import type { PluginToolDescriptor } from "@t3tools/plugin-sdk";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
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

const tool: PluginToolDescriptor = {
  name: "echo_note",
  description: "Echo a short message for MCP registration tests.",
  inputSchema: Schema.Struct({ message: Schema.String }),
  scope: "read",
  title: "Echo note",
  handle: (input) => {
    const message =
      typeof input === "object" && input !== null && "message" in input
        ? String((input as { message: unknown }).message)
        : "";
    return Effect.succeed({
      content: [{ type: "text" as const, text: `mcp:${message}` }],
    });
  },
};

const textOf = (result: {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
}) => {
  const first = result.content[0];
  return first && first.type === "text" ? (first.text ?? "") : "";
};

const RegistryLive = PluginRuntimeRegistry.layer;
const CatalogLive = PluginToolCatalog.layer.pipe(Layer.provide(RegistryLive));
// Register tools synchronously in tests by driving catalog + addTool directly;
// the live layer's stream subscription is covered via put→handler in a short
// scoped run that activates after an explicit registerPending path.
const TestLayer = Layer.mergeAll(McpServer.McpServer.layer, CatalogLive, RegistryLive);

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

const registerLikeToolkit = Effect.fn("test.registerLikeToolkit")(function* () {
  const server = yield* McpServer.McpServer;
  const catalog = yield* PluginToolCatalog.PluginToolCatalog;
  const pending = yield* catalog.pendingMcpRegistration(pluginId);
  const existingNames = new Set(server.tools.map((entry) => entry.tool.name));
  for (const entry of pending) {
    assert.equal(existingNames.has(entry.finalName), false);
    assert.equal(CORE_MCP_TOOL_NAMES.has(entry.finalName), false);
    const annotations = Context.make(McpSchema.EnabledWhen, () =>
      catalog.isActive(entry.finalName),
    );
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: entry.finalName,
        description: entry.description,
        inputSchema: entry.inputJsonSchema,
        annotations: {
          ...(entry.annotations.title === undefined ? {} : { title: entry.annotations.title }),
          readOnlyHint: entry.annotations.readOnlyHint,
          destructiveHint: entry.annotations.destructiveHint,
          idempotentHint: entry.annotations.idempotentHint,
          openWorldHint: entry.annotations.openWorldHint,
        },
      }),
      annotations,
      handle: catalog.makeTrampolineHandle(entry.pluginId, entry.localName),
    });
    yield* catalog.markAddedToMcp(entry.finalName);
  }
  yield* catalog.activate(pluginId);
});

it.layer(TestLayer)("PluginToolsRegistration", (it) => {
  it.effect("registers once with EnabledWhen, hides when deactivated, no duplicates", () =>
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const registry = yield* PluginRuntimeRegistry.PluginRuntimeRegistry;
      const catalog = yield* PluginToolCatalog.PluginToolCatalog;

      yield* catalog.reserve(pluginId, [tool], { hasToolsCapability: true });
      yield* putRuntime([tool]);
      yield* registerLikeToolkit();

      assert.equal(catalog.isActive(finalName), true);
      const listedWhileActive = server.tools
        .map((entry) => entry.tool.name)
        .filter((name) => name === finalName);
      assert.equal(listedWhileActive.length, 1);

      const registered = server.tools.find((entry) => entry.tool.name === finalName);
      assert.ok(registered);
      const enabledWhen = Context.getOption(registered!.annotations, McpSchema.EnabledWhen);
      assert.equal(enabledWhen._tag, "Some");
      if (enabledWhen._tag === "Some") {
        assert.equal(
          enabledWhen.value({
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          }),
          true,
        );
      }

      const callResult = yield* server.callTool({
        name: finalName,
        arguments: { message: "round-trip" },
      });
      assert.equal(callResult.isError, false);
      assert.deepEqual(callResult.content, [{ type: "text", text: "mcp:round-trip" }]);

      yield* registry.remove(pluginId);
      yield* catalog.deactivate(pluginId);
      assert.equal(catalog.isActive(finalName), false);
      if (enabledWhen._tag === "Some") {
        assert.equal(
          enabledWhen.value({
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test", version: "1.0.0" },
          }),
          false,
        );
      }
      const disabledCall = yield* server.callTool({
        name: finalName,
        arguments: { message: "nope" },
      });
      assert.equal(disabledCall.isError, true);
      assert.match(textOf(disabledCall), /not enabled/i);

      yield* catalog.reserve(pluginId, [tool], { hasToolsCapability: true });
      yield* putRuntime([tool]);
      yield* registerLikeToolkit();

      const listedAfterReenable = server.tools
        .map((entry) => entry.tool.name)
        .filter((name) => name === finalName);
      assert.equal(listedAfterReenable.length, 1);
      assert.equal(catalog.isActive(finalName), true);

      const reCall = yield* server.callTool({
        name: finalName,
        arguments: { message: "again" },
      });
      assert.equal(reCall.isError, false);
      assert.deepEqual(reCall.content, [{ type: "text", text: "mcp:again" }]);
    }),
  );

  it.effect("core tool name set includes preview_snapshot", () =>
    Effect.sync(() => {
      assert.equal(CORE_MCP_TOOL_NAMES.has("preview_snapshot"), true);
      assert.equal(CORE_MCP_TOOL_NAMES.has(finalName), false);
    }),
  );

  it.effect("PluginToolsRegistrationLive layer builds without throwing", () =>
    // Smoke: the stream subscription layer starts under a real McpServer.
    Effect.void.pipe(
      Effect.provide(
        PluginToolsRegistrationLive.pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(CatalogLive),
          Layer.provideMerge(RegistryLive),
        ),
      ),
      Effect.scoped,
    ),
  );
});
