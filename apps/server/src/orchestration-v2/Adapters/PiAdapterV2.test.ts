import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ChatAttachmentId,
  MessageId,
  NodeId,
  OrchestrationV2ProviderCapabilities,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as IdAllocator from "../IdAllocator.ts";
import { attachmentRelativePath } from "../../attachmentStore.ts";
import { makePiAdapterV2, PiProviderCapabilitiesV2 } from "./PiAdapterV2.ts";

const encoder = new TextEncoder();
const decodeRecord = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const usage = {
  input: 10,
  output: 4,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 14,
  cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
};

const assistantMessage = {
  role: "assistant",
  provider: "openai-codex",
  model: "gpt-5.4",
  usage,
  stopReason: "stop",
  timestamp: 1_765_000_000_000,
};

const isCapabilities = Schema.is(OrchestrationV2ProviderCapabilities);

const makeFixtureSpawner = (options?: {
  readonly approval?: boolean;
  readonly terminalWithPendingApproval?: boolean;
  readonly promptFailure?: boolean;
}) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done<void>>();
    const exited = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
    const cancelledResponse = yield* Deferred.make<Record<string, unknown>>();
    const commands: Array<Record<string, unknown>> = [];
    const offer = (record: Record<string, unknown>) =>
      Queue.offer(stdout, encoder.encode(`${JSON.stringify(record)}\n`));
    const stdin = Sink.forEach((bytes: Uint8Array) =>
      Effect.gen(function* () {
        const command = decodeRecord(new TextDecoder().decode(bytes).trim());
        commands.push(command);
        const type = String(command["type"]);
        const id = command["id"];
        const response = (data?: Record<string, unknown>) =>
          offer({ type: "response", id, command: type, success: true, ...(data ? { data } : {}) });
        if (type === "get_state") {
          yield* response({ sessionFile: "C:/sessions/pi-fixture.jsonl", sessionId: "fixture" });
        } else if (type === "switch_session") {
          yield* response({ cancelled: false });
        } else if (type === "set_model") {
          yield* response({ provider: command["provider"], id: command["modelId"] });
        } else if (type === "set_thinking_level") {
          yield* response();
        } else if (type === "prompt") {
          if (options?.promptFailure === true) {
            yield* offer({
              type: "response",
              id,
              command: type,
              success: false,
              error: "rejected",
            });
            return;
          }
          yield* response();
          yield* offer({ type: "agent_start" });
          yield* offer({ type: "turn_start" });
          if (options?.approval === true) {
            yield* offer({
              type: "extension_ui_request",
              id: "extension-confirm-1",
              method: "confirm",
              title: "Run command",
              message: "Allow the command?",
            });
            if (options.terminalWithPendingApproval === true) {
              yield* offer({ type: "agent_end", messages: [], willRetry: false });
              yield* offer({ type: "agent_settled" });
            }
            return;
          }
          yield* offer({
            type: "message_update",
            message: assistantMessage,
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "hello" },
          });
          yield* offer({
            type: "tool_execution_start",
            toolCallId: "tool-1",
            toolName: "read",
            args: { path: "README.md" },
          });
          yield* offer({
            type: "tool_execution_end",
            toolCallId: "tool-1",
            toolName: "read",
            result: { content: [{ type: "text", text: "contents" }] },
            isError: false,
          });
          yield* offer({ type: "message_end", message: assistantMessage });
          yield* offer({ type: "agent_end", messages: [assistantMessage], willRetry: false });
          yield* offer({ type: "agent_settled" });
        } else if (type === "extension_ui_response") {
          if (command["cancelled"] === true) yield* Deferred.succeed(cancelledResponse, command);
          yield* offer({ type: "agent_end", messages: [], willRetry: false });
          yield* offer({ type: "agent_settled" });
        }
      }),
    );
    const spawner = ChildProcessSpawner.make(() =>
      Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4321),
          exitCode: Deferred.await(exited),
          isRunning: Effect.succeed(true),
          kill: () =>
            Queue.end(stdout).pipe(
              Effect.andThen(Deferred.succeed(exited, ChildProcessSpawner.ExitCode(0))),
            ),
          unref: Effect.succeed(Effect.void),
          stdin,
          stdout: Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      ),
    );
    return { spawner, commands, cancelledResponse } as const;
  });

describe("PiAdapterV2", () => {
  it("advertises only the conversation controls implemented safely", () => {
    expect(isCapabilities(PiProviderCapabilitiesV2)).toBe(true);
    expect(PiProviderCapabilitiesV2.threads).toMatchObject({
      canReadThreadSnapshot: true,
      canRollbackThread: false,
      canForkThread: false,
    });
    expect(PiProviderCapabilitiesV2.turns).toMatchObject({
      supportsInterrupt: true,
      supportsActiveSteering: true,
      terminalStatusQuality: "strong",
    });
  });

  it.effect("runs a persisted RPC turn through text, tool, and terminal V2 events", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const { spawner, commands } = yield* makeFixtureSpawner();
      const attachmentsDir = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pi-" });
      const attachment = {
        type: "image" as const,
        id: ChatAttachmentId.make("thread-pi-fixture-00000000-0000-0000-0000-000000000001"),
        name: "pixel.png",
        mimeType: "image/png",
        sizeBytes: 3,
      };
      yield* fileSystem.writeFile(
        `${attachmentsDir}/${attachmentRelativePath(attachment)}`,
        new Uint8Array([1, 2, 3]),
      );
      const adapter = makePiAdapterV2({
        instanceId: ProviderInstanceId.make("pi"),
        settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
        environment: process.env,
        idAllocator,
        spawner,
        fileSystem,
        attachmentsDir,
        defaultCwd: process.cwd(),
      });
      const threadId = ThreadId.make("thread-pi-fixture");
      const providerSessionId = ProviderSessionId.make("provider-session-pi-fixture");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("pi"),
        model: "openai-codex/gpt-5.4",
        options: [{ id: "thinking", value: "high" }],
      };
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: process.cwd(),
        reasoningEffort: "max",
      };
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId,
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
        Effect.forkChild({ startImmediately: true }),
      );
      yield* runtime.startTurn({
        appThread: {
          id: threadId,
          projectId: ProjectId.make("project-pi"),
        } as OrchestrationV2AppThread,
        threadId,
        runId: RunId.make("run-pi-fixture"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-pi-fixture"),
        rootNodeId: NodeId.make("node-pi-root"),
        providerThread,
        message: {
          messageId: MessageId.make("message-pi-user"),
          text: "Say hello and read README",
          attachments: [attachment],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      expect(
        events.some((event) => event.type === "message.updated" && event.message.text === "hello"),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "turn_item.updated" &&
            event.turnItem.type === "dynamic_tool" &&
            event.turnItem.status === "completed" &&
            "input" in event.turnItem &&
            JSON.stringify(event.turnItem.input) === JSON.stringify({ path: "README.md" }),
        ),
      ).toBe(true);
      expect(
        events.some(
          (event) =>
            event.type === "message.updated" &&
            event.message.text === "hello" &&
            event.message.streaming === false,
        ),
      ).toBe(true);
      expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
      expect(commands.find((command) => command["type"] === "prompt")?.["images"]).toEqual([
        { type: "image", data: "AQID", mimeType: "image/png" },
      ]);
      expect(commands.find((command) => command["type"] === "set_thinking_level")).toMatchObject({
        level: "high",
      });

      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      expect(snapshot.providerThread.nativeThreadRef?.nativeId).toBe(
        "C:/sessions/pi-fixture.jsonl",
      );
      expect(snapshot.providerTurns).toHaveLength(1);
      expect(snapshot.messages[0]?.text).toBe("hello");

      const resumed = yield* runtime.resumeThread({ providerThread });
      expect(resumed.nativeThreadRef?.nativeId).toBe("C:/sessions/pi-fixture.jsonl");
      expect(commands.find((command) => command["type"] === "switch_session")).toMatchObject({
        sessionPath: "C:/sessions/pi-fixture.jsonl",
      });
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect("round-trips extension approvals and resolves their projected lifecycle", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const { spawner, commands } = yield* makeFixtureSpawner({ approval: true });
      const adapter = makePiAdapterV2({
        instanceId: ProviderInstanceId.make("pi"),
        settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
        environment: process.env,
        idAllocator,
        spawner,
        fileSystem,
        attachmentsDir: process.cwd(),
        defaultCwd: process.cwd(),
      });
      const threadId = ThreadId.make("thread-pi-approval");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("pi"),
        model: "openai-codex/gpt-5.4",
      };
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: process.cwd(),
      };
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-pi-approval"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      const pendingRequest = yield* Deferred.make<RuntimeRequestId>();
      const events: Array<unknown> = [];
      const eventsFiber = yield* runtime.events.pipe(
        Stream.takeUntil((event) => event.type === "turn.terminal"),
        Stream.runForEach((event) =>
          Effect.sync(() => events.push(event)).pipe(
            Effect.andThen(
              event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending"
                ? Deferred.succeed(pendingRequest, event.runtimeRequest.id)
                : Effect.void,
            ),
          ),
        ),
        Effect.forkChild({ startImmediately: true }),
      );
      yield* runtime.startTurn({
        appThread: {
          id: threadId,
          projectId: ProjectId.make("project-pi"),
        } as OrchestrationV2AppThread,
        threadId,
        runId: RunId.make("run-pi-approval"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-pi-approval"),
        rootNodeId: NodeId.make("node-pi-approval-root"),
        providerThread,
        message: {
          messageId: MessageId.make("message-pi-approval"),
          text: "Ask for approval",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection,
        runtimePolicy,
      });
      const requestId = yield* Deferred.await(pendingRequest);
      yield* runtime.respondToRuntimeRequest({ requestId, decision: "accept" });
      yield* Fiber.join(eventsFiber);

      expect(commands.find((command) => command["type"] === "extension_ui_response")).toMatchObject(
        {
          id: "extension-confirm-1",
          confirmed: true,
        },
      );
      expect(
        events.some(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            "type" in event &&
            event.type === "turn_item.updated" &&
            "turnItem" in event &&
            typeof event.turnItem === "object" &&
            event.turnItem !== null &&
            "status" in event.turnItem &&
            event.turnItem.status === "completed",
        ),
      ).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect("cancels pending extension prompts when the Pi run settles", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const { spawner, cancelledResponse } = yield* makeFixtureSpawner({
        approval: true,
        terminalWithPendingApproval: true,
      });
      const adapter = makePiAdapterV2({
        instanceId: ProviderInstanceId.make("pi"),
        settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
        environment: process.env,
        idAllocator,
        spawner,
        fileSystem,
        attachmentsDir: process.cwd(),
        defaultCwd: process.cwd(),
      });
      const threadId = ThreadId.make("thread-pi-cancel-prompt");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("pi"),
        model: "openai-codex/gpt-5.4",
      };
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: process.cwd(),
      };
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-pi-cancel-prompt"),
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
        Effect.forkChild({ startImmediately: true }),
      );
      yield* runtime.startTurn({
        appThread: {
          id: threadId,
          projectId: ProjectId.make("project-pi"),
        } as OrchestrationV2AppThread,
        threadId,
        runId: RunId.make("run-pi-cancel-prompt"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("attempt-pi-cancel-prompt"),
        rootNodeId: NodeId.make("node-pi-cancel-prompt-root"),
        providerThread,
        message: {
          messageId: MessageId.make("message-pi-cancel-prompt"),
          text: "Ask, then settle",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
        modelSelection,
        runtimePolicy,
      });
      const events = Array.from(yield* Fiber.join(eventsFiber));
      expect(
        events.some(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "cancelled",
        ),
      ).toBe(true);
      expect(yield* Deferred.await(cancelledResponse)).toMatchObject({
        type: "extension_ui_response",
        id: "extension-confirm-1",
        cancelled: true,
      });
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );

  it.effect("rolls back in-memory running state when the prompt RPC fails", () =>
    Effect.gen(function* () {
      const idAllocator = yield* IdAllocator.IdAllocatorV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const { spawner } = yield* makeFixtureSpawner({ promptFailure: true });
      const adapter = makePiAdapterV2({
        instanceId: ProviderInstanceId.make("pi"),
        settings: { enabled: true, binaryPath: "pi", launchArgs: "", customModels: [] },
        environment: process.env,
        idAllocator,
        spawner,
        fileSystem,
        attachmentsDir: process.cwd(),
        defaultCwd: process.cwd(),
      });
      const threadId = ThreadId.make("thread-pi-prompt-failure");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("pi"),
        model: "openai-codex/gpt-5.4",
      };
      const runtimePolicy = {
        runtimeMode: "full-access" as const,
        interactionMode: "default" as const,
        cwd: process.cwd(),
      };
      const runtime = yield* adapter.openSession({
        threadId,
        providerSessionId: ProviderSessionId.make("provider-session-pi-prompt-failure"),
        modelSelection,
        runtimePolicy,
      });
      const providerThread = yield* runtime.ensureThread({
        threadId,
        modelSelection,
        runtimePolicy,
      });
      yield* runtime
        .startTurn({
          appThread: {
            id: threadId,
            projectId: ProjectId.make("project-pi"),
          } as OrchestrationV2AppThread,
          threadId,
          runId: RunId.make("run-pi-prompt-failure"),
          runOrdinal: 1,
          providerTurnOrdinal: 1,
          attemptId: RunAttemptId.make("attempt-pi-prompt-failure"),
          rootNodeId: NodeId.make("node-pi-prompt-failure-root"),
          providerThread,
          message: {
            messageId: MessageId.make("message-pi-prompt-failure"),
            text: "Fail to start",
            attachments: [],
            createdBy: "user",
            creationSource: "web",
          },
          modelSelection,
          runtimePolicy,
        })
        .pipe(Effect.flip);
      const snapshot = yield* runtime.readThreadSnapshot({ providerThread });
      expect(snapshot.providerThread.status).toBe("idle");
      expect(snapshot.providerTurns).toMatchObject([{ status: "failed" }]);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer))),
  );
});
