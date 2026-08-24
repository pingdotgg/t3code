import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../../config.ts";
import * as IdAllocator from "../IdAllocator.ts";
import { makeAntigravityAdapterV2 } from "./AntigravityAdapterV2.ts";

const TestLayer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-antigravity-v2-test-" }).pipe(
    Layer.provide(NodeServices.layer),
  ),
);

it.layer(TestLayer)("AntigravityAdapterV2", (it) => {
  it.effect("projects a streamed turn and persists its conversation head", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-antigravity-adapter-",
        });
        const binary = path.join(directory, "agy");
        const line = (json: string) => `printf '%s\\n' '${json}'`;
        yield* fileSystem.writeFileString(
          binary,
          [
            "#!/bin/sh",
            line('{"event":"init","conversation_id":"conv-1"}'),
            line(
              '{"event":"step_update","step_update":{"step_index":1,"state":"ACTIVE","step_type":"agent_response","text_delta":"Hello "}}',
            ),
            line(
              '{"event":"step_update","step_update":{"step_index":1,"state":"DONE","step_type":"agent_response","text_delta":"world"}}',
            ),
            line(
              `{"event":"step_update","step_update":{"step_index":2,"state":"DONE","step_type":"tool","tool_name":"run_command","tool_info":{"parameters":{"CommandLine":"pwd"},"output":"${directory}"}}}`,
            ),
            line(
              '{"event":"result","result":{"conversation_id":"conv-1","status":"SUCCESS","response":"Hello world"}}',
            ),
            "",
          ].join("\n"),
        );
        yield* fileSystem.chmod(binary, 0o755);

        const idAllocator = yield* IdAllocator.IdAllocatorV2;
        const config = yield* ServerConfig.ServerConfig;
        const adapter = makeAntigravityAdapterV2({
          instanceId: ProviderInstanceId.make("antigravity"),
          settings: { enabled: true, binaryPath: binary, customModels: [], launchArgs: "" },
          environment: process.env,
          spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          idAllocator,
          path,
          serverConfig: config,
        });
        const threadId = ThreadId.make("thread-antigravity-v2");
        const modelSelection = {
          instanceId: ProviderInstanceId.make("antigravity"),
          model: "gemini-3.6-flash",
          options: [{ id: "effort", value: "medium" }],
        } as const;
        const runtimePolicy = {
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          cwd: directory,
        };
        const runtime = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("session-antigravity-v2"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        const eventsFiber = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
          Effect.forkScoped,
        );
        const now = yield* DateTime.now;
        const runId = RunId.make("run-antigravity-v2");
        yield* runtime.startTurn({
          appThread: {
            createdBy: "user",
            creationSource: "web",
            id: threadId,
            projectId: ProjectId.make("project-antigravity-v2"),
            title: "Antigravity test",
            providerInstanceId: ProviderInstanceId.make("antigravity"),
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: directory,
            activeProviderThreadId: providerThread.id,
            lineage: {
              parentThreadId: null,
              relationshipToParent: null,
              rootThreadId: threadId,
            },
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
            archivedAt: null,
            settledOverride: null,
            settledAt: null,
            lastVisitedAt: null,
            deletedAt: null,
          },
          threadId,
          runId,
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-antigravity-v2"),
          rootNodeId: NodeId.make("node-antigravity-v2"),
          providerThread,
          message: {
            messageId: MessageId.make("message-antigravity-v2"),
            text: "Say hello",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection,
          runtimePolicy,
        });
        const events = Array.from(yield* Fiber.join(eventsFiber));
        const completedMessage = events.find(
          (event) =>
            event.type === "message.updated" &&
            event.message.role === "assistant" &&
            !event.message.streaming,
        );
        const completedTool = events.find(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.status === "completed",
        );
        const updatedThread = events.findLast((event) => event.type === "provider_thread.updated");
        const terminal = events.at(-1);

        assert.strictEqual(
          completedMessage?.type === "message.updated" ? completedMessage.message.text : null,
          "Hello world",
        );
        assert.strictEqual(
          completedTool?.type === "turn_item.updated" &&
            completedTool.turnItem.type === "dynamic_tool"
            ? completedTool.turnItem.output
            : null,
          directory,
        );
        assert.strictEqual(
          updatedThread?.type === "provider_thread.updated"
            ? updatedThread.providerThread.nativeConversationHeadRef?.nativeId
            : null,
          "conv-1",
        );
        assert.strictEqual(terminal?.type, "turn.terminal");
        assert.strictEqual(
          terminal?.type === "turn.terminal" ? terminal.status : null,
          "completed",
        );
      }),
    ),
  );

  it.effect("rejects modes that require interactive approvals", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = makeAntigravityAdapterV2({
          instanceId: ProviderInstanceId.make("antigravity"),
          settings: { enabled: true, binaryPath: "agy", customModels: [], launchArgs: "" },
          environment: process.env,
          spawner: yield* ChildProcessSpawner.ChildProcessSpawner,
          idAllocator: yield* IdAllocator.IdAllocatorV2,
          path: yield* Path.Path,
          serverConfig: yield* ServerConfig.ServerConfig,
        });
        const result = yield* Effect.result(
          adapter.openSession({
            threadId: ThreadId.make("thread-antigravity-approval"),
            providerSessionId: ProviderSessionId.make("session-antigravity-approval"),
            modelSelection: {
              instanceId: ProviderInstanceId.make("antigravity"),
              model: "gemini-3.6-flash",
              options: [],
            },
            runtimePolicy: {
              runtimeMode: "approval-required",
              interactionMode: "default",
              cwd: process.cwd(),
            },
          }),
        );
        assert.isTrue(result._tag === "Failure");
      }),
    ),
  );
});
