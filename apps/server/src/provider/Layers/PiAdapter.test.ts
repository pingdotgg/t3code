// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  EnvironmentId,
  PiAgentSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import {
  T3_MCP_BEARER_TOKEN_ENV,
  T3_MCP_ENDPOINT_ENV,
} from "../../bundled-pi-extension/contract.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { PiRpcClientError, type PiRpcClient } from "../pi/PiRpcClient.ts";
import type {
  PiAgentEvent,
  PiExtensionUIRequest,
  PiRpcCommand,
  PiRpcResponse,
} from "../pi/PiRpcProtocol.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makePiAdapter, type PiClientFactoryInput } from "./PiAdapter.ts";

const decodeSettings = Schema.decodeSync(PiAgentSettings);
const THREAD_ID = ThreadId.make("thread-pi-adapter");
const INSTANCE_ID = ProviderInstanceId.make("piAgent");

const makeHarness = Effect.fn("makePiAdapterTestHarness")(function* (options?: {
  readonly resumeSessionFile?: string;
  readonly messages?: ReadonlyArray<unknown>;
  readonly provider?: ProviderDriverKind;
  readonly providerName?: string;
  readonly instanceId?: ProviderInstanceId;
  readonly binaryPath?: string;
  readonly skillFlag?: "--skill" | "--skills";
  readonly promptResponseData?: unknown;
  readonly useDefaultIds?: boolean;
}) {
  const provider = options?.provider ?? ProviderDriverKind.make("piAgent");
  const instanceId = options?.instanceId ?? INSTANCE_ID;
  const nativeEvents = yield* Queue.unbounded<PiAgentEvent | PiExtensionUIRequest>();
  const terminated = yield* Deferred.make<PiRpcClientError>();
  const commands: PiRpcCommand[] = [];
  const factoryInputs: PiClientFactoryInput[] = [];
  const bindings: unknown[] = [];
  const nativeLogs = yield* Queue.unbounded<{ event: unknown; threadId: ThreadId | null }>();
  let closeCalls = 0;
  let turnSequence = 0;

  const success = (command: PiRpcCommand, data?: unknown): PiRpcResponse => ({
    type: "response",
    command: command.type,
    success: true,
    ...(data === undefined ? {} : { data }),
  });
  const client: PiRpcClient = {
    request: (command) =>
      Effect.sync(() => {
        commands.push(command);
        switch (command.type) {
          case "get_state":
            return success(command, {
              sessionId: "pi-session-1",
              sessionFile: options?.resumeSessionFile ?? "/tmp/pi-session-1.jsonl",
              model: { provider: "openai", id: "gpt-5.5" },
              thinkingLevel: "medium",
            });
          case "get_session_stats":
            return success(command, {
              tokens: { input: 10, output: 5, total: 15 },
              toolCalls: 1,
              contextUsage: { contextWindow: 200000 },
            });
          case "get_messages":
            return success(command, { messages: options?.messages ?? [] });
          case "prompt":
            return success(command, options?.promptResponseData);
          default:
            return success(command);
        }
      }),
    send: (command) => Effect.sync(() => void commands.push(command)),
    events: Stream.fromQueue(nativeEvents),
    terminated: Deferred.await(terminated),
    close: Effect.sync(() => {
      closeCalls += 1;
    }),
  };

  const directoryLayer = Layer.succeed(ProviderSessionDirectory, {
    upsert: (binding) => Effect.sync(() => void bindings.push(binding)),
    getProvider: () => Effect.succeed(provider),
    getBinding: () => Effect.succeed(Option.none()),
    listThreadIds: () => Effect.succeed([]),
    listBindings: () => Effect.succeed([]),
  });

  const adapter = yield* makePiAdapter(
    decodeSettings({ binaryPath: options?.binaryPath ?? "fake-pi" }),
    {
      provider,
      ...(options?.providerName ? { providerName: options.providerName } : {}),
      ...(options?.skillFlag ? { skillFlag: options.skillFlag } : {}),
      instanceId,
      createClient: (input) =>
        Effect.sync(() => {
          factoryInputs.push(input);
          return client;
        }),
      now: () => "2026-07-12T00:00:00.000Z",
      ...(options?.useDefaultIds ? {} : { nextTurnId: () => `turn-pi-${++turnSequence}` }),
      nativeEventLogger: {
        filePath: "memory://pi-native-events",
        write: (event, threadId) =>
          Queue.offer(nativeLogs, { event, threadId }).pipe(Effect.asVoid),
        close: () => Effect.void,
      },
    },
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        directoryLayer,
        NodeServices.layer,
        ServerConfig.layerTest("/tmp/project", "/tmp/t3-base").pipe(
          Layer.provide(NodeServices.layer),
        ),
      ),
    ),
  );

  return {
    adapter,
    commands,
    factoryInputs,
    bindings,
    nativeLogs,
    emit: (event: PiAgentEvent | PiExtensionUIRequest) => Queue.offer(nativeEvents, event),
    terminate: (detail: string) =>
      Deferred.succeed(terminated, new PiRpcClientError({ operation: "process-exit", detail })),
    closeCalls: () => closeCalls,
  };
});

describe("PiAdapter", () => {
  it.effect("starts a Pi RPC session and returns its resume cursor", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const session = yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          provider: ProviderDriverKind.make("piAgent"),
          providerInstanceId: INSTANCE_ID,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });

        expect(session).toMatchObject({
          provider: "piAgent",
          providerInstanceId: "piAgent",
          status: "ready",
          threadId: THREAD_ID,
          model: "openai/gpt-5.5",
          resumeCursor: {
            sessionId: "pi-session-1",
            sessionFile: "/tmp/pi-session-1.jsonl",
          },
        });
        expect(harness.factoryInputs[0]).toMatchObject({
          binaryPath: "fake-pi",
          cwd: "/tmp/project",
        });
        expect(session.resumeCursor).toEqual({
          sessionId: "pi-session-1",
          sessionFile: "/tmp/pi-session-1.jsonl",
        });
      }),
    ),
  );

  it.effect("keeps an OMP session isolated under the omp provider identity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const omp = ProviderDriverKind.make("omp");
        const ompInstance = ProviderInstanceId.make("omp");
        const harness = yield* makeHarness({
          provider: omp,
          providerName: "Oh My Pi",
          instanceId: ompInstance,
          binaryPath: "fake-omp",
        });
        const session = yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          provider: omp,
          providerInstanceId: ompInstance,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });

        expect(session).toMatchObject({
          provider: "omp",
          providerInstanceId: "omp",
          status: "ready",
        });
        expect(harness.factoryInputs[0]).toMatchObject({ binaryPath: "fake-omp" });
      }),
    ),
  );

  it.effect("keeps Pi runtime ids unique across adapter restarts", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const omp = ProviderDriverKind.make("omp");
        const ompInstance = ProviderInstanceId.make("omp");
        const start = Effect.fn(function* () {
          const harness = yield* makeHarness({
            provider: omp,
            providerName: "Oh My Pi",
            instanceId: ompInstance,
            useDefaultIds: true,
          });
          yield* harness.adapter.startSession({
            threadId: THREAD_ID,
            provider: omp,
            providerInstanceId: ompInstance,
            cwd: "/tmp/project",
            runtimeMode: "full-access",
          });
          const turn = yield* harness.adapter.sendTurn({
            threadId: THREAD_ID,
            input: "Check ids",
          });
          yield* harness.emit({
            type: "tool_execution_start",
            toolCallId: "web-search-1",
            toolName: "web_search",
            args: { query: "weather" },
          });
          const events = [
            ...(yield* harness.adapter.streamEvents.pipe(Stream.take(9), Stream.runCollect)),
          ];
          return { turn, events };
        });

        const first = yield* start();
        const second = yield* start();

        expect(first.turn.turnId).toMatch(/^omp-turn-[0-9a-f-]{36}$/u);
        expect(second.turn.turnId).toMatch(/^omp-turn-[0-9a-f-]{36}$/u);
        expect(second.turn.turnId).not.toBe(first.turn.turnId);
        const firstEventIds = new Set(first.events.map((event) => event.eventId));
        expect(second.events.every((event) => !firstEventIds.has(event.eventId))).toBe(true);
        const itemIds = (events: typeof first.events) =>
          events.flatMap((event) =>
            event.type === "item.started" && event.itemId !== undefined ? [event.itemId] : [],
          );
        const firstItemIds = new Set(itemIds(first.events));
        expect(firstItemIds.size).toBe(1);
        expect(itemIds(second.events).every((itemId) => !firstItemIds.has(itemId))).toBe(true);
      }),
    ),
  );

  it.effect("passes a persisted Pi session file to the client factory", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({ resumeSessionFile: "/tmp/restored.jsonl" });
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
          resumeCursor: {
            sessionId: "pi-old-session",
            sessionFile: "/tmp/restored.jsonl",
          },
        });

        expect(harness.factoryInputs[0]?.args).toEqual(["--session", "/tmp/restored.jsonl"]);
      }),
    ),
  );

  it.effect("loads the bundled preview extension and Midscene Skill with scoped MCP auth", () =>
    Effect.scoped(
      Effect.gen(function* () {
        McpProviderSession.setMcpProviderSession({
          environmentId: EnvironmentId.make("environment-pi-adapter"),
          threadId: THREAD_ID,
          providerSessionId: "provider-session-pi-adapter",
          providerInstanceId: INSTANCE_ID,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer pi-mcp-secret",
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(THREAD_ID)),
        );

        const harness = yield* makeHarness();
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });

        const factoryInput = harness.factoryInputs[0];
        expect(factoryInput?.env).toMatchObject({
          [T3_MCP_ENDPOINT_ENV]: "http://127.0.0.1:43123/mcp",
          [T3_MCP_BEARER_TOKEN_ENV]: "pi-mcp-secret",
        });
        expect(factoryInput?.args).toHaveLength(4);
        expect(factoryInput?.args?.[0]).toBe("--extension");
        expect(factoryInput?.args?.[1]).toMatch(/bundled-pi-extension[\\/]index\.ts$/u);
        expect(factoryInput?.args?.[2]).toBe("--skill");
        expect(factoryInput?.args?.[3]).toMatch(
          /bundled-skills[\\/]midscene-preview[\\/]SKILL\.md$/u,
        );
      }),
    ),
  );

  it.effect("uses the OMP skill flag when a scoped MCP session is active", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const omp = ProviderDriverKind.make("omp");
        const ompInstance = ProviderInstanceId.make("omp");
        McpProviderSession.setMcpProviderSession({
          environmentId: EnvironmentId.make("environment-omp-adapter"),
          threadId: THREAD_ID,
          providerSessionId: "provider-session-omp-adapter",
          providerInstanceId: ompInstance,
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer omp-mcp-secret",
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(THREAD_ID)),
        );

        const harness = yield* makeHarness({
          provider: omp,
          providerName: "Oh My Pi",
          instanceId: ompInstance,
          binaryPath: "fake-omp",
          skillFlag: "--skills",
        });
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          provider: omp,
          providerInstanceId: ompInstance,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });

        expect(harness.factoryInputs[0]?.args?.[0]).toBe("--extension");
        expect(harness.factoryInputs[0]?.args?.[2]).toBe("--skills");
      }),
    ),
  );

  it.effect("sets model and thinking level before prompting", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        const result = yield* harness.adapter.sendTurn({
          threadId: THREAD_ID,
          input: "Inspect the repository",
          modelSelection: createModelSelection(INSTANCE_ID, "anthropic/claude-sonnet-4-6", [
            { id: "effort", value: "high" },
          ]),
        });

        expect(result.turnId).toBe("turn-pi-1");
        expect(harness.commands.slice(-3)).toEqual([
          {
            type: "set_model",
            provider: "anthropic",
            modelId: "claude-sonnet-4-6",
          },
          { type: "set_thinking_level", level: "high" },
          { type: "prompt", message: "Inspect the repository" },
        ]);
      }),
    ),
  );

  it.effect("sends image attachments as Pi RPC base64 image content", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attachment = {
          type: "image" as const,
          id: "thread-pi-image-12345678-1234-1234-1234-123456789abc",
          name: "diagram.png",
          mimeType: "image/png",
          sizeBytes: 4,
        };
        const attachmentPath = NodePath.join(
          "/tmp/t3-base/userdata/attachments",
          `${attachment.id}.png`,
        );
        NodeFS.mkdirSync(NodePath.dirname(attachmentPath), { recursive: true });
        NodeFS.writeFileSync(attachmentPath, Uint8Array.from([1, 2, 3, 4]));
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(attachmentPath, { force: true })),
        );

        const harness = yield* makeHarness();
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        yield* harness.adapter.sendTurn({
          threadId: THREAD_ID,
          input: "Inspect this image",
          attachments: [attachment],
        });

        expect(harness.commands.at(-1)).toEqual({
          type: "prompt",
          message: "Inspect this image",
          images: [{ type: "image", data: "AQIDBA==", mimeType: "image/png" }],
        });
      }),
    ),
  );

  it.effect("maps restored Pi assistant messages into thread turns", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          messages: [
            { role: "user", content: "Hello", timestamp: 1 },
            {
              role: "assistant",
              content: [{ type: "text", text: "Hi" }],
              provider: "openai",
              model: "gpt-5.5",
              timestamp: 2,
            },
            {
              role: "toolResult",
              toolCallId: "call-1",
              content: [{ type: "text", text: "done" }],
              timestamp: 3,
            },
            {
              id: "assistant-2",
              role: "assistant",
              content: [{ type: "text", text: "Finished" }],
              timestamp: 4,
            },
          ],
        });
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });

        const snapshot = yield* harness.adapter.readThread(THREAD_ID);

        expect(snapshot.turns).toEqual([
          expect.objectContaining({
            id: "pi-session-1-history-1",
            items: [expect.objectContaining({ role: "assistant" })],
          }),
          expect.objectContaining({
            id: "assistant-2",
            items: [expect.objectContaining({ role: "assistant" })],
          }),
        ]);
      }),
    ),
  );

  it.effect("maps Pi events and marks the session ready after agent_settled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "Hello" });
        const eventsFiber = yield* harness.adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* harness.emit({
          type: "message_update",
          message: {},
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hi" },
        });
        yield* harness.emit({ type: "agent_end", messages: [], willRetry: false });
        yield* Effect.yieldNow;
        expect((yield* harness.adapter.listSessions())[0]).toMatchObject({ status: "running" });
        yield* harness.emit({ type: "agent_settled" });

        const events = [...(yield* Fiber.join(eventsFiber))];
        expect(events.some((event) => event.type === "content.delta")).toBe(true);
        expect(events.some((event) => event.type === "turn.completed")).toBe(true);
        expect((yield* harness.adapter.listSessions())[0]).toMatchObject({ status: "ready" });
      }),
    ),
  );

  it.effect("keeps OMP running until agent_end is terminal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const omp = ProviderDriverKind.make("omp");
        const ompInstance = ProviderInstanceId.make("omp");
        const harness = yield* makeHarness({
          provider: omp,
          providerName: "Oh My Pi",
          instanceId: ompInstance,
        });
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          provider: omp,
          providerInstanceId: ompInstance,
          runtimeMode: "full-access",
        });
        yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "Continue" });

        yield* harness.emit({ type: "agent_end", isTerminal: false, messages: [] });
        yield* Effect.yieldNow;
        expect((yield* harness.adapter.listSessions())[0]).toMatchObject({ status: "running" });

        yield* harness.emit({ type: "agent_end", isTerminal: true, messages: [] });
        yield* Effect.yieldNow;
        expect((yield* harness.adapter.listSessions())[0]).toMatchObject({ status: "ready" });
      }),
    ),
  );

  it.effect("finishes an OMP local prompt from its immediate response", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const omp = ProviderDriverKind.make("omp");
        const ompInstance = ProviderInstanceId.make("omp");
        const harness = yield* makeHarness({
          provider: omp,
          providerName: "Oh My Pi",
          instanceId: ompInstance,
          promptResponseData: { agentInvoked: false },
        });
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          provider: omp,
          providerInstanceId: ompInstance,
          runtimeMode: "full-access",
        });

        yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "/model" });

        expect((yield* harness.adapter.listSessions())[0]).toMatchObject({ status: "ready" });
      }),
    ),
  );

  it.effect("finishes an OMP local prompt from a deferred prompt_result", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const omp = ProviderDriverKind.make("omp");
        const ompInstance = ProviderInstanceId.make("omp");
        const harness = yield* makeHarness({
          provider: omp,
          providerName: "Oh My Pi",
          instanceId: ompInstance,
        });
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          provider: omp,
          providerInstanceId: ompInstance,
          runtimeMode: "full-access",
        });
        yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "/model" });

        yield* harness.emit({ type: "prompt_result", agentInvoked: false });
        yield* Effect.yieldNow;

        expect((yield* harness.adapter.listSessions())[0]).toMatchObject({ status: "ready" });
      }),
    ),
  );

  it.effect("writes Pi RPC events to the shared native event logger", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });

        yield* harness.emit({ type: "agent_start" });
        const logged = yield* Queue.take(harness.nativeLogs);

        expect(logged).toEqual({
          threadId: THREAD_ID,
          event: {
            observedAt: "2026-07-12T00:00:00.000Z",
            event: {
              id: expect.any(String),
              kind: "notification",
              provider: "piAgent",
              providerInstanceId: INSTANCE_ID,
              createdAt: "2026-07-12T00:00:00.000Z",
              method: "agent_start",
              threadId: THREAD_ID,
              payload: { type: "agent_start" },
            },
          },
        });
      }),
    ),
  );

  it.effect("keeps a failed Pi turn visible in the session after agent_settled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          cwd: "/tmp/project",
          runtimeMode: "full-access",
        });
        yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "Hello" });

        yield* harness.emit({
          type: "agent_end",
          willRetry: false,
          messages: [
            {
              role: "assistant",
              content: [],
              stopReason: "error",
              errorMessage: "401 authentication_error",
            },
          ],
        });
        yield* harness.emit({ type: "agent_settled" });
        yield* Effect.yieldNow;

        expect((yield* harness.adapter.listSessions())[0]).toMatchObject({
          status: "error",
          lastError: "401 authentication_error",
        });
      }),
    ),
  );

  it.effect("aborts an active turn", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          runtimeMode: "full-access",
        });
        const turn = yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "Wait" });

        yield* harness.adapter.interruptTurn(THREAD_ID, turn.turnId);

        expect(harness.commands.at(-1)).toEqual({ type: "abort" });
        expect((yield* harness.adapter.listSessions())[0]).toMatchObject({ status: "ready" });
      }),
    ),
  );

  it.effect("keeps a crashed session in error when a late agent_end arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          runtimeMode: "full-access",
        });
        yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "Crash" });
        const eventsFiber = yield* harness.adapter.streamEvents.pipe(
          Stream.take(12),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* harness.terminate("Pi RPC process exited with status 17.");
        const events = [...(yield* Fiber.join(eventsFiber))];
        yield* harness.emit({ type: "agent_end", messages: [] });
        yield* Effect.yieldNow;

        expect(events.filter((event) => event.type === "runtime.error")).toHaveLength(1);
        expect(events.filter((event) => event.type === "turn.completed")).toHaveLength(1);
        expect((yield* harness.adapter.listSessions())[0]).toMatchObject({
          status: "error",
          lastError: "Pi RPC process exited with status 17.",
        });
      }),
    ),
  );

  it.effect("returns extension confirmation answers to Pi", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          runtimeMode: "full-access",
        });
        yield* harness.adapter.sendTurn({ threadId: THREAD_ID, input: "Run extension" });
        yield* harness.emit({
          type: "extension_ui_request",
          id: "ui-confirm-1",
          method: "confirm",
          title: "Continue?",
          message: "Continue?",
        });
        yield* Effect.yieldNow;

        yield* harness.adapter.respondToUserInput(
          THREAD_ID,
          ApprovalRequestId.make("ui-confirm-1"),
          { value: "Yes" },
        );

        expect(harness.commands.at(-1)).toEqual({
          type: "extension_ui_response",
          id: "ui-confirm-1",
          confirmed: true,
        });
      }),
    ),
  );

  it.effect("closes the Pi client when stopping a session", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.adapter.startSession({
          threadId: THREAD_ID,
          providerInstanceId: INSTANCE_ID,
          runtimeMode: "full-access",
        });

        yield* harness.adapter.stopSession(THREAD_ID);

        expect(harness.closeCalls()).toBe(1);
        expect(yield* harness.adapter.hasSession(THREAD_ID)).toBe(false);
      }),
    ),
  );
});
