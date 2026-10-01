import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { EnvironmentExtensions } from "./EnvironmentExtensions.ts";
import type { ClientApiProviders } from "./ClientApiProviders.ts";
import { handlers } from "./mcp.ts";
import { McpInvocationContext, type McpCapability } from "../mcp/McpInvocationContext.ts";

const unusedClientApiProviders = {
  connect: () => Effect.die("unused"),
  respond: () => Effect.die("unused"),
  emit: () => Effect.die("unused"),
  invoke: () => Effect.die("unused"),
  openSubscription: () => Effect.die("unused"),
  registerCorrelation: () => Effect.die("unused"),
  unregisterCorrelation: () => Effect.die("unused"),
  listTargets: () => Effect.die("unused"),
  resolveTarget: () => Effect.die("unused"),
  hasProvider: () => Effect.die("unused"),
  connectionForSession: () => Effect.die("unused"),
} satisfies ClientApiProviders["Service"];

const context = {
  resource: {
    namespace: "t3.extensions",
    id: "thread-a",
    environmentId: "env-a",
    projectId: "project-a",
    threadId: "thread-a",
  },
  workspaceRevision: JSON.stringify(["/project", null]),
  client: "mcp",
};
const hash = "a".repeat(64);
const tool = {
  installationId: "fixture.reader",
  contentHash: hash,
  descriptor: {
    id: "fixture.reader/read",
    title: "Read",
    description: "Read fixture",
    inputSchema: { type: "object" },
    readOnly: true as const,
    capabilities: [],
  },
};
function fixture(capabilities: readonly McpCapability[], resolvedContext = context) {
  const calls: unknown[] = [];
  const contexts: unknown[] = [];
  let available = true;
  const service = EnvironmentExtensions.of({
    list: Effect.succeed([]),
    catalogue: Effect.succeed({ apiSelections: [], apiResolution: [], pluginResolution: [] }),
    invokeApi: () => Effect.die("unused"),
    subscribeApi: () => Stream.die("unused"),
    discoverApis: () => Effect.die("unused"),
    selectApi: () => Effect.die("unused"),
    install: () => Effect.die("unused"),
    manage: () => Effect.die("unused"),
    asset: () => Effect.succeed(new Uint8Array()),
    client: () => Effect.die("unused"),
    invoke: (input) =>
      Effect.sync(() => {
        calls.push(input);
        return { ok: true };
      }),
    contextForThread: (threadId, environmentId) =>
      Effect.sync(() => {
        contexts.push({ threadId, environmentId });
        return resolvedContext;
      }),
    tools: () => Effect.sync(() => (available ? [tool] : [])),
    clientApiProviders: unusedClientApiProviders,
  });
  const invocation = {
    environmentId: EnvironmentId.make("env-a"),
    threadId: ThreadId.make("thread-a"),
    providerSessionId: "session-a",
    providerInstanceId: ProviderInstanceId.make("codex"),
    capabilities: new Set(capabilities),
    issuedAt: 1,
  };
  const provide = <A, E>(
    effect: Effect.Effect<A, E, EnvironmentExtensions | McpInvocationContext>,
  ) =>
    effect.pipe(
      Effect.provideService(EnvironmentExtensions, service),
      Effect.provideService(McpInvocationContext, invocation),
    );
  return {
    calls,
    contexts,
    provide,
    remove: () => {
      available = false;
    },
  };
}
it.effect("MCP extension capability is required before resolving context or executing tools", () =>
  Effect.gen(function* () {
    const f = fixture(["preview"]);
    expect((yield* f.provide(Effect.flip(handlers.extensions_list({})))).detail).toContain(
      "capability",
    );
    expect(f.contexts).toEqual([]);
    expect(f.calls).toEqual([]);
  }),
);
it.effect(
  "MCP call derives credential scope and ignores caller context, requiring exact installed hash",
  () =>
    Effect.gen(function* () {
      const f = fixture(["extensions"]);
      const input = {
        toolId: tool.descriptor.id,
        input: { relativePath: "new.txt" },
        expectedContentHash: hash,
        context: { resource: { environmentId: "attacker", projectId: "other" }, cwd: "/private" },
      };
      yield* f.provide(handlers.extensions_call(input));
      expect(f.contexts).toEqual([{ threadId: "thread-a", environmentId: "env-a" }]);
      expect(f.calls).toEqual([{ ...input, context }]);
      expect(
        (yield* f.provide(
          Effect.flip(handlers.extensions_call({ ...input, expectedContentHash: "b".repeat(64) })),
        )).detail,
      ).toContain("changed");
      f.remove();
      expect((yield* f.provide(Effect.flip(handlers.extensions_call(input)))).detail).toContain(
        "unavailable",
      );
      expect(f.calls.length).toBe(1);
    }),
);

it.effect("oversized derived workspace context fails as an operation error before invocation", () =>
  Effect.gen(function* () {
    const f = fixture(["extensions"], { ...context, workspaceRevision: "x".repeat(1025) });
    const error = yield* f.provide(
      Effect.flip(
        handlers.extensions_call({
          toolId: tool.descriptor.id,
          input: {},
          expectedContentHash: hash,
        }),
      ),
    );
    expect(error._tag).toBe("ExtensionOperationError");
    expect(f.calls).toEqual([]);
  }),
);
