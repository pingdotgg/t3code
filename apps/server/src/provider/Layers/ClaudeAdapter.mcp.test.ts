// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { query, type Options as ClaudeQueryOptions } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeSettings, EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SYNTHETIC_CLAUDE_MODEL_CATALOG } from "../ClaudeModelCatalog.testFixtures.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";

const decodeSettings = Schema.decodeUnknownSync(ClaudeSettings);
const decodeReceipt = Schema.decodeUnknownSync(
  Schema.Union([
    Schema.Struct({
      type: Schema.Literal("spawn"),
      args: Schema.Array(Schema.String),
      authorization: Schema.NullOr(Schema.String),
    }),
    Schema.Struct({ type: Schema.Literal("state"), prompts: Schema.Number }),
  ]),
);
const decodeMcpConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      mcpServers: Schema.Struct({
        "t3-code": Schema.Struct({
          type: Schema.Literal("http"),
          url: Schema.String,
          headers: Schema.Struct({ Authorization: Schema.String }),
        }),
      }),
    }),
  ),
);
type SpawnReceipt = Extract<ReturnType<typeof decodeReceipt>, { type: "spawn" }>;

const FIRST_HEADER = "Bearer AUDIT_MCP_FIRST_NOT_A_CREDENTIAL";
const SECOND_HEADER = "Bearer AUDIT_MCP_SECOND_NOT_A_CREDENTIAL";
const ENDPOINT = "http://127.0.0.1:1/mcp";
const fixturePath = NodeURL.fileURLToPath(
  new URL("../testFixtures/claudeMcpArgv.mjs", import.meta.url),
);
const instanceId = ProviderInstanceId.make("claudeAgent");

const makeHarness = Effect.fn("makeClaudeMcpSdkHarness")(function* (launchArgs = "") {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-claude-mcp-sdk-" });
  const environment = Object.freeze({
    AUDIT_PARENT_VALUE: "unchanged",
    T3_MCP_AUTHORIZATION: "inherited-value",
  });
  const registeredThreads: ThreadId[] = [];
  const captures: Array<{
    runtime: ReturnType<typeof query>;
    options: ClaudeQueryOptions;
    child: NodeChildProcess.ChildProcess;
    spawned: Promise<SpawnReceipt>;
    state: Promise<number>;
    exited: Promise<void>;
  }> = [];
  yield* Effect.addFinalizer(() =>
    Effect.promise(async () => {
      for (const threadId of registeredThreads)
        McpProviderSession.clearMcpProviderSession(threadId);
      await Promise.all(
        captures.map(async ({ runtime, exited }) => {
          runtime.close();
          await exited;
        }),
      );
    }),
  );
  const adapter = yield* makeClaudeAdapter(
    decodeSettings({
      binaryPath: "inert-claude-never-executed",
      launchArgs,
    }),
    {
      instanceId,
      environment,
      modelCatalog: Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
      createQuery: ({ prompt, options }) => {
        const spawned = Promise.withResolvers<SpawnReceipt>();
        const state = Promise.withResolvers<number>();
        const exited = Promise.withResolvers<void>();
        let child: NodeChildProcess.ChildProcess | undefined;
        const runtime = query({
          prompt,
          options: {
            ...options,
            settingSources: [],
            settings: { disableAllHooks: true },
            persistSession: false,
            tools: [],
            spawnClaudeCodeProcess: (invocation) => {
              // Preserve the real SDK's arguments and environment; only replace the executable.
              const spawnedChild = NodeChildProcess.spawn(
                process.execPath,
                [fixturePath, ...invocation.args],
                { cwd: directory, env: invocation.env, stdio: ["pipe", "pipe", "pipe", "ipc"] },
              ) as NodeChildProcess.ChildProcessWithoutNullStreams;
              child = spawnedChild;
              spawnedChild.stderr.resume();
              spawnedChild.once("exit", () => exited.resolve());
              spawnedChild.once("error", (error) => {
                spawned.reject(error);
                exited.resolve();
              });
              spawnedChild.on("message", (message) => {
                const receipt = decodeReceipt(message);
                if (receipt.type === "spawn") spawned.resolve(receipt);
                else state.resolve(receipt.prompts);
              });
              return spawnedChild;
            },
          },
        });
        assert.isDefined(child);
        captures.push({
          runtime,
          options,
          child,
          spawned: spawned.promise,
          state: state.promise,
          exited: exited.promise,
        });
        return runtime;
      },
    },
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        ServerConfig.layerTest(directory, directory),
        ServerSettingsService.layerTest(),
      ),
    ),
  );

  const register = (threadId: ThreadId, authorizationHeader: string) => {
    registeredThreads.push(threadId);
    McpProviderSession.setMcpProviderSession({
      threadId,
      providerInstanceId: instanceId,
      environmentId: EnvironmentId.make("00000000-0000-4000-8000-000000010020"),
      providerSessionId: "00000000-0000-4000-8000-000000010020",
      endpoint: ENDPOINT,
      authorizationHeader,
    });
  };
  const start = Effect.fn("startClaudeMcpSdkSession")(function* (threadId: ThreadId) {
    yield* adapter.startSession({
      threadId,
      providerInstanceId: instanceId,
      runtimeMode: "approval-required",
      cwd: directory,
    });
    const capture = captures.at(-1)!;
    const receipt = yield* Effect.promise(() => capture.spawned);
    yield* Effect.promise(() => capture.runtime.initializationResult());
    capture.child.send!("inspect");
    assert.equal(yield* Effect.promise(() => capture.state), 0);
    return { ...capture, receipt };
  });
  return { adapter, environment, captures, register, start };
});

function mcpArguments(args: readonly string[]) {
  return args.flatMap((arg, index) => (arg === "--mcp-config" ? [args[index + 1]!] : []));
}

describe("Claude built-in MCP credentials through the actual SDK", () => {
  it.effect.each(["", "--mcp-config /workspace/example/user-mcp.json"])(
    "keeps the bearer out of child argv with launch arguments %j",
    (launchArgs) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness(launchArgs);
        const threadId = ThreadId.make("claude-mcp-argv");
        harness.register(threadId, FIRST_HEADER);
        const { receipt } = yield* harness.start(threadId);
        assert.notInclude(receipt.args.join("\0"), FIRST_HEADER);
        assert.equal(receipt.authorization, FIRST_HEADER);
        const configs = mcpArguments(receipt.args);
        assert.equal(configs.length, launchArgs === "" ? 1 : 2);
        const inline = configs.find((value) => value.startsWith("{"));
        assert.isDefined(inline);
        assert.deepStrictEqual(decodeMcpConfig(inline), {
          mcpServers: {
            "t3-code": {
              type: "http",
              url: ENDPOINT,
              headers: { Authorization: "${T3_MCP_AUTHORIZATION}" },
            },
          },
        });
        if (launchArgs !== "") assert.include(configs, "/workspace/example/user-mcp.json");
        assert.deepStrictEqual(harness.environment, {
          AUDIT_PARENT_VALUE: "unchanged",
          T3_MCP_AUTHORIZATION: "inherited-value",
        });
        yield* harness.adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect.each(["none", "another-thread"] as const)(
    "leaves the environment unchanged when MCP belongs to %s",
    (mcp) =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const threadId = ThreadId.make(`claude-mcp-${mcp}`);
        if (mcp === "another-thread")
          harness.register(ThreadId.make(`${threadId}-other`), FIRST_HEADER);
        const { receipt, options } = yield* harness.start(threadId);
        assert.deepStrictEqual(mcpArguments(receipt.args), []);
        assert.strictEqual(options.env, harness.environment);
        assert.equal(receipt.authorization, "inherited-value");
        assert.notInclude(receipt.args.join("\0"), FIRST_HEADER);
        yield* harness.adapter.stopSession(threadId);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "keeps simultaneous thread credentials separate without mutating the parent environment",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const firstId = ThreadId.make("claude-mcp-first");
        const secondId = ThreadId.make("claude-mcp-second");
        harness.register(firstId, FIRST_HEADER);
        harness.register(secondId, SECOND_HEADER);
        const first = yield* harness.start(firstId);
        const second = yield* harness.start(secondId);
        assert.notStrictEqual(first.options.env, harness.environment);
        assert.notStrictEqual(first.options.env, second.options.env);
        assert.equal(first.options.env?.T3_MCP_AUTHORIZATION, FIRST_HEADER);
        assert.equal(second.options.env?.T3_MCP_AUTHORIZATION, SECOND_HEADER);
        assert.equal(first.receipt.authorization, FIRST_HEADER);
        assert.equal(second.receipt.authorization, SECOND_HEADER);
        for (const { receipt } of [first, second]) {
          assert.notInclude(receipt.args.join("\0"), FIRST_HEADER);
          assert.notInclude(receipt.args.join("\0"), SECOND_HEADER);
        }
        assert.deepStrictEqual(harness.environment, {
          AUDIT_PARENT_VALUE: "unchanged",
          T3_MCP_AUTHORIZATION: "inherited-value",
        });
        yield* harness.adapter.stopSession(firstId);
        yield* harness.adapter.stopSession(secondId);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
