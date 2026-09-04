import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ApprovalRequestId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { assert } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { makePiAgentAdapter } from "./PiAgentAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import { PiRpcClientError, type PiRpcClient, type PiRpcClientOptions } from "../pi/PiRpcClient.ts";
import type { PiRpcCommand, PiRpcEnvelope, PiRpcResponse } from "../pi/PiRpcProtocol.ts";

const threadId = ThreadId.make("thread-pi-test");
const instanceId = ProviderInstanceId.make("pi-personal");

interface FakeClient {
  readonly client: PiRpcClient;
  readonly commands: Ref.Ref<ReadonlyArray<PiRpcCommand>>;
  readonly emit: (event: PiRpcEnvelope) => Effect.Effect<void>;
  readonly fail: (error: PiRpcClientError) => Effect.Effect<void>;
}

const makeFakeClient = Effect.gen(function* () {
  const events = yield* Queue.unbounded<PiRpcEnvelope>();
  const commands = yield* Ref.make<ReadonlyArray<PiRpcCommand>>([]);
  const closed = yield* Deferred.make<never, PiRpcClientError>();
  const response = (command: PiRpcCommand): PiRpcResponse => {
    const state = {
      model: { provider: "anthropic", id: "claude-sonnet", name: "Claude Sonnet" },
      thinkingLevel: "medium",
      isStreaming: false,
      isCompacting: false,
      sessionFile: "/tmp/pi/session.jsonl",
      sessionId: "pi-session-1",
      messageCount: 0,
      pendingMessageCount: 0,
    };
    return {
      ...(command.id ? { id: command.id } : {}),
      type: "response",
      command: command.type,
      success: true,
      data:
        command.type === "get_state"
          ? state
          : command.type === "get_entries"
            ? { entries: [{ id: "entry-9" }] }
            : {},
    };
  };
  const record = (command: PiRpcCommand) =>
    Ref.update(commands, (current) => [...current, command]);
  const client: PiRpcClient = {
    request: (command) => record(command).pipe(Effect.as(response(command))),
    send: (command) => record(command),
    events: Stream.merge(Stream.fromQueue(events), Stream.fromEffect(Deferred.await(closed))),
    awaitFailure: Deferred.await(closed),
    close: Queue.shutdown(events),
  };
  return {
    client,
    commands,
    emit: (event: PiRpcEnvelope) =>
      Queue.offer(events, event).pipe(Effect.andThen(Effect.yieldNow), Effect.asVoid),
    fail: (error: PiRpcClientError) => Deferred.fail(closed, error).pipe(Effect.asVoid),
  } satisfies FakeClient;
});

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-pi-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const startEventCollector = (adapter: AwaitedAdapter) =>
  Effect.gen(function* () {
    const events = yield* Ref.make<ReadonlyArray<ProviderRuntimeEvent>>([]);
    const fiber = yield* adapter.streamEvents.pipe(
      Stream.runForEach((event) => Ref.update(events, (current) => [...current, event])),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    return { events, fiber };
  });

type AwaitedAdapter = ProviderAdapterShape<ProviderAdapterError>;

it.effect("resumes, streams a turn, and settles only on agent_settled", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeClient;
    const spawnOptions = yield* Ref.make<PiRpcClientOptions | undefined>(undefined);
    const adapter = yield* makePiAgentAdapter(
      {
        enabled: true,
        binaryPath: "~/.local/bin/pi",
        agentDir: "/tmp/pi-profile",
        sessionDir: "/tmp/pi-sessions",
      },
      {
        instanceId,
        makeClient: (options) => Ref.set(spawnOptions, options).pipe(Effect.as(fake.client)),
      },
    );
    const collected = yield* startEventCollector(adapter);

    const session = yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("piAgent"),
      providerInstanceId: instanceId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
      resumeCursor: {
        schemaVersion: 1,
        sessionFile: "/tmp/pi/old-session.jsonl",
        sessionId: "old-session",
        lastEntryId: "entry-8",
      },
    });
    assert.deepEqual(session.resumeCursor, {
      schemaVersion: 1,
      sessionFile: "/tmp/pi/session.jsonl",
      sessionId: "pi-session-1",
      lastEntryId: "entry-9",
    });
    assert.deepEqual((yield* Ref.get(spawnOptions))?.args, [
      "--mode",
      "rpc",
      "--approve",
      "--append-system-prompt",
      "You are running inside T3 Code. For multi-step work that uses tools, communicate before acting: send a concise preamble explaining what you will do, then provide brief milestone updates before each substantial tool batch or after roughly a minute of quiet work. Keep updates concrete and avoid narrating trivial actions. For simple answers that need no tools, answer directly.",
      "--session-dir",
      "/tmp/pi-sessions",
    ]);
    assert.equal((yield* Ref.get(spawnOptions))?.binaryPath, expandHomePath("~/.local/bin/pi"));
    assert.equal((yield* Ref.get(spawnOptions))?.env?.PI_CODING_AGENT_DIR, "/tmp/pi-profile");

    const turn = yield* adapter.sendTurn({
      threadId,
      input: "Build it",
      modelSelection: {
        instanceId,
        model: "anthropic/claude-opus",
        options: [{ id: "reasoningEffort", value: "high" }],
      },
    });
    yield* fake.emit({ type: "agent_start" });
    const steered = yield* adapter.sendTurn({ threadId, input: "/extension-command" });
    assert.equal(steered.turnId, turn.turnId);
    yield* fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    yield* fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello" },
    });
    yield* fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Hello" },
    });
    yield* fake.emit({
      type: "tool_execution_start",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "printf hi" },
    });
    yield* fake.emit({
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "printf hi" },
      partialResult: { content: [{ type: "text", text: "h" }] },
    });
    yield* fake.emit({
      type: "tool_execution_update",
      toolCallId: "tool-1",
      toolName: "bash",
      args: { command: "printf hi" },
      partialResult: { content: [{ type: "text", text: "hi" }] },
    });
    yield* fake.emit({
      type: "tool_execution_end",
      toolCallId: "tool-1",
      toolName: "bash",
      result: { content: [{ type: "text", text: "hi" }] },
      isError: false,
    });
    yield* fake.emit({ type: "agent_end", willRetry: true });
    yield* Effect.yieldNow;
    assert.isFalse(
      (yield* Ref.get(collected.events)).some((event) => event.type === "turn.completed"),
    );
    yield* fake.emit({ type: "agent_start" });
    yield* fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_start", contentIndex: 0 },
    });
    yield* fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Recovered" },
    });
    yield* fake.emit({
      type: "message_update",
      assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "Recovered" },
    });

    const completed = yield* Deferred.make<void>();
    const completionWatcher = yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.type === "turn.completed" && event.turnId === turn.turnId),
      Stream.take(1),
      Stream.runDrain,
      Effect.tap(() => Deferred.succeed(completed, undefined)),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;
    yield* fake.emit({ type: "agent_settled" });
    yield* Deferred.await(completed);
    yield* Fiber.interrupt(completionWatcher);

    const events = yield* Ref.get(collected.events);
    assert.isTrue(events.some((event) => event.type === "turn.started"));
    const assistantItemIds = events.flatMap((event) =>
      event.type === "item.started" && event.payload.itemType === "assistant_message"
        ? [event.itemId]
        : [],
    );
    assert.lengthOf(assistantItemIds, 2);
    assert.equal(new Set(assistantItemIds).size, 2);
    assert.isTrue(
      events.some(
        (event) =>
          event.type === "content.delta" &&
          event.payload.streamKind === "assistant_text" &&
          event.payload.delta === "Hello",
      ),
    );
    assert.deepEqual(
      events
        .filter(
          (event) =>
            event.type === "content.delta" && event.payload.streamKind === "command_output",
        )
        .map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
      ["h", "i"],
    );
    assert.isTrue(
      events.some(
        (event) =>
          event.type === "turn.completed" &&
          event.turnId === turn.turnId &&
          event.payload.state === "completed",
      ),
    );
    assert.deepEqual(
      (yield* Ref.get(fake.commands)).map((command) => command.type),
      [
        "switch_session",
        "get_state",
        "get_entries",
        "set_model",
        "set_thinking_level",
        "prompt",
        "prompt",
      ],
    );
    assert.deepEqual((yield* Ref.get(fake.commands))[2], {
      type: "get_entries",
      since: "entry-8",
    });
    assert.deepEqual((yield* Ref.get(fake.commands)).at(-1), {
      type: "prompt",
      message: "/extension-command",
      streamingBehavior: "steer",
    });
    yield* Fiber.interrupt(collected.fiber);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("uses the final assistant stop reason when an agent run settles", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeClient;
    const adapter = yield* makePiAgentAdapter(
      { enabled: true, binaryPath: "pi", agentDir: "", sessionDir: "" },
      { instanceId, makeClient: () => Effect.succeed(fake.client) },
    );
    const collected = yield* startEventCollector(adapter);
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("piAgent"),
      providerInstanceId: instanceId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    const retriedTurn = yield* adapter.sendTurn({ threadId, input: "Retry if needed" });
    yield* fake.emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Temporary model failure",
        },
      ],
      willRetry: true,
    });
    yield* fake.emit({ type: "agent_start" });
    yield* fake.emit({
      type: "agent_end",
      messages: [{ role: "assistant", stopReason: "stop" }],
      willRetry: false,
    });
    yield* fake.emit({ type: "agent_settled" });
    yield* Effect.yieldNow;

    const failedTurn = yield* adapter.sendTurn({ threadId, input: "Surface the failure" });
    yield* fake.emit({
      type: "agent_end",
      messages: [
        {
          role: "assistant",
          stopReason: "error",
          errorMessage: "Model credentials expired",
        },
      ],
      willRetry: false,
    });
    yield* fake.emit({ type: "agent_settled" });
    yield* Effect.yieldNow;

    const completions = (yield* Ref.get(collected.events)).filter(
      (event) => event.type === "turn.completed",
    );
    assert.deepEqual(completions.find((event) => event.turnId === retriedTurn.turnId)?.payload, {
      state: "completed",
      stopReason: "stop",
    });
    assert.deepEqual(completions.find((event) => event.turnId === failedTurn.turnId)?.payload, {
      state: "failed",
      stopReason: "error",
      errorMessage: "Model credentials expired",
    });
    yield* Fiber.interrupt(collected.fiber);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("dispatches a composer $skill through Pi's native manual-skill command", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeClient;
    const client: PiRpcClient = {
      ...fake.client,
      request: (command) =>
        command.type === "get_commands"
          ? fake.client.send(command).pipe(
              Effect.as({
                ...(command.id ? { id: command.id } : {}),
                type: "response" as const,
                command: command.type,
                success: true,
                data: {
                  commands: [
                    {
                      name: "skill:html-communicator",
                      source: "skill",
                      sourceInfo: { path: "/tmp/skills/html-communicator/SKILL.md" },
                    },
                  ],
                },
              }),
            )
          : fake.client.request(command),
    };
    const adapter = yield* makePiAgentAdapter(
      { enabled: true, binaryPath: "pi", agentDir: "", sessionDir: "" },
      { instanceId, makeClient: () => Effect.succeed(client) },
    );
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("piAgent"),
      providerInstanceId: instanceId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    yield* adapter.sendTurn({
      threadId,
      input: "Please $html-communicator create a short report",
    });

    assert.deepEqual((yield* Ref.get(fake.commands)).slice(-2), [
      { type: "get_commands" },
      {
        type: "prompt",
        message: "/skill:html-communicator Please create a short report",
      },
    ]);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("clears a newly started turn when Pi rejects its prompt", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeClient;
    const rejectingClient: PiRpcClient = {
      ...fake.client,
      request: (command) =>
        command.type === "prompt"
          ? fake.client.request(command).pipe(
              Effect.andThen(
                Effect.fail(
                  new PiRpcClientError({
                    operation: "request",
                    detail: "Prompt was rejected",
                  }),
                ),
              ),
            )
          : fake.client.request(command),
    };
    const adapter = yield* makePiAgentAdapter(
      { enabled: true, binaryPath: "pi", agentDir: "", sessionDir: "" },
      { instanceId, makeClient: () => Effect.succeed(rejectingClient) },
    );
    const collected = yield* startEventCollector(adapter);
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("piAgent"),
      providerInstanceId: instanceId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });

    const firstError = yield* adapter
      .sendTurn({ threadId, input: "First rejected prompt" })
      .pipe(Effect.flip);
    const secondError = yield* adapter
      .sendTurn({ threadId, input: "Second rejected prompt" })
      .pipe(Effect.flip);
    assert.equal(firstError._tag, "ProviderAdapterRequestError");
    assert.equal(secondError._tag, "ProviderAdapterRequestError");
    assert.deepEqual((yield* Ref.get(fake.commands)).slice(-2), [
      { type: "prompt", message: "First rejected prompt" },
      { type: "prompt", message: "Second rejected prompt" },
    ]);
    assert.deepEqual(
      (yield* adapter.listSessions()).map(({ status, activeTurnId }) => ({
        status,
        activeTurnId,
      })),
      [{ status: "error", activeTurnId: undefined }],
    );
    assert.equal(
      (yield* Ref.get(collected.events)).filter(
        (event) => event.type === "turn.completed" && event.payload.state === "failed",
      ).length,
      2,
    );
    yield* Fiber.interrupt(collected.fiber);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("round-trips Pi extension dialogs and interrupts an active turn", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeClient;
    const adapter = yield* makePiAgentAdapter(
      { enabled: true, binaryPath: "pi", agentDir: "", sessionDir: "" },
      { instanceId, makeClient: () => Effect.succeed(fake.client) },
    );
    const collected = yield* startEventCollector(adapter);
    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("piAgent"),
      providerInstanceId: instanceId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });
    yield* fake.emit({
      type: "extension_ui_request",
      id: "confirm-1",
      method: "confirm",
      title: "Proceed?",
      message: "Run deployment",
    });
    yield* Effect.yieldNow;
    yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("confirm-1"), "accept");
    yield* fake.emit({
      type: "extension_ui_request",
      id: "input-1",
      method: "input",
      title: "Branch name",
      placeholder: "feat/name",
    });
    yield* Effect.yieldNow;
    yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("input-1"), {
      value: "feat/pi",
    });
    const turn = yield* adapter.sendTurn({ threadId, input: "Keep going" });
    yield* adapter.interruptTurn(threadId, turn.turnId);
    yield* fake.emit({ type: "agent_settled" });
    yield* Effect.yieldNow;

    const commands = yield* Ref.get(fake.commands);
    assert.deepEqual(commands.slice(-5), [
      { type: "extension_ui_response", id: "confirm-1", confirmed: true },
      { type: "extension_ui_response", id: "input-1", value: "feat/pi" },
      { type: "prompt", message: "Keep going" },
      { type: "clear_queue" },
      { type: "abort" },
    ]);
    const events = yield* Ref.get(collected.events);
    assert.isTrue(events.some((event) => event.type === "request.opened"));
    assert.isTrue(events.some((event) => event.type === "request.resolved"));
    assert.isTrue(events.some((event) => event.type === "user-input.requested"));
    assert.isTrue(events.some((event) => event.type === "user-input.resolved"));
    assert.isTrue(
      events.some((event) => event.type === "turn.aborted" && event.turnId === turn.turnId),
    );
    assert.isFalse(
      events.some((event) => event.type === "turn.completed" && event.turnId === turn.turnId),
    );
    yield* Fiber.interrupt(collected.fiber);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("rejects Pi modes that RPC cannot enforce without a policy bridge", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeClient;
    const adapter = yield* makePiAgentAdapter(
      { enabled: true, binaryPath: "pi", agentDir: "", sessionDir: "" },
      { instanceId, makeClient: () => Effect.succeed(fake.client) },
    );
    const error = yield* adapter
      .startSession({
        threadId,
        provider: ProviderDriverKind.make("piAgent"),
        providerInstanceId: instanceId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      })
      .pipe(Effect.flip);
    assert.equal(error._tag, "ProviderAdapterValidationError");
    assert.match(error.message, /full-access/i);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("removes a session after the Pi RPC transport fails", () =>
  Effect.gen(function* () {
    const fake = yield* makeFakeClient;
    const adapter = yield* makePiAgentAdapter(
      { enabled: true, binaryPath: "pi", agentDir: "", sessionDir: "" },
      { instanceId, makeClient: () => Effect.succeed(fake.client) },
    );
    const exited = yield* Deferred.make<void>();
    const watcher = yield* adapter.streamEvents.pipe(
      Stream.filter(
        (event) => event.type === "session.exited" && event.payload.exitKind === "error",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.tap(() => Deferred.succeed(exited, undefined)),
      Effect.forkChild,
    );
    yield* Effect.yieldNow;

    yield* adapter.startSession({
      threadId,
      provider: ProviderDriverKind.make("piAgent"),
      providerInstanceId: instanceId,
      cwd: process.cwd(),
      runtimeMode: "full-access",
    });
    yield* fake.fail(
      new PiRpcClientError({ operation: "process-exit", detail: "Pi exited unexpectedly" }),
    );
    yield* Deferred.await(exited);

    assert.isFalse(yield* adapter.hasSession(threadId));
    assert.deepEqual(yield* adapter.listSessions(), []);
    yield* Fiber.interrupt(watcher);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);

it.effect("serializes concurrent starts for the same thread", () =>
  Effect.gen(function* () {
    const first = yield* makeFakeClient;
    const second = yield* makeFakeClient;
    const firstFactoryEntered = yield* Deferred.make<void>();
    const releaseFirstFactory = yield* Deferred.make<void>();
    const factoryCalls = yield* Ref.make(0);
    const adapter = yield* makePiAgentAdapter(
      { enabled: true, binaryPath: "pi", agentDir: "", sessionDir: "" },
      {
        instanceId,
        makeClient: () =>
          Ref.updateAndGet(factoryCalls, (count) => count + 1).pipe(
            Effect.flatMap((call) =>
              call === 1
                ? Deferred.succeed(firstFactoryEntered, undefined).pipe(
                    Effect.andThen(Deferred.await(releaseFirstFactory)),
                    Effect.as(first.client),
                  )
                : Effect.succeed(second.client),
            ),
          ),
      },
    );
    const start = () =>
      adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("piAgent"),
        providerInstanceId: instanceId,
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

    const firstStart = yield* start().pipe(Effect.forkChild);
    yield* Deferred.await(firstFactoryEntered);
    const secondStart = yield* start().pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    const callsBeforeRelease = yield* Ref.get(factoryCalls);
    yield* Effect.sync(() => assert.equal(callsBeforeRelease, 1)).pipe(
      Effect.ensuring(Deferred.succeed(releaseFirstFactory, undefined)),
    );
    yield* Fiber.join(firstStart);
    yield* Fiber.join(secondStart);
    assert.equal(yield* Ref.get(factoryCalls), 2);
    assert.isTrue(yield* adapter.hasSession(threadId));
    assert.lengthOf(yield* adapter.listSessions(), 1);
  }).pipe(Effect.scoped, Effect.provide(testLayer)),
);
