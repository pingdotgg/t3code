import * as ClaudeSdk from "@anthropic-ai/claude-agent-sdk";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { vi } from "vite-plus/test";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
  ClaudeAgentSdkQueryRunner,
  layerQueryRunner,
} from "./ClaudeAdapterV2.ts";

vi.mock("@anthropic-ai/claude-agent-sdk", { spy: true });

it.effect("logs successful task stops for replay and omits failed stops", () =>
  Effect.gen(function* () {
    const writes: unknown[] = [];
    const stopTask = vi.fn(async (_taskId: string) => {});
    const query = vi.spyOn(ClaudeSdk, "query").mockReturnValue({
      stopTask,
    } as unknown as ClaudeSdk.Query);
    yield* Effect.addFinalizer(() => Effect.sync(() => query.mockRestore()));
    const threadId = ThreadId.make("thread-stop");
    const providerSessionId = ProviderSessionId.make("session-stop");
    yield* Effect.gen(function* () {
      const runner = yield* ClaudeAgentSdkQueryRunner;
      const session = yield* runner.open({
        threadId,
        providerSessionId,
        options: {
          sessionId: "native-session-stop",
          model: "claude-sonnet-4-6",
          tools: [],
          permissionMode: "default",
        },
      });
      writes.length = 0;
      yield* session.stopTask("workflow-task");
      assert.deepEqual(stopTask.mock.calls, [["workflow-task"]]);
      assert.deepEqual(writes, [
        {
          provider: "claudeAgent",
          protocol: CLAUDE_AGENT_SDK_QUERY_PROTOCOL,
          kind: "protocol",
          providerSessionId,
          event: {
            direction: "outgoing",
            stage: "decoded",
            payload: { type: "query.stop_task", taskId: "workflow-task" },
          },
        },
      ]);
      stopTask.mockRejectedValueOnce(new Error("Stop failed"));
      assert.isTrue(Exit.isFailure(yield* Effect.exit(session.stopTask("failed-task"))));
      assert.equal(writes.length, 1);
    }).pipe(
      Effect.provide(
        layerQueryRunner.pipe(
          Layer.provide(
            Layer.succeed(ProviderEventLoggers, {
              native: {
                filePath: "/tmp/events.log",
                write: (event) =>
                  Effect.sync(() => {
                    writes.push(event);
                  }),
                close: () => Effect.void,
              },
              canonical: undefined,
            }),
          ),
        ),
      ),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

const FORK_SESSION_ID = "11111111-1111-4111-8111-111111111111";

const writeClaudeSession = Effect.fnUntraced(function* (configDir: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projectDir = path.join(configDir, "projects", "-repo");
  const entry = (uuid: string, parentUuid: string | null, message: unknown) => ({
    type: parentUuid === null ? "user" : "assistant",
    uuid,
    parentUuid,
    sessionId: FORK_SESSION_ID,
    cwd: "/repo",
    isSidechain: false,
    timestamp: "2026-10-01T00:00:00.000Z",
    message,
  });
  yield* fileSystem.makeDirectory(projectDir, { recursive: true });
  yield* fileSystem.writeFileString(
    path.join(projectDir, `${FORK_SESSION_ID}.jsonl`),
    [
      entry("aaaaaaaa-0000-4000-8000-000000000001", null, { role: "user", content: "hello" }),
      entry("aaaaaaaa-0000-4000-8000-000000000002", "aaaaaaaa-0000-4000-8000-000000000001", {
        role: "assistant",
        content: [{ type: "text", text: "hi" }],
      }),
    ]
      .map((line) => JSON.stringify(line))
      .join("\n"),
  );
  return projectDir;
});

const forkRunnerLayer = layerQueryRunner.pipe(
  Layer.provide(Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined })),
);

it.effect("forks a session stored under the instance's own CLAUDE_CONFIG_DIR", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const configDir = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "t3-claude-fork-config-",
      });
      const projectDir = yield* writeClaudeSession(configDir);
      const inProcessFork = vi.spyOn(ClaudeSdk, "forkSession");
      yield* Effect.addFinalizer(() => Effect.sync(() => inProcessFork.mockRestore()));

      const runner = yield* ClaudeAgentSdkQueryRunner;
      const forked = yield* runner.forkSession({
        sessionId: FORK_SESSION_ID,
        options: {},
        environment: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        threadId: ThreadId.make("thread-fork-config-dir"),
        providerSessionId: ProviderSessionId.make("session-fork-config-dir"),
      });

      assert.notEqual(forked.sessionId, FORK_SESSION_ID);
      assert.isTrue(yield* fileSystem.exists(path.join(projectDir, `${forked.sessionId}.jsonl`)));
      // The server's own environment is untouched and the SDK was not called here.
      assert.notEqual(process.env.CLAUDE_CONFIG_DIR, configDir);
      assert.equal(inProcessFork.mock.calls.length, 0);
    }).pipe(Effect.provide(forkRunnerLayer)),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("forks in-process when the instance shares the server's config dir", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const inProcessFork = vi
        .spyOn(ClaudeSdk, "forkSession")
        .mockResolvedValue({ sessionId: "forked-in-process" });
      yield* Effect.addFinalizer(() => Effect.sync(() => inProcessFork.mockRestore()));
      const path = yield* Path.Path;
      const homeDirectory = yield* HostProcess.HomeDirectory;
      const hostConfigDir =
        process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homeDirectory, ".claude");

      const runner = yield* ClaudeAgentSdkQueryRunner;
      const forked = yield* runner.forkSession({
        sessionId: FORK_SESSION_ID,
        options: { dir: "/repo" },
        environment: { ...process.env, CLAUDE_CONFIG_DIR: hostConfigDir },
        threadId: ThreadId.make("thread-fork-shared-config-dir"),
        providerSessionId: ProviderSessionId.make("session-fork-shared-config-dir"),
      });

      assert.equal(forked.sessionId, "forked-in-process");
      assert.deepEqual(inProcessFork.mock.calls, [[FORK_SESSION_ID, { dir: "/repo" }]]);
    }).pipe(Effect.provide(forkRunnerLayer)),
  ).pipe(Effect.provide(NodeServices.layer)),
);
