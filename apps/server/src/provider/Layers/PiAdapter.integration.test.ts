import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import { makePiAdapter } from "./PiAdapter.ts";
import type {
  AgentSessionEvent,
  PiRpcTransport,
  PiStdoutMessage,
  PiTurnCommand,
  RpcCommand,
  RpcExtensionUIRequest,
  RpcExtensionUIResponse,
  RpcResponse,
} from "./PiRpcClient.ts";

const decodePiSettings = Schema.decodeSync(PiSettings);
const PI = ProviderDriverKind.make("pi");

const HarnessLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-integration-",
}).pipe(Layer.provideMerge(NodeServices.layer));

interface FakePiTransport {
  readonly transport: PiRpcTransport;
  readonly commands: Array<RpcCommand>;
  readonly extensionResponses: Array<RpcExtensionUIResponse>;
  readonly pushEvent: (event: AgentSessionEvent) => Effect.Effect<void>;
  readonly pushExtensionUI: (request: RpcExtensionUIRequest) => Effect.Effect<void>;
  readonly setResponse: (commandType: string, response: RpcResponse) => void;
  readonly gateRequests: (
    commandType: string,
    entered: Deferred.Deferred<void>,
    release: Deferred.Deferred<void>,
  ) => void;
  readonly failNextWrite: (defect?: Error) => void;
}

const asResponse = (value: unknown): RpcResponse => value as RpcResponse;

const makeFakePiRpcTransport = Effect.gen(function* () {
  const messages = yield* Queue.unbounded<PiStdoutMessage, Cause.Done<void>>();
  const commands: Array<RpcCommand> = [];
  const extensionResponses: Array<RpcExtensionUIResponse> = [];
  const responses = new Map<string, RpcResponse>();
  const requestGates = new Map<
    string,
    { readonly entered: Deferred.Deferred<void>; readonly release: Deferred.Deferred<void> }
  >();
  let nextWriteDefect: Error | undefined;
  responses.set(
    "get_state",
    asResponse({
      type: "response",
      id: "x",
      command: "get_state",
      success: true,
      data: { sessionFile: "/tmp/pi-session.json" },
    }),
  );
  responses.set(
    "get_commands",
    asResponse({
      type: "response",
      id: "x",
      command: "get_commands",
      success: true,
      data: { commands: [{ name: "t3-approval-gate", source: "extension" }] },
    }),
  );

  const transport: PiRpcTransport = {
    writeCommand: (command) =>
      Effect.suspend(() => {
        if (nextWriteDefect !== undefined) {
          const defect = nextWriteDefect;
          nextWriteDefect = undefined;
          return Effect.die(defect);
        }
        return Effect.sync(() => {
          commands.push(command);
        });
      }),
    writeExtensionResponse: (response) =>
      Effect.suspend(() => {
        if (nextWriteDefect !== undefined) {
          const defect = nextWriteDefect;
          nextWriteDefect = undefined;
          return Effect.die(defect);
        }
        return Effect.sync(() => {
          extensionResponses.push(response);
        });
      }),
    request: (command) =>
      Effect.gen(function* () {
        const commandType = (command as { type: string }).type;
        commands.push(command);
        const gate = requestGates.get(commandType);
        if (gate !== undefined) {
          yield* Deferred.succeed(gate.entered, undefined).pipe(Effect.ignore);
          yield* Deferred.await(gate.release);
        }
        return responses.get(commandType);
      }),
    messages,
    isClosed: Effect.succeed(false),
    kill: Effect.void,
  };

  return {
    transport,
    commands,
    extensionResponses,
    pushEvent: (event) => Queue.offer(messages, { _tag: "event", event }).pipe(Effect.asVoid),
    pushExtensionUI: (request) =>
      Queue.offer(messages, { _tag: "extension-ui", request }).pipe(Effect.asVoid),
    setResponse: (commandType, response) => {
      responses.set(commandType, response);
    },
    gateRequests: (commandType, entered, release) => {
      requestGates.set(commandType, { entered, release });
    },
    failNextWrite: (defect = new Error("Pi transport write failed.")) => {
      nextWriteDefect = defect;
    },
  } satisfies FakePiTransport;
});

const makePiAdapterForTest = (settings: PiSettings) =>
  Effect.gen(function* () {
    const fake = yield* makeFakePiRpcTransport;
    const adapter = yield* makePiAdapter(settings, {
      makeTransport: () => Effect.succeed(fake.transport),
    });
    return { adapter, fake } as const;
  });

const collectEvents = (
  adapter: PiAdapterShape,
  threadId: ThreadId,
  isTerminal: (event: ProviderRuntimeEvent) => boolean,
) =>
  Effect.gen(function* () {
    const store = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
    const fiber = yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.threadId === threadId),
      Stream.takeUntil(isTerminal),
      Stream.runForEach((event) => Ref.update(store, (events) => [...events, event])),
      Effect.forkChild,
    );
    return { store, fiber } as const;
  });

const enabledSettings = (overrides: Record<string, unknown> = {}) =>
  decodePiSettings({ enabled: true, ...overrides });

it.layer(HarnessLayer)("PiAdapter integration", (it) => {
  it.effect("starts a session, streams assistant text, and completes the turn", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-basic");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );

      const session = yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      expect(session.provider).toBe("pi");
      expect(session.status).toBe("ready");
      expect(session.resumeCursor).toEqual({ sessionFile: "/tmp/pi-session.json" });

      const turn = yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
      expect(turn.turnId).toBeDefined();
      expect(fake.commands.some((c) => c.type === "prompt")).toBe(true);

      yield* fake.pushEvent({ type: "agent_start" } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "hi" },
      } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "agent_end" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      const types = events.map((event) => event.type);
      expect(types).toContain("session.started");
      expect(types).toContain("turn.started");

      const delta = events.find((event) => event.type === "content.delta");
      expect(delta).toBeDefined();
      if (delta && delta.type === "content.delta") {
        expect(delta.payload.streamKind).toBe("assistant_text");
        expect(delta.payload.delta).toBe("hi");
        expect(delta.raw?.source).toBe("pi.rpc.event");
      }
      const completed = events.find((event) => event.type === "turn.completed");
      if (completed && completed.type === "turn.completed") {
        expect(completed.payload.state).toBe("completed");
      }

      yield* adapter.stopSession(threadId);
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect("fails startup when the Pi process has already exited", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakePiRpcTransport;
      const adapter = yield* makePiAdapter(enabledSettings(), {
        makeTransport: () =>
          Effect.succeed({
            ...fake.transport,
            isClosed: Effect.succeed(true),
          }),
      });
      const threadId = ThreadId.make("pi-int-startup-exit");

      const result = yield* adapter
        .startSession({
          threadId,
          provider: PI,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "ProviderAdapterProcessError",
          threadId,
        });
        expect(result.failure.message).toMatch(/exited during session startup/i);
      }
      expect(yield* adapter.hasSession(threadId)).toBe(false);
    }),
  );

  it.effect("fails sendTurn when the prompt cannot be delivered", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-write-failure");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      fake.failNextWrite();

      const result = yield* adapter
        .sendTurn({ threadId, input: "never delivered", attachments: [] })
        .pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          method: "prompt",
        });
      }

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      const completed = events.find((event) => event.type === "turn.completed");
      expect(completed).toBeDefined();
      if (completed && completed.type === "turn.completed") {
        expect(completed.payload.state).toBe("failed");
      }

      const sessions = yield* adapter.listSessions();
      expect(sessions[0]?.activeTurnId).toBeUndefined();
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps thinking_delta to a reasoning_text content delta", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-reasoning");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "think", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "message_update",
        assistantMessageEvent: { type: "thinking_delta", delta: "why" },
      } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "agent_end" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      const reasoning = events.find(
        (event) => event.type === "content.delta" && event.payload.streamKind === "reasoning_text",
      );
      expect(reasoning).toBeDefined();
    }),
  );

  it.effect(
    "does not finalize the turn on agent_end willRetry; completes on the terminal end",
    () =>
      Effect.gen(function* () {
        const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
        const threadId = ThreadId.make("pi-int-retry");
        const collected = yield* collectEvents(
          adapter,
          threadId,
          (event) => event.type === "turn.completed",
        );
        yield* adapter.startSession({
          threadId,
          provider: PI,
          cwd: process.cwd(),
          runtimeMode: "full-access",
        });
        yield* adapter.sendTurn({ threadId, input: "retry please", attachments: [] });
        yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
        yield* fake.pushEvent({
          type: "agent_end",
          messages: [],
          willRetry: true,
        } as AgentSessionEvent);
        yield* fake.pushEvent({
          type: "agent_end",
          messages: [],
          willRetry: false,
        } as AgentSessionEvent);

        const events = yield* Fiber.join(collected.fiber).pipe(
          Effect.flatMap(() => Ref.get(collected.store)),
        );
        const completions = events.filter((event) => event.type === "turn.completed");
        expect(completions).toHaveLength(1);
        const completed = completions[0];
        if (completed && completed.type === "turn.completed") {
          expect(completed.payload.state).toBe("completed");
        }

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("maps a tool execution lifecycle to item events", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-tool");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "run ls", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
        args: { command: "ls" },
      } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        result: "file.txt",
        isError: false,
      } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "agent_end" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      const started = events.find((event) => event.type === "item.started");
      const completed = events.find((event) => event.type === "item.completed");
      expect(started).toBeDefined();
      expect(completed).toBeDefined();
      if (started && started.type === "item.started") {
        expect(started.payload.itemType).toBe("command_execution");
      }
    }),
  );

  it.effect("uses unknown stream deltas for non-command, non-file tools", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-mcp-tool-update");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "use the MCP tool", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "tool_execution_start",
        toolCallId: "mcp-1",
        toolName: "mcp__server__tool",
        args: { query: "status" },
      } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "tool_execution_update",
        toolCallId: "mcp-1",
        toolName: "mcp__server__tool",
        partialResult: "working",
      } as AgentSessionEvent);
      yield* fake.pushEvent({
        type: "tool_execution_end",
        toolCallId: "mcp-1",
        toolName: "mcp__server__tool",
        result: "done",
        isError: false,
      } as AgentSessionEvent);
      yield* fake.pushEvent({ type: "agent_end" } as AgentSessionEvent);

      const events = yield* Fiber.join(collected.fiber).pipe(
        Effect.flatMap(() => Ref.get(collected.store)),
      );
      const delta = events.find(
        (event) => event.type === "content.delta" && event.payload.delta === "working",
      );
      expect(delta).toBeDefined();
      if (delta && delta.type === "content.delta") {
        expect(delta.payload.streamKind).toBe("unknown");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("bridges a confirm request to an approval round-trip", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-approval");
      const store = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const opened = yield* Deferred.make<ApprovalRequestId>();
      const resolved = yield* Deferred.make<void>();
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* Ref.update(store, (events) => [...events, event]);
            if (event.type === "request.opened" && event.requestId !== undefined) {
              yield* Deferred.succeed(opened, ApprovalRequestId.make(String(event.requestId))).pipe(
                Effect.ignore,
              );
            }
            if (event.type === "request.resolved") {
              yield* Deferred.succeed(resolved, undefined).pipe(Effect.ignore);
            }
          }),
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "edit file", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushExtensionUI({
        type: "extension_ui_request",
        id: "ui-1",
        method: "confirm",
        title: "bash",
        message: "ls -la",
      } as RpcExtensionUIRequest);

      const requestId = yield* Deferred.await(opened);
      fake.failNextWrite();
      const firstAttempt = yield* adapter
        .respondToRequest(threadId, requestId, "accept")
        .pipe(Effect.exit);
      expect(Exit.isFailure(firstAttempt)).toBe(true);
      expect(fake.extensionResponses).toHaveLength(0);

      yield* adapter.respondToRequest(threadId, requestId, "accept");
      yield* Deferred.await(resolved);
      yield* Fiber.interrupt(fiber);

      const events = yield* Ref.get(store);
      const requestOpened = events.find((event) => event.type === "request.opened");
      expect(requestOpened).toBeDefined();
      if (requestOpened && requestOpened.type === "request.opened") {
        expect(requestOpened.raw?.source).toBe("pi.rpc.extension-ui");
      }
      expect(fake.extensionResponses).toContainEqual({
        type: "extension_ui_response",
        id: "ui-1",
        confirmed: true,
      });
    }),
  );

  it.effect("bridges a select request to a user-input round-trip", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-userinput");
      const store = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const opened = yield* Deferred.make<ApprovalRequestId>();
      const resolved = yield* Deferred.make<void>();
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.runForEach((event) =>
          Effect.gen(function* () {
            yield* Ref.update(store, (events) => [...events, event]);
            if (event.type === "user-input.requested" && event.requestId !== undefined) {
              yield* Deferred.succeed(opened, ApprovalRequestId.make(String(event.requestId))).pipe(
                Effect.ignore,
              );
            }
            if (event.type === "user-input.resolved") {
              yield* Deferred.succeed(resolved, undefined).pipe(Effect.ignore);
            }
          }),
        ),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "pick one", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      yield* fake.pushExtensionUI({
        type: "extension_ui_request",
        id: "ui-2",
        method: "select",
        title: "Choose an option",
        options: ["Option A", "Option B"],
      } as RpcExtensionUIRequest);

      const requestId = yield* Deferred.await(opened);
      const events0 = yield* Ref.get(store);
      const requested = events0.find((event) => event.type === "user-input.requested");
      expect(requested).toBeDefined();
      if (requested && requested.type === "user-input.requested") {
        const questionId = requested.payload.questions[0]?.id;
        expect(questionId).toBeDefined();
        fake.failNextWrite();
        const firstAttempt = yield* adapter
          .respondToUserInput(threadId, requestId, {
            [String(questionId)]: "Option A",
          })
          .pipe(Effect.exit);
        expect(Exit.isFailure(firstAttempt)).toBe(true);
        expect(fake.extensionResponses).toHaveLength(0);

        yield* adapter.respondToUserInput(threadId, requestId, {
          [String(questionId)]: "Option A",
        });
      }
      yield* Deferred.await(resolved);
      yield* Fiber.interrupt(fiber);

      expect(
        fake.extensionResponses.some(
          (response) => "value" in response && response.value === "Option A",
        ),
      ).toBe(true);
    }),
  );

  it.effect("fails closed when the approval gate does not load", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      fake.setResponse(
        "get_commands",
        asResponse({
          type: "response",
          id: "x",
          command: "get_commands",
          success: true,
          data: { commands: [] },
        }),
      );
      const threadId = ThreadId.make("pi-int-failclosed");
      const result = yield* adapter
        .startSession({
          threadId,
          provider: PI,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(String(result.failure.message)).toMatch(/approval gate|ungated/i);
      }
    }),
  );

  it.effect("clears a stale resume cursor when rollback cannot read the new session file", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-rollback-cursor");
      const started = yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      expect(started.resumeCursor).toEqual({ sessionFile: "/tmp/pi-session.json" });

      fake.setResponse(
        "get_fork_messages",
        asResponse({
          type: "response",
          id: "x",
          command: "get_fork_messages",
          success: true,
          data: {
            messages: [
              { entryId: "entry-1", text: "first" },
              { entryId: "entry-2", text: "second" },
            ],
          },
        }),
      );
      fake.setResponse(
        "fork",
        asResponse({
          type: "response",
          id: "x",
          command: "fork",
          success: true,
          data: { cancelled: false },
        }),
      );
      fake.setResponse(
        "get_state",
        asResponse({
          type: "response",
          id: "x",
          command: "get_state",
          success: true,
          data: {},
        }),
      );

      yield* adapter.rollbackThread(threadId, 1);

      const sessions = yield* adapter.listSessions();
      expect(sessions[0]?.resumeCursor).toBeUndefined();
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("preserves local turns when Pi rollback history cannot be read", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-rollback-history-failure");
      const collected = yield* collectEvents(
        adapter,
        threadId,
        (event) => event.type === "turn.completed",
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "keep this turn", attachments: [] });
      yield* fake.pushEvent({ type: "agent_end" } as AgentSessionEvent);
      yield* Fiber.join(collected.fiber);

      const beforeRollback = yield* adapter.readThread(threadId);
      expect(beforeRollback.turns).toHaveLength(1);

      fake.setResponse(
        "get_fork_messages",
        asResponse({
          type: "response",
          id: "x",
          command: "get_fork_messages",
          success: false,
          error: "history unavailable",
        }),
      );
      const result = yield* adapter.rollbackThread(threadId, 1).pipe(Effect.result);

      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "ProviderAdapterRequestError",
          method: "get_fork_messages",
        });
      }
      const afterRollback = yield* adapter.readThread(threadId);
      expect(afterRollback.turns).toHaveLength(1);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when the provider does not match", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-mismatch");
      const result = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("codex"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
    }),
  );

  it.effect("steers a running turn instead of opening a second turn", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-steer");
      const store = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.runForEach((event) => Ref.update(store, (events) => [...events, event])),
        Effect.forkChild,
      );
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const first = yield* adapter.sendTurn({ threadId, input: "first", attachments: [] });
      yield* fake.pushEvent({ type: "turn_start" } as AgentSessionEvent);
      const second = yield* adapter.sendTurn({ threadId, input: "steer me", attachments: [] });
      expect(second.turnId).toBe(first.turnId);

      yield* fake.pushEvent({ type: "agent_end" } as AgentSessionEvent);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(fiber);

      const events = yield* Ref.get(store);
      const turnStarts = events.filter((event) => event.type === "turn.started");
      expect(turnStarts.length).toBe(1);
      expect(fake.commands.some((command) => command.type === "steer")).toBe(true);
    }),
  );

  it.effect("serializes concurrent sends into one prompt followed by a steer", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-concurrent-send");
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      fake.setResponse(
        "set_model",
        asResponse({
          type: "response",
          id: "x",
          command: "set_model",
          success: true,
          data: {},
        }),
      );
      const enteredSetModel = yield* Deferred.make<void>();
      const releaseSetModel = yield* Deferred.make<void>();
      fake.gateRequests("set_model", enteredSetModel, releaseSetModel);
      const modelSelection = {
        instanceId: ProviderInstanceId.make("pi"),
        model: "anthropic/claude-test",
      };

      const sendsFiber = yield* Effect.all(
        [
          adapter.sendTurn({
            threadId,
            input: "first",
            attachments: [],
            modelSelection,
          }),
          adapter.sendTurn({
            threadId,
            input: "second",
            attachments: [],
            modelSelection,
          }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);

      yield* Deferred.await(enteredSetModel);
      yield* Effect.yieldNow;
      const modelRequestsBeforeRelease = fake.commands.filter(
        (command) => command.type === "set_model",
      ).length;
      yield* Deferred.succeed(releaseSetModel, undefined).pipe(Effect.ignore);
      const results = yield* Fiber.join(sendsFiber);

      const turnCommands = fake.commands.filter(
        (command): command is PiTurnCommand =>
          command.type === "prompt" || command.type === "steer",
      );
      expect(modelRequestsBeforeRelease).toBe(1);
      expect(results[1].turnId).toBe(results[0].turnId);
      expect(turnCommands.map((command) => command.type)).toEqual(["prompt", "steer"]);
      expect(turnCommands.map((command) => command.message).sort()).toEqual(["first", "second"]);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("exposes the selected model in fresh-turn turn.started.payload", () =>
    Effect.gen(function* () {
      const { adapter } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-turn-started-model");
      const store = yield* Ref.make<Array<ProviderRuntimeEvent>>([]);
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "turn.started"),
        Stream.runForEach((event) => Ref.update(store, (events) => [...events, event])),
        Effect.forkChild,
      );

      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: {
          instanceId: ProviderInstanceId.make("pi"),
          model: "anthropic/claude-test",
        },
      });
      yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });

      const events = yield* Fiber.join(fiber).pipe(Effect.flatMap(() => Ref.get(store)));
      const turnStarted = events.find((event) => event.type === "turn.started");
      expect(turnStarted).toBeDefined();
      if (turnStarted && turnStarted.type === "turn.started") {
        expect(turnStarted.payload.model).toBe("anthropic/claude-test");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores thinking options selected for another provider instance", () =>
    Effect.gen(function* () {
      const { adapter, fake } = yield* makePiAdapterForTest(enabledSettings());
      const threadId = ThreadId.make("pi-int-foreign-thinking");
      yield* adapter.startSession({
        threadId,
        provider: PI,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello",
        attachments: [],
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "openai/gpt-5",
          options: [{ id: "thinking", value: "high" }],
        },
      });

      expect(fake.commands.some((command) => command.type === "set_model")).toBe(false);
      expect(fake.commands.some((command) => command.type === "set_thinking_level")).toBe(false);

      yield* adapter.stopSession(threadId);
    }),
  );
});
