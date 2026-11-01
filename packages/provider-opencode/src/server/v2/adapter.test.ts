import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { EnvironmentId, ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as orchestrationInstructions from "@t3tools/provider-core/server/orchestrationInstructions";
import { mcpRules, make, t3McpServerName } from "./adapter.ts";
import * as OpenCode2Server from "./OpenCode2Server.ts";

type RecordedCall = { readonly op: string; readonly args: Record<string, unknown> };

const recordingClient = (calls: Array<RecordedCall>) =>
  ({
    mcp: {
      add: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          calls.push({ op: "mcp.add", args: input });
          return {};
        }),
      remove: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          calls.push({ op: "mcp.remove", args: input });
          return {};
        }),
    },
    session: {
      create: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          calls.push({ op: "session.create", args: input });
          return { id: "ses_fake", location: { directory: "/workspace" } };
        }),
      get: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          calls.push({ op: "session.get", args: input });
          return { id: input.sessionID, location: { directory: "/workspace" } };
        }),
      fork: (input: Record<string, unknown>) =>
        Effect.sync(() => {
          calls.push({ op: "session.fork", args: input });
          return { id: "ses_fork", location: { directory: "/workspace" } };
        }),
      update: (input: Record<string, unknown>) =>
        Effect.sync(() => void calls.push({ op: "session.update", args: input })),
      move: (input: Record<string, unknown>) =>
        Effect.sync(() => void calls.push({ op: "session.move", args: input })),
      form: { list: () => Effect.succeed([]) },
    },
    model: { list: () => Effect.succeed({ data: [] }) },
    agent: { list: () => Effect.succeed({ data: [{ id: "build", permissions: [] }] }) },
    permission: { list: () => Effect.succeed([]) },
    message: { list: () => Effect.succeed({ data: [] }) },
  }) as unknown as OpenCode2Server.OpenCode2Connection["client"];

const makeLayers = (
  calls: Array<RecordedCall>,
  events: OpenCode2Server.OpenCode2Connection["events"] = Effect.succeed(Stream.never),
) => {
  const connection = {
    client: recordingClient(calls),
    events,
    url: "http://127.0.0.1:4096",
    version: "2.1.2",
    external: false,
  } as unknown as OpenCode2Server.OpenCode2Connection;
  return Layer.mergeAll(
    Layer.succeed(OpenCode2Server.OpenCode2Server, {
      withConnection: <A, E, R>(
        use: (connection: OpenCode2Server.OpenCode2Connection) => Effect.Effect<A, E, R>,
      ) => use(connection),
    } as unknown as OpenCode2Server.OpenCode2Server["Service"]),
    Layer.succeed(ProviderHost.ProviderHost, {
      paths: { cwd: "/workspace" },
      resolveAttachmentPath: () => null,
    } as unknown as ProviderHost.ProviderHost["Service"]),
    IdAllocator.layer,
    McpProviderSessions.layer,
    ProviderContinuationRequests.layer,
  ).pipe(Layer.provideMerge(NodeServices.layer));
};

const mcpConfig = (threadId: ThreadId) => ({
  environmentId: EnvironmentId.make("environment-test"),
  threadId,
  providerSessionId: ProviderSessionId.make("provider-session-test"),
  providerInstanceId: ProviderInstanceId.make("opencode-test"),
  endpoint: "http://127.0.0.1:4096/mcp",
  authorizationHeader: "Bearer test-token",
  browserToolsAvailable: false,
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
});

const runtimePolicy = () =>
  ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode: "full-access",
    interactionMode: "default",
    cwd: "/workspace",
  });

const openFor = (
  adapter: ProviderAdapter.ProviderAdapterV2["Service"],
  threadId: ThreadId,
  cwd?: string,
) =>
  adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make(`provider-session-${threadId}`),
    modelSelection: {
      instanceId: ProviderInstanceId.make("opencode-test"),
      model: "anthropic/claude-sonnet",
      options: [],
    },
    runtimePolicy:
      cwd === undefined
        ? runtimePolicy()
        : ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd,
          }),
  });

it.effect.each(["unload", "create"] as const)(
  "keeps pre-registration cleanup after reconnect before %s",
  (action) =>
    Effect.gen(function* () {
      const disconnect = yield* Deferred.make<void>();
      const reconnected = yield* Deferred.make<void>();
      const calls: Array<RecordedCall> = [];
      let subscriptions = 0;
      const events = Effect.sync(() =>
        ++subscriptions === 1
          ? Stream.fromEffect(Deferred.await(disconnect)).pipe(Stream.drain)
          : Stream.fromEffect(Deferred.succeed(reconnected, undefined)).pipe(
              Stream.flatMap(() => Stream.never),
            ),
      );
      yield* Effect.gen(function* () {
        const threadId = ThreadId.make("thread-reconnect");
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.set(mcpConfig(threadId));
        const adapter = yield* make(ProviderInstanceId.make("opencode-test"));
        const runtime = yield* openFor(adapter, threadId);
        const input = {
          threadId,
          runtimePolicy: runtimePolicy(),
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode-test"),
            model: "anthropic/claude-sonnet",
            options: [],
          },
        };
        const providerThread = yield* runtime.ensureThread(input);
        calls.length = 0;
        yield* Deferred.succeed(disconnect, undefined);
        yield* Deferred.await(reconnected);
        if (action === "unload") {
          yield* runtime.unloadThread!({ providerThread });
          assert.deepStrictEqual(
            calls.map((call) => call.op),
            ["mcp.remove"],
          );
        } else {
          yield* runtime.ensureThread(input);
          assert.deepStrictEqual(
            calls.map((call) => call.op),
            ["mcp.remove", "mcp.add", "session.create"],
          );
        }
      }).pipe(Effect.provide(makeLayers(calls, events)));
    }),
);

it.effect(
  "registers the thread's T3 MCP server when the session opens, before any OpenCode session exists",
  () => {
    const calls: Array<RecordedCall> = [];
    return Effect.gen(function* () {
      const threadId = ThreadId.make("thread-490f020d");
      const adapter = yield* make(ProviderInstanceId.make("opencode-test"));
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set(mcpConfig(threadId));

      const runtime = yield* openFor(adapter, threadId);
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode-test"),
          model: "anthropic/claude-sonnet",
          options: [],
        },
        runtimePolicy: runtimePolicy(),
      });

      const adds = calls.filter((call) => call.op === "mcp.add");
      assert.strictEqual(adds.length, 1);
      assert.strictEqual(adds[0]!.args.server, `t3-code-${threadId}`);
      assert.deepStrictEqual(
        calls.map((call) => call.op),
        ["mcp.add", "session.create"],
      );
      const created = calls.find((call) => call.op === "session.create")!;
      assert.deepStrictEqual((created.args.permissions as ReadonlyArray<unknown>).slice(-2), [
        ...mcpRules(`t3-code-${threadId}`),
      ]);
      yield* runtime.unloadThread!({ providerThread });
      assert.strictEqual(calls.at(-1)?.op, "mcp.remove");
    }).pipe(Effect.provide(makeLayers(calls)));
  },
);

it.effect(
  "registers the server in the thread's runtime directory, not the server launch directory",
  () => {
    const calls: Array<RecordedCall> = [];
    return Effect.gen(function* () {
      const threadId = ThreadId.make("thread-490f020d");
      const adapter = yield* make(ProviderInstanceId.make("opencode-test"));
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set(mcpConfig(threadId));

      // OpenCode MCP registrations are directory-scoped, and the native
      // session is created in the runtime policy's cwd — a server registered
      // anywhere else never enters that session's tool catalog.
      yield* openFor(adapter, threadId, "/projects/app-worktree");

      const adds = calls.filter((call) => call.op === "mcp.add");
      assert.strictEqual(adds.length, 1);
      assert.deepStrictEqual(adds[0]!.args.location, { directory: "/projects/app-worktree" });
    }).pipe(Effect.provide(makeLayers(calls)));
  },
);

it.effect(
  "registers a fork in the source directory, then moves its registration with the session",
  () => {
    const calls: Array<RecordedCall> = [];
    return Effect.gen(function* () {
      const sourceId = ThreadId.make("thread-source");
      const targetId = ThreadId.make("thread-target");
      const adapter = yield* make(ProviderInstanceId.make("opencode-test"));
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set(mcpConfig(targetId));
      const runtime = yield* openFor(adapter, targetId, "/target");
      const source = yield* runtime.ensureThread({
        threadId: sourceId,
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode-test"),
          model: "anthropic/claude-sonnet",
          options: [],
        },
        runtimePolicy: runtimePolicy(),
      });
      calls.length = 0;
      const fork = yield* runtime.forkThread({
        sourceProviderThread: source,
        targetThreadId: targetId,
        runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: "/target",
        }),
      });
      assert.deepStrictEqual(
        calls
          .filter(
            (call) =>
              call.op.startsWith("mcp.") ||
              call.op === "session.fork" ||
              call.op === "session.move",
          )
          .map((call) => [call.op, call.args.location ?? call.args.directory]),
        [
          ["mcp.remove", { directory: "/target" }],
          ["mcp.add", { directory: "/workspace" }],
          ["session.fork", undefined],
          ["mcp.remove", { directory: "/workspace" }],
          ["mcp.add", { directory: "/target" }],
          ["session.move", "/target"],
        ],
      );
      yield* runtime.unloadThread!({ providerThread: fork });
      assert.deepStrictEqual(calls.at(-1)?.args.location, { directory: "/target" });
    }).pipe(Effect.provide(makeLayers(calls)));
  },
);

it.effect(
  "two concurrent threads register distinct servers and keep only their own routing rules",
  () => {
    const calls: Array<RecordedCall> = [];
    return Effect.gen(function* () {
      const threadA = ThreadId.make("thread-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
      const threadB = ThreadId.make("thread-bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb");
      const adapter = yield* make(ProviderInstanceId.make("opencode-test"));
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.set(mcpConfig(threadA));
      yield* mcpSessions.set(mcpConfig(threadB));

      yield* openFor(adapter, threadA);
      yield* openFor(adapter, threadB);

      const names = calls
        .filter((call) => call.op === "mcp.add")
        .map((call) => call.args.server as string);
      const nameA = `t3-code-${threadA}`;
      const nameB = `t3-code-${threadB}`;
      assert.deepStrictEqual([...names].sort(), [nameA, nameB].sort());
      assert.notStrictEqual(nameA, nameB);

      // Each thread's rules deny every T3 server and re-allow only its own,
      // so one thread's agent can never route into another thread's tools.
      for (const [own, other] of [
        [nameA, nameB],
        [nameB, nameA],
      ] as const) {
        const rules = mcpRules(own);
        assert.deepStrictEqual(rules, [
          { action: "t3-code-*", resource: "*", effect: "deny" },
          { action: `${own}_*`, resource: "*", effect: "allow" },
        ]);
        const otherPrefix = other.slice(0, other.lastIndexOf("-") + 1);
        assert.isFalse(
          rules.some((entry) => entry.effect === "allow" && otherPrefix.startsWith(entry.action)),
        );
      }
    }).pipe(Effect.provide(makeLayers(calls)));
  },
);

it.layer(NodeServices.layer)("OpenCode2Adapter MCP server names", (it) => {
  it.effect("replaces a thread id that exceeds OpenCode's namespace limit with a digest", () =>
    Effect.gen(function* () {
      const longA = `thread-${"a".repeat(80)}`;
      const longB = `thread-${"b".repeat(80)}`;
      const nameA = yield* t3McpServerName(longA);
      const nameB = yield* t3McpServerName(longB);
      assert.isTrue(nameA.length <= 64);
      assert.isTrue(nameB.length <= 64);
      assert.isTrue(nameA.startsWith("t3-code-"));
      assert.notStrictEqual(nameA, nameB);
      // A short id keeps its readable, sanitized form.
      const short = yield* t3McpServerName("thread_490f020d");
      assert.strictEqual(short, "t3-code-thread_490f020d");
    }),
  );
});

describe("T3 orchestration instructions", () => {
  it("names the session's registered namespace when the server is thread-suffixed", () => {
    const prompt = orchestrationInstructions.t3OrchestrationSystemPrompt(
      true,
      false,
      "t3-code-490f020d",
    );
    assert.isString(prompt);
    assert.include(prompt!, 'tools["t3-code-490f020d"].');
    assert.include(prompt!, 'search({ query: "orchestrator_capabilities" })');
  });

  it("keeps the shared instructions unchanged when the server has its plain name", () => {
    const base = orchestrationInstructions.t3OrchestrationSystemPrompt(true, false);
    assert.strictEqual(base, orchestrationInstructions.T3_CODE_ORCHESTRATION_INSTRUCTIONS);
    assert.strictEqual(
      orchestrationInstructions.t3OrchestrationSystemPrompt(true, false, "t3-code"),
      base,
    );
    assert.strictEqual(
      orchestrationInstructions.t3OrchestrationSystemPrompt(false, false),
      undefined,
    );
  });

  it("preserves device guidance when adding the session namespace", () => {
    assert.include(
      orchestrationInstructions.t3OrchestrationSystemPrompt(true, true, "t3-code-thread")!,
      orchestrationInstructions.T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
    );
  });
});
