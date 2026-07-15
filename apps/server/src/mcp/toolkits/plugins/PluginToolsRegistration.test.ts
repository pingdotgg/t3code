import { assert, it } from "@effect/vitest";
import { PluginId } from "@t3tools/contracts";
import type { PluginToolDescriptor } from "@t3tools/plugin-sdk";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { FetchHttpClient, HttpRouter } from "effect/unstable/http";
import { RpcSerialization } from "effect/unstable/rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";

import * as PluginRuntimeRegistry from "../../../plugins/PluginRuntimeRegistry.ts";
import type {
  ActivePluginRuntime,
  PluginRuntimeChange,
} from "../../../plugins/PluginRuntimeRegistry.ts";
import * as PluginToolCatalog from "../../../plugins/PluginToolCatalog.ts";
import { CORE_MCP_TOOL_NAMES, PluginToolsRegistrationLive } from "./PluginToolsRegistration.ts";

const pluginId = PluginId.make("hello-board");
const finalName = "plugin_hello_board__echo_note";
const freeFinalName = "plugin_hello_board__echo_free";

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

const makeRuntime = (
  id: PluginId,
  registrationTools: ReadonlyArray<PluginToolDescriptor>,
): Effect.Effect<ActivePluginRuntime> =>
  Effect.gen(function* () {
    const readiness = yield* Deferred.make<void>();
    yield* Deferred.succeed(readiness, undefined);
    const scope = yield* Scope.make("sequential");
    return {
      manifest: {
        id,
        name: "Hello Board",
        version: "1.0.0",
        hostApi: "^1.0.0",
        capabilities: ["tools"] as const,
        entries: { server: "server.js" },
      },
      registration: { tools: registrationTools },
      readiness,
      scope,
    };
  });

const putRuntime = (id: PluginId, registrationTools: ReadonlyArray<PluginToolDescriptor>) =>
  Effect.gen(function* () {
    const registry = yield* PluginRuntimeRegistry.PluginRuntimeRegistry;
    yield* registry.put(id, yield* makeRuntime(id, registrationTools));
  });

const reserveAndPut = (id: PluginId, tools: ReadonlyArray<PluginToolDescriptor>) =>
  Effect.gen(function* () {
    const catalog = yield* PluginToolCatalog.PluginToolCatalog;
    yield* catalog.reserve(id, tools, { hasToolsCapability: true });
    yield* putRuntime(id, tools);
  });

const waitFor = (predicate: Effect.Effect<boolean>, label: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 200; attempt++) {
      if (yield* predicate) return;
      yield* Effect.sleep(Duration.millis(5));
    }
    return yield* Effect.die(new Error(`timed out waiting for ${label}`));
  });

/**
 * Shared services built once in the layer graph so catalog, registry, and the
 * live registration fiber see the same instances.
 */
const RegistryLive = PluginRuntimeRegistry.layer;
const CatalogAndRegistry = PluginToolCatalog.layer.pipe(Layer.provideMerge(RegistryLive));
const ServicesLive = Layer.mergeAll(McpServer.McpServer.layer, CatalogAndRegistry);

/** Real production wiring: stream subscription registers tools on registry put/remove. */
const LiveLayer = PluginToolsRegistrationLive.pipe(Layer.provideMerge(ServicesLive));

/** Live scheduler (not it.layer/TestClock) so the registration fiber can progress. */
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

/**
 * In-process MCP HTTP + RpcClient harness (no real socket). Shares catalog/registry
 * with PluginToolsRegistrationLive so put/remove drive registration while
 * client["tools/list"] exercises the real protocol filter (EnabledWhen).
 */
const makeProtocolClient = Effect.gen(function* () {
  const registry = yield* PluginRuntimeRegistry.make();
  const catalog = yield* PluginToolCatalog.make().pipe(
    Effect.provideService(PluginRuntimeRegistry.PluginRuntimeRegistry, registry),
  );
  const shared = Layer.mergeAll(
    Layer.succeed(PluginRuntimeRegistry.PluginRuntimeRegistry, registry),
    Layer.succeed(PluginToolCatalog.PluginToolCatalog, catalog),
  );

  const appLayer = PluginToolsRegistrationLive.pipe(
    Layer.provideMerge(shared),
    Layer.provideMerge(
      McpServer.layerHttp({
        name: "plugin-tools-test",
        version: "1.0.0",
        path: "/mcp",
      }),
    ),
  );

  const { handler, dispose } = HttpRouter.toWebHandler(appLayer, { disableLogger: true });
  yield* Effect.addFinalizer(() => Effect.promise(() => dispose()));

  let sessionId: string | null = null;
  const customFetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const request =
      input instanceof Request
        ? input
        : new Request(typeof input === "string" ? input : input.toString(), init);
    if (sessionId) {
      request.headers.set("Mcp-Session-Id", sessionId);
    }
    const response = await handler(request);
    const nextSession = response.headers.get("Mcp-Session-Id");
    if (nextSession) {
      sessionId = nextSession;
    }
    return response;
  }) as typeof globalThis.fetch;

  const clientLayer = RpcClient.layerProtocolHttp({ url: "http://localhost/mcp" }).pipe(
    Layer.provideMerge([FetchHttpClient.layer, RpcSerialization.layerJsonRpc()]),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, customFetch)),
  );
  const client = yield* RpcClient.make(McpSchema.ClientRpcs).pipe(Effect.provide(clientLayer));

  // Builds the layer graph (starts PluginToolsRegistrationLive) and establishes
  // a session so tools/list applies EnabledWhen filtering.
  yield* client.initialize({
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "plugin-tools-test", version: "1.0.0" },
  });

  return { client, catalog, registry } as const;
});

it("core tool name set includes preview_snapshot", () => {
  assert.equal(CORE_MCP_TOOL_NAMES.has("preview_snapshot"), true);
  assert.equal(CORE_MCP_TOOL_NAMES.has(finalName), false);
});

it("live put registers once; tools/list hides when inactive; call gate independent of runtime", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { client, catalog, registry } = yield* makeProtocolClient;
      const tool = makeTool();
      yield* catalog.reserve(pluginId, [tool], { hasToolsCapability: true });
      yield* registry.put(pluginId, yield* makeRuntime(pluginId, [tool]));
      yield* waitFor(
        Effect.sync(() => catalog.isActive(finalName)),
        "tool active after put",
      );

      const listedActive = yield* client["tools/list"]({}).pipe(
        Effect.map((result) => result.tools.map((entry) => entry.name)),
      );
      assert.include(listedActive, finalName);

      const callResult = yield* client["tools/call"]({
        name: finalName,
        arguments: { message: "round-trip" },
      });
      assert.equal(callResult.isError, false);
      assert.deepEqual(callResult.content, [{ type: "text", text: "mcp:round-trip" }]);

      // Independent call-time gate: deactivate catalog while runtime remains live.
      // If the active-set gate were removed, this call would still succeed.
      yield* catalog.deactivate(pluginId);
      assert.equal(catalog.isActive(finalName), false);
      const listedInactive = yield* client["tools/list"]({}).pipe(
        Effect.map((result) => result.tools.map((entry) => entry.name)),
      );
      assert.notInclude(listedInactive, finalName);
      const stillInRegistry = yield* registry.get(pluginId);
      assert.equal(stillInRegistry._tag, "Some");
      const gatedWhileRuntimeLive = yield* client["tools/call"]({
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
    }).pipe(Effect.scoped, Effect.orDie),
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
      yield* reserveAndPut(pluginId, [v1]);
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
      yield* reserveAndPut(pluginId, [v2]);
      yield* waitFor(
        Effect.sync(() => catalog.isActive(finalName)),
        "v2 active",
      );

      const second = yield* server.callTool({ name: finalName, arguments: { message: "x" } });
      assert.equal(second.isError, false);
      assert.equal(textOf(second), "version-two");
    }),
  );
});

it("rejects MCP final-name collision without activating or partially adding tools", async () => {
  await runLive(
    Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const catalog = yield* PluginToolCatalog.PluginToolCatalog;

      // Occupy only the SECOND tool's final name.
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

      // TWO pending tools: first free, second collides. Preflight must reject the
      // whole set before any addTool — sequential registration would add the free
      // tool then fail, leaving a permanent partial registration.
      const freeTool = makeTool({ name: "echo_free", title: "Echo free" });
      const collidingTool = makeTool({ name: "echo_note", title: "Echo note" });
      yield* reserveAndPut(pluginId, [freeTool, collidingTool]);

      // Deterministic signal: the registration fiber drains PubSub events in order.
      // A subsequent put that activates proves the collision put was already handled
      // (not a sleep race).
      const signalPluginId = PluginId.make("collision-signal");
      const signalTool = makeTool({ name: "echo_note", title: "Signal" });
      const signalFinalName = "plugin_collision_signal__echo_note";
      yield* reserveAndPut(signalPluginId, [signalTool]);
      yield* waitFor(
        Effect.sync(() => catalog.isActive(signalFinalName)),
        "signal plugin registered after collision put",
      );

      assert.equal(catalog.isActive(freeFinalName), false);
      assert.equal(catalog.isActive(finalName), false);

      // Free tool must never have been added (preflight aborts the whole set).
      assert.equal(server.tools.filter((entry) => entry.tool.name === freeFinalName).length, 0);
      // Both descriptors remain pending MCP registration (no markAddedToMcp).
      const pending = yield* catalog.pendingMcpRegistration(pluginId);
      assert.equal(pending.length, 2);

      // Occupant still serves the colliding final name.
      const call = yield* server.callTool({ name: finalName, arguments: { message: "x" } });
      assert.equal(textOf(call), "occupant");
    }),
  );
});

/**
 * Controlled registry: `list` publishes a concurrent put AFTER the snapshot is
 * taken. With subscribe-before-list the late put is delivered on the stream; with
 * snapshot-then-subscribe it is lost (published with no subscriber, absent from
 * the empty snapshot).
 */
const makeSubscribeFirstRaceRegistry = Effect.gen(function* () {
  const runtimes = yield* Ref.make(new Map<PluginId, ActivePluginRuntime>());
  const changesPubSub = yield* PubSub.unbounded<PluginRuntimeChange>();
  const latePluginId = PluginId.make("late-during-list");
  const lateTool = makeTool({ name: "echo_note", title: "Late echo" });
  const lateFinalName = "plugin_late_during_list__echo_note";

  const put = (id: PluginId, runtime: ActivePluginRuntime) =>
    Ref.update(runtimes, (current) => {
      const next = new Map(current);
      next.set(id, runtime);
      return next;
    }).pipe(
      Effect.andThen(
        PubSub.publish(changesPubSub, { _tag: "put", pluginId: id, runtime }).pipe(Effect.asVoid),
      ),
    );

  const registry = PluginRuntimeRegistry.PluginRuntimeRegistry.of({
    put,
    remove: (id) =>
      Ref.update(runtimes, (current) => {
        const next = new Map(current);
        next.delete(id);
        return next;
      }).pipe(
        Effect.andThen(
          PubSub.publish(changesPubSub, { _tag: "remove", pluginId: id }).pipe(Effect.asVoid),
        ),
      ),
    list: Effect.gen(function* () {
      const snapshot = yield* Ref.get(runtimes);
      // Concurrent put after snapshot read, before this effect returns.
      const runtime = yield* makeRuntime(latePluginId, [lateTool]);
      yield* put(latePluginId, runtime);
      return Array.from(snapshot.values());
    }),
    get: (id) =>
      Ref.get(runtimes).pipe(Effect.map((current) => Option.fromUndefinedOr(current.get(id)))),
    subscribeChanges: PubSub.subscribe(changesPubSub),
    changes: Stream.fromPubSub(changesPubSub),
  });

  return { registry, latePluginId, lateTool, lateFinalName };
});

it("registers a put that lands between snapshot list and stream attach (subscribe-first)", async () => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const { registry, latePluginId, lateTool, lateFinalName } =
        yield* makeSubscribeFirstRaceRegistry;
      const catalog = yield* PluginToolCatalog.make().pipe(
        Effect.provideService(PluginRuntimeRegistry.PluginRuntimeRegistry, registry),
      );

      yield* catalog.reserve(latePluginId, [lateTool], { hasToolsCapability: true });

      const registrationLayer = PluginToolsRegistrationLive.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Layer.succeed(PluginRuntimeRegistry.PluginRuntimeRegistry, registry),
            Layer.succeed(PluginToolCatalog.PluginToolCatalog, catalog),
            McpServer.McpServer.layer,
          ),
        ),
      );

      yield* Layer.build(registrationLayer);
      yield* waitFor(
        Effect.sync(() => catalog.isActive(lateFinalName)),
        "late put during list registered via subscribe-first",
      );
    }).pipe(Effect.scoped),
  );
});
