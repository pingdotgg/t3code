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

import { ProviderEventLoggers } from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as HostProcess from "@t3tools/shared/HostProcess";
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

// The SDK only looks up session ids shaped like the UUIDs the CLI allocates.
const PERSISTED = "11111111-1111-4111-8111-111111111111";
const DEAD = "22222222-2222-4222-8222-222222222222";
const MISSING = "33333333-3333-4333-8333-333333333333";

it.effect("reads an instance's own Claude home through a session store", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
    const transcript = (sessionId: string, lines: ReadonlyArray<object>) =>
      Effect.gen(function* () {
        const project = path.join(home, "projects", `-project-${sessionId}`);
        yield* fileSystem.makeDirectory(project, { recursive: true });
        yield* fileSystem.writeFileString(
          path.join(project, `${sessionId}.jsonl`),
          lines.map((line) => JSON.stringify(line)).join("\n"),
        );
      });
    // A CLI stopped after `system/init` leaves only its title row; one stopped
    // after the first stream event has persisted the prompt.
    yield* transcript(DEAD, [{ type: "ai-title", aiTitle: "Title", sessionId: DEAD }]);
    yield* transcript(PERSISTED, [
      { type: "ai-title", aiTitle: "Title", sessionId: PERSISTED },
      {
        parentUuid: null,
        isSidechain: false,
        type: "user",
        message: { role: "user", content: "hello" },
        uuid: "c773e36a-1f9d-4427-92c8-f69d4da17b40",
        timestamp: "2026-10-11T05:22:37.940Z",
        sessionId: PERSISTED,
      },
    ]);
    // The server's own home is never read here; the SDK's default lookup
    // answers for it.
    const getSessionMessages = vi.spyOn(ClaudeSdk, "getSessionMessages");
    getSessionMessages.mockImplementation(async (sessionId, options) =>
      options?.sessionStore === undefined
        ? []
        : (
            await vi.importActual<typeof ClaudeSdk>("@anthropic-ai/claude-agent-sdk")
          ).getSessionMessages(sessionId, options),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => getSessionMessages.mockRestore()));
    const lookup = (configDir: string, sessionId: string) =>
      Effect.gen(function* () {
        const runner = yield* ClaudeAgentSdkQueryRunner;
        return yield* runner.sessionHasMessages({
          sessionId,
          configDir,
          threadId: ThreadId.make("thread-lookup"),
          providerSessionId: ProviderSessionId.make("session-lookup"),
        });
      });
    yield* Effect.gen(function* () {
      assert.isTrue(yield* lookup(home, PERSISTED));
      assert.isFalse(yield* lookup(home, DEAD));
      assert.isFalse(yield* lookup(home, MISSING));
      assert.isFalse(yield* lookup("/server-home", PERSISTED));
      assert.deepEqual(getSessionMessages.mock.lastCall, [PERSISTED, { limit: 1 }]);
    }).pipe(
      Effect.provide(
        layerQueryRunner.pipe(
          Layer.provide(
            Layer.succeed(ProviderEventLoggers, { native: undefined, canonical: undefined }),
          ),
          Layer.provide(
            Layer.succeed(HostProcess.Environment, { CLAUDE_CONFIG_DIR: "/server-home" }),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
