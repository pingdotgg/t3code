import { assert, it } from "@effect/vitest";
import { EnvironmentId, PluginId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { PluginApi, PluginDefinition } from "@t3tools/plugin-sdk/server";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as McpHttpServer from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { liveThreadsLayer } from "../mcp/McpToolAccess.testkit.ts";
import { makeFacadeContext } from "./api/facade.ts";
import { makeMcpApi } from "./api/mcp.ts";
import { makePluginActivation } from "./PluginApi.ts";
import * as PluginMcpTools from "./PluginMcpTools.ts";

const fixturesDir = new URL("../../../../packages/plugin-sdk/fixtures/", import.meta.url).pathname;
const mcpPlugin = PluginId.make("mcp-plugin");

const layerTest = McpHttpServer.layerPluginTools.pipe(
  Layer.provideMerge(PluginMcpTools.layer),
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(liveThreadsLayer),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const threadCaller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "provider:thread",
  thread: {
    threadId: ThreadId.make("thread:caller"),
    providerSessionId: "provider:thread",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(),
  issuedAt: 0,
};

// Plugin write tools need what environment writes need: a full-access caller.
const fullAccessClient: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:full",
  thread: undefined,
  client: { sessionId: "full", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const readOnlyClient: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access: "read-only" },
  capabilities: new Set(),
  issuedAt: 0,
};

const call = (
  name: string,
  scope: McpInvocationContext.McpInvocationScope,
  args: Record<string, unknown> = {},
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.map((result) => ({
      isError: result.isError === true,
      text: result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
    })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

// What `tools/list` shows the client: the tools whose `EnabledWhen` passes.
const toolNames = McpServer.McpServer.pipe(
  Effect.map((server) =>
    server.tools
      .filter(
        ({ annotations }) =>
          Context.getOrUndefined(
            annotations,
            McpSchema.EnabledWhen,
          )?.({
            protocolVersion: mcpClient.protocolVersion,
            capabilities: mcpClient.clientCapabilities,
            clientInfo: mcpClient.clientInfo,
          }) ?? true,
      )
      .map(({ tool }) => tool.name),
  ),
);

/** Lists tools, then calls `name`, which must be gone from both. */
const assertGone = Effect.fn(function* (name: string) {
  assert.notInclude(yield* toolNames, name);
  const notFound = yield* call(name, fullAccessClient).pipe(Effect.flip);
  assert.include(notFound.message, "not found");
});

const isDefinition = (value: unknown): value is PluginDefinition =>
  typeof value === "object" &&
  value !== null &&
  "activate" in value &&
  typeof value.activate === "function";

/** Activates the fixture with only the `mcp` group, the one it uses. */
const activateFixture = Effect.fn(function* () {
  const loaded: unknown = yield* Effect.promise(
    () => import(`${fixturesDir}mcp-plugin/server.cjs`),
  );
  const definition =
    typeof loaded === "object" && loaded !== null && "default" in loaded
      ? loaded.default
      : undefined;
  assert(isDefinition(definition));
  const activation = makePluginActivation();
  const facade = makeFacadeContext({
    pluginId: mcpPlugin,
    activation,
    context: yield* Effect.context<never>(),
  });
  const api: Pick<PluginApi, "mcp"> = {
    mcp: makeMcpApi(facade, { mcpTools: yield* PluginMcpTools.PluginMcpTools }),
  };
  yield* Effect.promise(() => Promise.resolve(definition.activate(api as PluginApi)));
  return { ...api, activation };
});

it.effect("answer under plg_ names with access checks, and leave the list once stopped", () =>
  Effect.gen(function* () {
    const api = yield* activateFixture();
    api.mcp.registerTool(
      { name: "fail", description: "Throws.", inputSchema: { type: "object" }, access: "read" },
      () => {
        throw new Error("boom");
      },
    );
    api.mcp.registerTool(
      {
        name: "caller",
        description: "Names its caller.",
        inputSchema: { type: "object" },
        access: "read",
      },
      (_input, { threadId }) => ({ threadId }),
    );
    assert.throws(
      () =>
        api.mcp.registerTool(
          { name: "no spaces", description: "", inputSchema: {}, access: "read" },
          () => null,
        ),
      TypeError,
    );
    // Anthropic's API refuses the whole tool list over one of these at the top.
    assert.throws(
      () =>
        api.mcp.registerTool(
          {
            name: "either",
            description: "Takes one of two shapes.",
            inputSchema: { type: "object", oneOf: [{ required: ["a"] }, { required: ["b"] }] },
            access: "read",
          },
          () => null,
        ),
      /oneOf at the top of its input schema/,
    );
    assert.throws(
      () =>
        api.mcp.registerTool(
          {
            name: "verbose",
            description: "x".repeat(1001),
            inputSchema: { type: "object" },
            access: "read",
          },
          () => null,
        ),
      /1000 characters/,
    );
    assert.throws(
      () =>
        api.mcp.registerTool(
          {
            name: "wide",
            description: "Takes a long schema.",
            inputSchema: { type: "object", description: "x".repeat(4000) },
            access: "read",
          },
          () => null,
        ),
      /4000 characters/,
    );

    const names = yield* toolNames;
    assert.includeMembers(names, ["plg_mcp-plugin_echo", "plg_mcp-plugin_touch"]);
    assert.deepStrictEqual(yield* call("plg_mcp-plugin_echo", readOnlyClient, { text: "hi" }), {
      isError: false,
      text: '{"echoed":"hi"}',
    });
    const refused = yield* call("plg_mcp-plugin_touch", readOnlyClient);
    assert.isTrue(refused.isError);
    assert.include(refused.text, "read-only");
    assert.deepStrictEqual(yield* call("plg_mcp-plugin_touch", fullAccessClient), {
      isError: false,
      text: '{"touches":1}',
    });
    assert.deepStrictEqual(yield* call("plg_mcp-plugin_caller", threadCaller), {
      isError: false,
      text: '{"threadId":"thread:caller"}',
    });
    assert.deepStrictEqual(yield* call("plg_mcp-plugin_caller", fullAccessClient), {
      isError: false,
      text: '{"threadId":null}',
    });
    assert.deepStrictEqual(yield* call("plg_mcp-plugin_fail", threadCaller), {
      isError: true,
      text: "Plugin mcp-plugin failed in fail: boom",
    });

    // A call to a handler that ignores its abort signal ends at the deadline, which aborts the
    // signal, or when the plugin turns off.
    const signals: Array<AbortSignal> = [];
    let reached = Promise.withResolvers<void>();
    api.mcp.registerTool(
      {
        name: "hang",
        description: "Never answers.",
        inputSchema: { type: "object" },
        access: "read",
      },
      (_input, { signal }) => {
        signals.push(signal);
        reached.resolve();
        return new Promise(() => undefined);
      },
    );
    const timedOut = yield* call("plg_mcp-plugin_hang", threadCaller).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.promise(() => reached.promise);
    yield* TestClock.adjust(Duration.minutes(5));
    assert.deepStrictEqual(yield* Fiber.join(timedOut), {
      isError: true,
      text: "Plugin mcp-plugin did not answer hang within 5 minutes.",
    });
    assert.isTrue(signals[0]?.aborted);

    reached = Promise.withResolvers<void>();
    const hanging = yield* call("plg_mcp-plugin_hang", threadCaller).pipe(
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Effect.promise(() => reached.promise);

    const offered = (yield* toolNames).filter((name) => name.startsWith("plg_mcp-plugin_"));
    const extra = {
      description: "Extra.",
      inputSchema: { type: "object" },
      access: "read",
    } as const;
    for (let index = offered.length; index < 32; index++) {
      api.mcp.registerTool({ ...extra, name: `extra-${index}` }, () => null);
    }
    assert.throws(
      () => api.mcp.registerTool({ ...extra, name: "one-more" }, () => null),
      /at most 32 tools/,
    );
    // Replacing a tool doesn't add one.
    api.mcp.registerTool({ ...extra, name: "caller" }, () => null);

    api.activation.controller.abort();
    assert.deepStrictEqual(yield* Fiber.join(hanging), {
      isError: true,
      text: "Plugin mcp-plugin is disabled.",
    });

    const tools = yield* PluginMcpTools.PluginMcpTools;
    yield* tools.unregisterPlugin(mcpPlugin);
    yield* assertGone("plg_mcp-plugin_echo");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a tool past its plugin's 24,000 characters of definitions, not another's", () =>
  Effect.gen(function* () {
    const tools = yield* PluginMcpTools.PluginMcpTools;
    // About 5,000 characters each, with its name and schema.
    const register = (pluginId: PluginId, name: string, description = "x".repeat(1000)) =>
      tools.register({
        pluginId,
        tool: {
          name,
          description,
          inputSchema: { type: "object", description: "x".repeat(3900) },
          access: "read",
        },
        handler: () => Promise.resolve(null),
        deactivated: new AbortController().signal,
      });
    const budget = PluginId.make("budget");
    const other = PluginId.make("other");
    for (const name of ["a", "b", "c", "d"]) yield* register(budget, name);
    const refused = yield* register(budget, "e").pipe(Effect.flip);
    assert.include(refused.message, "at most 24,000 characters");
    for (const name of ["a", "b", "c", "d"]) yield* register(other, name);
    // A tool replaced by a smaller one leaves room for another.
    yield* register(budget, "d", "Short.");
    yield* register(budget, "e");
  }).pipe(Effect.provide(PluginMcpTools.layer)),
);
