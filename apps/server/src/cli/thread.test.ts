import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  readLatestMessages,
  threadCommand,
  type ThreadTools,
  titleFromMessage,
  waitForRun,
} from "./thread.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: () =>
        Effect.map(DateTime.now, (expiresAt) => ({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          expiresAt,
        })),
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

it.effect(
  "start resolves home-relative project paths while preserving ids and relative paths",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-thread-project-path-" })
        .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const home = path.join(root, "home");
      const cwd = path.join(root, "current");
      const workspaceRoot = path.join(home, "My Project");
      const nestedRoot = path.join(workspaceRoot, "nested");
      const baseDir = path.join(root, "state");
      yield* fs.makeDirectory(nestedRoot, { recursive: true });
      yield* fs.makeDirectory(cwd);
      const projects = [
        { id: ProjectId.make("current-project"), title: "Current", workspaceRoot: cwd },
        { id: ProjectId.make("home-project"), title: "Home", workspaceRoot: home },
        { id: ProjectId.make("intended-project"), title: "Intended", workspaceRoot },
        { id: ProjectId.make("nested-project"), title: "Nested", workspaceRoot: nestedRoot },
        { id: ProjectId.make("~/literal-id"), title: "Exact id", workspaceRoot: cwd },
      ];
      yield* persistServerRuntimeState({
        path: path.join(baseDir, "userdata", "server-runtime.json"),
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 3_773,
        }),
      });
      using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
        Effect.succeed({
          call: (tool, args) => {
            switch (tool) {
              case "t3_project_list":
                return Effect.succeed({ structuredContent: { projects, nextCursor: null } });
              case "t3_thread_launch":
                return Effect.succeed({
                  structuredContent: { threadId, projectId: args.projectId, runId: null },
                });
              default:
                return Effect.die(`unexpected ${tool} call`);
            }
          },
        }),
      );

      for (const [identifier, expectedProjectId] of [
        ["intended-project", "intended-project"],
        ["~/literal-id", "~/literal-id"],
        [workspaceRoot, "intended-project"],
        [path.relative(cwd, workspaceRoot), "intended-project"],
        [".", "current-project"],
        ["~/My Project", "intended-project"],
        ["~", "home-project"],
        ["~/My Project/nested", "nested-project"],
        ["~/My Project/missing", "intended-project"],
      ] as const) {
        yield* Command.runWith(threadCommand, { version: "0.0.0" })([
          "start",
          identifier,
          "Inspect this project",
          "--json",
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.WorkingDirectory, cwd),
        );
        assert.strictEqual(
          (yield* TestConsole.logLines).at(-1),
          JSON.stringify({ threadId, projectId: expectedProjectId, runId: null }),
          identifier,
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          NetService.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
        ),
      ),
    ),
);

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

/** Serves t3_thread_read pages the way the server does: positions count every item. */
const timelineTools = (types: ReadonlyArray<string>) => {
  const items = types.map((type, position) => ({ position, itemId: `item-${position}`, type }));
  const served: Array<number> = [];
  const call = ((_tool: string, input: unknown) => {
    const args = input as { readonly afterPosition?: number; readonly limit: number };
    // Scanning one match past the page keeps reads of huge fixtures linear.
    const matching: typeof items = [];
    for (let position = (args.afterPosition ?? -1) + 1; position < items.length; position++) {
      const item = items[position]!;
      if (["user_message", "assistant_message", "proposed_plan"].includes(item.type)) {
        matching.push(item);
        if (matching.length > args.limit) break;
      }
    }
    const page = matching.slice(0, args.limit);
    served.push(page.length);
    return Effect.succeed({
      thread: { itemCount: items.length },
      items: page,
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: matching.length > page.length,
    });
  }) as ThreadTools["call"];
  const latest = (count: number) =>
    items
      .filter((item) => item.type === "user_message" || item.type === "assistant_message")
      .slice(-count)
      .map((item) => item.itemId);
  return { tools: { call } satisfies ThreadTools, served, latest };
};

const tail = (tools: number) => [...Array<string>(tools).fill("tool_call"), "assistant_message"];

it.effect("show reads the end of a long thread, not its whole history", () =>
  Effect.gen(function* () {
    const { tools, served, latest } = timelineTools([
      ...Array.from({ length: 1000 }, (_, index) =>
        index % 2 === 0 ? "user_message" : "assistant_message",
      ),
      ...Array.from({ length: 10 }, () => tail(30)).flat(),
      "proposed_plan",
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.isBelow(
      served.reduce((sum, count) => sum + count, 0),
      100,
    );
  }),
);

it.effect("show widens back to the first item when the thread has fewer messages", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools([
      "user_message",
      ...Array.from({ length: 4 }, () => tail(150)).flat(),
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.lengthOf(messages, 5);
  }),
);

it.effect("show returns a --messages count larger than one call can spread", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools(Array<string>(200_000).fill("assistant_message"));

    const { messages } = yield* readLatestMessages(tools, threadId, 200_000);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(200_000),
    );
  }),
);

it("titles from a long first line without splitting an emoji", () => {
  const title = titleFromMessage(`${"a".repeat(78)}😀 and the rest of a long first line`);
  assert.strictEqual(title, `${"a".repeat(78)}…`);
});

const session = {
  calls: [] as Array<{ tool: string; args: unknown }>,
  responses: {} as Record<string, unknown>,
};

/** Runs the thread CLI against scripted MCP responses and returns what it logged. */
const runThreadCli = Effect.fn(function* (args: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-cli-" });
  yield* persistServerRuntimeState({
    path: path.join(baseDir, "userdata", "server-runtime.json"),
    state: yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3_773,
    }),
  });
  using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
    Effect.succeed({
      call: (tool, toolArgs) => {
        session.calls.push({ tool, args: toolArgs });
        return Effect.succeed({ structuredContent: session.responses[tool] });
      },
    }),
  );
  const output: Array<string> = [];
  yield* Command.runWith(threadCommand, { version: "test" })([...args, "--base-dir", baseDir]).pipe(
    Effect.provideService(Console.Console, {
      ...console,
      log: (value) => output.push(String(value)),
    }),
  );
  return output;
}, Effect.scoped);

const cliLayer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  NetService.layer,
  ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
);

it.effect("send forwards non-restarting modes and preserves queue state in JSON and text", () =>
  Effect.gen(function* () {
    for (const mode of [undefined, "queue", "auto", "steer"]) {
      for (const queueHeld of [true, false, undefined]) {
        session.calls = [];
        const sent = {
          threadId,
          messageId: "message-1",
          runId,
          status: "queued",
          delivery: "queued",
          ...(queueHeld === undefined ? {} : { queueHeld }),
        };
        session.responses = { t3_thread_send: sent };
        const args = ["send", threadId, "hello", ...(mode === undefined ? [] : ["--mode", mode])];
        const json = yield* runThreadCli([...args, "--json"]);
        assert.deepStrictEqual(session.calls, [
          { tool: "t3_thread_send", args: { threadId, message: "hello", mode: mode ?? "queue" } },
        ]);
        assert.deepStrictEqual(JSON.parse(json[0]!), sent);
        const text = yield* runThreadCli(args);
        assert.strictEqual(
          text[0],
          queueHeld === true
            ? "Queued (held; not eligible for dispatch)."
            : queueHeld === false
              ? "Queued (not held)."
              : "Queued (hold state unknown).",
        );
      }
    }
    session.calls = [];
    yield* runThreadCli(["send", threadId, "hello", "--mode", "restart"]).pipe(Effect.flip);
    assert.deepStrictEqual(session.calls, []);
  }).pipe(Effect.provide(cliLayer)),
);

it.effect(
  "show includes recent held and unheld runs without confusing questions with queue length",
  () =>
    Effect.gen(function* () {
      session.calls = [];
      const thread = {
        threadId,
        projectId: "project-1",
        title: "Queue",
        createdBy: "user",
        creationSource: "web",
        status: "completed",
        latestRunId: runId,
        activeRunId: null,
        providerInstanceId: "codex",
        model: "gpt-6.1-sol",
        runtimeMode: "full-access",
        interactionMode: "default",
        linkedPullRequest: null,
        titleRegeneration: null,
        branch: null,
        worktreePath: null,
        parentThreadId: null,
        relationshipToParent: null,
        runCount: 3,
        itemCount: 0,
        pendingRequestCount: 0,
        archived: false,
        settled: false,
        settledAt: null,
        snoozed: false,
        snoozedUntil: null,
        createdAt: "2026-11-02T00:00:00Z",
        updatedAt: "2026-11-02T00:00:00Z",
      };
      const recentRuns = [true, false, undefined].map((queueHeld, i) => ({
        runId: `run-${i}`,
        ordinal: i + 1,
        status: "queued",
        providerInstanceId: "codex",
        model: "gpt-6.1-sol",
        requestedAt: "2026-11-02T00:00:00Z",
        startedAt: null,
        completedAt: null,
        ...(queueHeld === undefined ? {} : { queueHeld }),
      }));
      session.responses = {
        t3_thread_read: { thread, recentRuns, items: [], nextPosition: null, hasMore: false },
      };
      const json = yield* runThreadCli(["show", threadId, "--json"]);
      assert.deepStrictEqual(JSON.parse(json[0]!), { thread, recentRuns, messages: [] });
      assert.deepStrictEqual(session.calls[0]?.args, {
        threadId,
        limit: 1,
        runLimit: 50,
      });
      const text = yield* runThreadCli(["show", threadId]);
      assert.deepStrictEqual(text.slice(2), [
        "Run 1 run-0: queued (held; not eligible for dispatch).",
        "Run 2 run-1: queued (not held).",
        "Run 3 run-2: queued (hold state unknown).",
      ]);
    }).pipe(Effect.provide(cliLayer)),
);
