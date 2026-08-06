// @effect-diagnostics nodeBuiltinImport:off
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  OpenClawSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSessionStartInput,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import {
  type OpenClawGatewayConnection,
  OpenClawRuntime,
  OpenClawRuntimeError,
  OpenClawRuntimeLive,
} from "../openclawRuntime.ts";
import { startMockOpenClawGateway } from "../testUtils/openclawMockGateway.ts";
import {
  isOpenClawSessionNotFound,
  makeOpenClawAdapter,
  type OpenClawGatewayHolder,
  parseOpenClawResume,
} from "./OpenClawAdapter.ts";

const decodeOpenClawSettings = Schema.decodeSync(OpenClawSettings);

const openClawAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-openclaw-adapter-test-",
}).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(OpenClawRuntimeLive.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer)))),
);

/**
 * A holder that connects every acquire to the given mock gateway URL. The
 * connection is cached so the adapter's event pump and its RPC calls share
 * one socket, exactly like the driver-owned holder does. The scope is a
 * throwaway used only to satisfy the runtime's connect signature; external
 * gateway connections do not register process finalizers on it.
 */
const makeTestGatewayHolder = (
  url: string,
): Effect.Effect<OpenClawGatewayHolder, never, OpenClawRuntime> =>
  Effect.gen(function* () {
    const runtime = yield* OpenClawRuntime;
    const gatewayScope = yield* Scope.make();
    let cached: OpenClawGatewayConnection | undefined;
    return {
      acquire: (input) =>
        Effect.gen(function* () {
          if (cached) {
            return cached;
          }
          const connection = yield* runtime
            .connectToOpenClawGateway({
              binaryPath: input.binaryPath,
              gatewayUrl: url,
              ...(input.gatewayToken?.trim() ? { gatewayToken: input.gatewayToken } : {}),
            })
            .pipe(Effect.provideService(Scope.Scope, gatewayScope));
          cached = connection;
          return connection;
        }),
    };
  });

const makeTestAdapter = (url: string) =>
  Effect.gen(function* () {
    const gateway = yield* makeTestGatewayHolder(url);
    return yield* makeOpenClawAdapter(decodeOpenClawSettings({}), { gateway }).pipe(Effect.orDie);
  });

const startSessionInput = (
  threadId: ThreadId,
  resumeCursor?: unknown,
): ProviderSessionStartInput => ({
  threadId,
  provider: ProviderDriverKind.make("openclaw"),
  cwd: process.cwd(),
  runtimeMode: "full-access",
  modelSelection: {
    instanceId: ProviderInstanceId.make("openclaw"),
    model: "anthropic/claude-sonnet-4-6",
  },
  ...(resumeCursor !== undefined ? { resumeCursor } : {}),
});

interface EventTracker {
  readonly events: ProviderRuntimeEvent[];
  readonly fiber: Fiber.Fiber<void, never>;
  /** Resolves once every type in `doneTypes` has been seen for the thread. */
  readonly done: Deferred.Deferred<void, never>;
}

/**
 * One subscriber on the adapter event stream. Tests must never open a second
 * consumer on the same queue — items would be split between them.
 */
const trackEvents = (
  stream: Stream.Stream<ProviderRuntimeEvent>,
  threadId: ThreadId,
  doneTypes: ReadonlyArray<string>,
  onEvent?: (event: ProviderRuntimeEvent) => Effect.Effect<void>,
): Effect.Effect<EventTracker, never> =>
  Effect.gen(function* () {
    const events: ProviderRuntimeEvent[] = [];
    const seen = new Set<string>();
    const done = yield* Deferred.make<void>();
    const fiber = yield* Stream.runForEach(stream, (event) =>
      Effect.sync(() => {
        events.push(event);
        if (String(event.threadId) === String(threadId) && doneTypes.includes(event.type)) {
          seen.add(event.type);
        }
      }).pipe(
        Effect.andThen(() =>
          String(event.threadId) === String(threadId) && onEvent !== undefined
            ? onEvent(event)
            : Effect.void,
        ),
        Effect.andThen(() =>
          doneTypes.every((type) => seen.has(type))
            ? Deferred.succeed(done, undefined).pipe(Effect.ignore)
            : Effect.void,
        ),
      ),
    ).pipe(Effect.forkChild);
    return { events, fiber, done };
  });

const findThreadEvent = <T extends ProviderRuntimeEvent["type"]>(
  events: ProviderRuntimeEvent[],
  threadId: ThreadId,
  type: T,
) =>
  events.find(
    (event): event is Extract<ProviderRuntimeEvent, { type: T }> =>
      event.type === type && String(event.threadId) === String(threadId),
  );

it("parses a versioned resume cursor and rejects stale or malformed values", () => {
  assert.deepEqual(parseOpenClawResume({ schemaVersion: 1, sessionId: "sess-1" }), {
    sessionId: "sess-1",
  });
  assert.deepEqual(parseOpenClawResume({ schemaVersion: 1, sessionId: "  sess-1  " }), {
    sessionId: "sess-1",
  });
  assert.isUndefined(parseOpenClawResume({ schemaVersion: 2, sessionId: "sess-1" }));
  assert.isUndefined(parseOpenClawResume({ schemaVersion: 1, sessionId: "   " }));
  assert.isUndefined(parseOpenClawResume({ schemaVersion: 1 }));
  assert.isUndefined(parseOpenClawResume(undefined));
  assert.isUndefined(parseOpenClawResume(null));
  assert.isUndefined(parseOpenClawResume("garbage"));
  assert.isUndefined(parseOpenClawResume([1, 2]));
});

it("recognizes NOT_FOUND-family codes only when deciding a session is gone", () => {
  assert.isTrue(isOpenClawSessionNotFound({ code: "NOT_FOUND" }));
  assert.isTrue(isOpenClawSessionNotFound({ code: "SESSION_NOT_FOUND" }));
  assert.isTrue(isOpenClawSessionNotFound({ code: "NOT_FOUND", message: "missing" }));
  assert.isTrue(isOpenClawSessionNotFound({ details: { code: "NOT_FOUND" } }));
  // The runtime wraps gateway failures in OpenClawRuntimeError and keeps the
  // structured code in `cause`; that must still count as a confirmed miss.
  assert.isTrue(
    isOpenClawSessionNotFound(
      new OpenClawRuntimeError({
        operation: "sessions.describe",
        detail: "NOT_FOUND: mock session not found",
        cause: { code: "NOT_FOUND", message: "mock session not found" },
      }),
    ),
  );
  assert.isFalse(isOpenClawSessionNotFound({ code: "INTERNAL" }));
  assert.isFalse(isOpenClawSessionNotFound({ code: "UNAUTHORIZED" }));
  assert.isFalse(isOpenClawSessionNotFound({ message: "session not found" }));
  assert.isFalse(isOpenClawSessionNotFound("garbage"));
  assert.isFalse(isOpenClawSessionNotFound(undefined));
  assert.isFalse(isOpenClawSessionNotFound(null));
});

it.live("runs a full session and turn against the mock gateway", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway());
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-full-session");
    const tracker = yield* trackEvents(adapter.streamEvents, threadId, ["turn.completed"]);

    const session = yield* adapter.startSession(startSessionInput(threadId));
    assert.equal(session.provider, "openclaw");
    assert.equal(session.status, "ready");
    const sessionKey = (session.resumeCursor as { sessionId: string }).sessionId;
    assert.equal(sessionKey.startsWith("t3-"), true);

    const turn = yield* adapter.sendTurn({ threadId, input: "hello", attachments: [] });
    assert.equal(String(turn.turnId).startsWith("openclaw-turn-"), true);

    yield* Deferred.await(tracker.done);
    yield* Fiber.interrupt(tracker.fiber);

    const orderedTypes = tracker.events
      .map((event) => event.type)
      .filter((type) =>
        [
          "session.started",
          "session.configured",
          "session.state.changed",
          "thread.started",
          "turn.started",
          "content.delta",
          "turn.completed",
        ].includes(type),
      );
    assert.deepEqual(orderedTypes, [
      "session.started",
      "session.configured",
      "session.state.changed",
      "thread.started",
      "turn.started",
      "content.delta",
      "turn.completed",
    ]);

    const started = findThreadEvent(tracker.events, threadId, "session.started");
    assert.equal(started?.payload.resume, false);

    const configured = findThreadEvent(tracker.events, threadId, "session.configured");
    assert.equal(configured?.payload.config.binaryPath, "openclaw");

    const stateChanged = findThreadEvent(tracker.events, threadId, "session.state.changed");
    assert.equal(stateChanged?.payload.state, "ready");

    const threadStarted = findThreadEvent(tracker.events, threadId, "thread.started");
    assert.equal(threadStarted?.payload.providerThreadId, sessionKey);

    const delta = findThreadEvent(tracker.events, threadId, "content.delta");
    assert.equal(delta?.payload.streamKind, "assistant_text");
    assert.equal(delta?.payload.delta, "hello from mock openclaw (hello)");

    const completed = findThreadEvent(tracker.events, threadId, "turn.completed");
    assert.equal(completed?.payload.state, "completed");

    const sessions = yield* adapter.listSessions();
    assert.equal(sessions.find((entry) => entry.threadId === threadId)?.status, "ready");

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("maps thinking and tool lifecycles to reasoning and item events", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() =>
      startMockOpenClawGateway({ emitThinking: true, emitToolEvents: true }),
    );
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-tool-events");
    const tracker = yield* trackEvents(adapter.streamEvents, threadId, ["turn.completed"]);

    yield* adapter.startSession(startSessionInput(threadId));
    yield* adapter.sendTurn({ threadId, input: "use tools", attachments: [] });
    yield* Deferred.await(tracker.done);
    yield* Fiber.interrupt(tracker.fiber);

    const reasoning = findThreadEvent(tracker.events, threadId, "content.delta");
    assert.equal(reasoning?.payload.streamKind, "reasoning_text");
    assert.equal(reasoning?.payload.delta, "mock thinking");

    const itemStarted = findThreadEvent(tracker.events, threadId, "item.started");
    assert.equal(itemStarted?.itemId, "mock-call-1");
    assert.equal(itemStarted?.payload.itemType, "command_execution");
    assert.equal(itemStarted?.payload.title, "Ran command");
    assert.equal(itemStarted?.payload.status, "inProgress");

    const itemCompleted = findThreadEvent(tracker.events, threadId, "item.completed");
    assert.equal(itemCompleted?.payload.itemType, "command_execution");
    assert.equal(itemCompleted?.payload.status, "completed");

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("surfaces gateway approvals as request.opened and auto-resolved requests", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway({ emitApproval: true }));
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-approval-auto");
    const tracker = yield* trackEvents(adapter.streamEvents, threadId, ["turn.completed"]);

    yield* adapter.startSession(startSessionInput(threadId));
    yield* adapter.sendTurn({ threadId, input: "approve", attachments: [] });
    yield* Deferred.await(tracker.done);
    yield* Fiber.interrupt(tracker.fiber);

    const opened = findThreadEvent(tracker.events, threadId, "request.opened");
    assert.equal(opened?.requestId, "mock-approval-1");
    assert.equal(opened?.payload.requestType, "command_execution_approval");
    assert.equal(opened?.payload.detail, "rm -rf /tmp/x");
    assert.equal(
      opened?.payload.args !== undefined && (opened.payload.args as Record<string, unknown>).kind,
      "exec",
    );

    const resolved = findThreadEvent(tracker.events, threadId, "request.resolved");
    assert.equal(resolved?.requestId, "mock-approval-1");
    assert.equal(resolved?.payload.decision, "approved");

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("resolves a pending approval with allow when the user accepts", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() =>
      startMockOpenClawGateway({ emitApproval: true, resolveApproval: false }),
    );
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-approval-accept");
    const requestOpened = yield* Deferred.make<void>();
    const tracker = yield* trackEvents(
      adapter.streamEvents,
      threadId,
      ["turn.completed"],
      (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, undefined).pipe(Effect.ignore)
          : Effect.void,
    );

    yield* adapter.startSession(startSessionInput(threadId));
    yield* adapter.sendTurn({ threadId, input: "approve", attachments: [] });
    yield* Deferred.await(requestOpened);
    yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("mock-approval-1"), "accept");
    yield* Deferred.await(tracker.done);
    yield* Fiber.interrupt(tracker.fiber);

    const resolveFrame = mock.requests.find(
      (request) => request.method === "exec.approval.resolve",
    );
    assert.equal(
      resolveFrame?.params !== undefined && (resolveFrame.params as Record<string, unknown>).id,
      "mock-approval-1",
    );
    assert.equal(
      resolveFrame?.params !== undefined &&
        (resolveFrame.params as Record<string, unknown>).decision,
      "allow",
    );

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("resolves a pending approval with deny when the user declines", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() =>
      startMockOpenClawGateway({ emitApproval: true, resolveApproval: false }),
    );
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-approval-decline");
    const requestOpened = yield* Deferred.make<void>();
    const tracker = yield* trackEvents(
      adapter.streamEvents,
      threadId,
      ["turn.completed"],
      (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, undefined).pipe(Effect.ignore)
          : Effect.void,
    );

    yield* adapter.startSession(startSessionInput(threadId));
    yield* adapter.sendTurn({ threadId, input: "deny", attachments: [] });
    yield* Deferred.await(requestOpened);
    yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("mock-approval-1"), "decline");
    yield* Deferred.await(tracker.done);
    yield* Fiber.interrupt(tracker.fiber);

    const resolveFrame = mock.requests.find(
      (request) => request.method === "exec.approval.resolve",
    );
    assert.equal(
      resolveFrame?.params !== undefined &&
        (resolveFrame.params as Record<string, unknown>).decision,
      "deny",
    );

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("aborts a hanging run and completes the turn as interrupted", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway({ agentDelayMs: 250 }));
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-interrupt");
    const tracker = yield* trackEvents(adapter.streamEvents, threadId, ["turn.completed"]);

    const session = yield* adapter.startSession(startSessionInput(threadId));
    const sessionKey = (session.resumeCursor as { sessionId: string }).sessionId;
    const turn = yield* adapter.sendTurn({ threadId, input: "hang", attachments: [] });
    yield* adapter.interruptTurn(threadId, turn.turnId);
    yield* Deferred.await(tracker.done);
    yield* Fiber.interrupt(tracker.fiber);

    const aborts = mock.requests.filter((request) => request.method === "chat.abort");
    assert.equal(aborts.length, 1);
    assert.equal(
      aborts[0]?.params !== undefined && (aborts[0].params as Record<string, unknown>).sessionKey,
      sessionKey,
    );
    assert.equal(
      aborts[0]?.params !== undefined && (aborts[0].params as Record<string, unknown>).runId,
      "mock-run-1",
    );

    const completed = findThreadEvent(tracker.events, threadId, "turn.completed");
    assert.equal(completed?.payload.state, "interrupted");

    const sessions = yield* adapter.listSessions();
    assert.equal(sessions.find((entry) => entry.threadId === threadId)?.status, "ready");

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("fails the active turn and exits the session when the gateway closes", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway({ hangAgent: true }));
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-gateway-close");
    const tracker = yield* trackEvents(adapter.streamEvents, threadId, [
      "turn.completed",
      "session.exited",
    ]);

    yield* adapter.startSession(startSessionInput(threadId));
    yield* adapter.sendTurn({ threadId, input: "run", attachments: [] });
    yield* Effect.promise(() => mock.close());
    yield* Deferred.await(tracker.done);
    yield* Fiber.interrupt(tracker.fiber);

    const completed = findThreadEvent(tracker.events, threadId, "turn.completed");
    assert.equal(completed?.payload.state, "failed");
    assert.isString(completed?.payload.errorMessage);

    const exited = findThreadEvent(tracker.events, threadId, "session.exited");
    assert.equal(exited?.payload.exitKind, "error");
    assert.equal(exited?.payload.recoverable, false);
    assert.isString(exited?.payload.reason);

    const hasSession = yield* adapter.hasSession(threadId);
    assert.equal(hasSession, false);
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("resumes an existing gateway session from a versioned cursor", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway());
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-resume-known");
    const tracker = yield* trackEvents(adapter.streamEvents, threadId, ["session.started"]);

    const session = yield* adapter.startSession(
      startSessionInput(threadId, { schemaVersion: 1, sessionId: "known-session" }),
    );
    yield* Deferred.await(tracker.done);
    yield* Fiber.interrupt(tracker.fiber);

    assert.deepEqual(session.resumeCursor, {
      schemaVersion: 1,
      sessionId: "known-session",
    });
    assert.equal(
      mock.requests.some(
        (request) =>
          request.method === "sessions.describe" &&
          request.params !== undefined &&
          (request.params as Record<string, unknown>).key === "known-session",
      ),
      true,
    );
    assert.equal(
      mock.requests.some((request) => request.method === "sessions.create"),
      false,
    );
    const started = findThreadEvent(tracker.events, threadId, "session.started");
    assert.equal(started?.payload.resume, true);

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("starts a fresh session when the resumed gateway session is gone", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() =>
      startMockOpenClawGateway({ sessionNotFoundOnDescribe: true }),
    );
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-resume-unknown");

    const session = yield* adapter.startSession(
      startSessionInput(threadId, { schemaVersion: 1, sessionId: "gone-session" }),
    );

    const creates = mock.requests.filter((request) => request.method === "sessions.create");
    assert.equal(creates.length, 1);
    const createdKey =
      creates[0]?.params !== undefined
        ? (creates[0].params as Record<string, unknown>).key
        : undefined;
    assert.equal(typeof createdKey, "string");
    assert.equal((createdKey as string).startsWith("t3-"), true);
    assert.deepEqual(session.resumeCursor, {
      schemaVersion: 1,
      sessionId: createdKey,
    });

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("reads the thread back from chat.history grouped into turns", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway());
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-read-thread");

    yield* adapter.startSession(startSessionInput(threadId));
    const snapshot = yield* adapter.readThread(threadId);
    assert.equal(snapshot.turns.length, 1);
    assert.equal(String(snapshot.turns[0]?.id), "mock-msg-1");
    assert.equal(snapshot.turns[0]?.items.length, 2);

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("emits a graceful session.exited when a session stops", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway());
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-stop-session");
    const tracker = yield* trackEvents(adapter.streamEvents, threadId, ["session.exited"]);

    yield* adapter.startSession(startSessionInput(threadId));
    yield* adapter.stopSession(threadId);
    yield* Deferred.await(tracker.done);
    yield* Fiber.interrupt(tracker.fiber);

    const exited = findThreadEvent(tracker.events, threadId, "session.exited");
    assert.equal(exited?.payload.exitKind, "graceful");
    const hasSession = yield* adapter.hasSession(threadId);
    assert.equal(hasSession, false);

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("fails the turn when the gateway agent run errors", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway({ failAgent: true }));
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-agent-error");
    const tracker = yield* trackEvents(adapter.streamEvents, threadId, [
      "turn.completed",
      "runtime.error",
    ]);
    yield* adapter.startSession(startSessionInput(threadId));
    yield* adapter.sendTurn({ threadId, input: "fail", attachments: [] });
    yield* Deferred.await(tracker.done);
    yield* Fiber.interrupt(tracker.fiber);

    const completed = findThreadEvent(tracker.events, threadId, "turn.completed");
    assert.equal(completed?.payload.state, "failed");
    assert.equal(completed?.payload.errorMessage, "mock agent failure");

    const runtimeError = findThreadEvent(tracker.events, threadId, "runtime.error");
    assert.equal(runtimeError?.payload.message, "mock agent failure");

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("fails startSession when the gateway rejects the connection", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway({ rejectConnect: true }));
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-reject-connect");

    const error = yield* Effect.flip(adapter.startSession(startSessionInput(threadId)));
    assert.equal(error._tag, "ProviderAdapterRequestError");

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("fails startSession when the gateway cannot create the session", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway({ failSessionCreate: true }));
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-session-create-fail");

    const error = yield* Effect.flip(adapter.startSession(startSessionInput(threadId)));
    assert.equal(error._tag, "ProviderAdapterRequestError");
    if (error._tag === "ProviderAdapterRequestError") {
      assert.equal(error.method, "sessions.create");
    }

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("rejects free-text user input with a validation error", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway());
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-user-input");

    yield* adapter.startSession(startSessionInput(threadId));
    const error = yield* Effect.flip(
      adapter.respondToUserInput(threadId, ApprovalRequestId.make("req-1"), {}),
    );
    assert.equal(error._tag, "ProviderAdapterValidationError");

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("rejects turn rollback with a validation error", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway());
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-rollback");

    yield* adapter.startSession(startSessionInput(threadId));
    const error = yield* Effect.flip(adapter.rollbackThread(threadId, 1));
    assert.equal(error._tag, "ProviderAdapterValidationError");

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("rejects startSession when the provider mismatches", () =>
  Effect.gen(function* () {
    const adapter = yield* makeTestAdapter("ws://127.0.0.1:1");
    const threadId = ThreadId.make("openclaw-provider-mismatch");

    const error = yield* Effect.flip(
      adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("cursor"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      }),
    );
    assert.equal(error._tag, "ProviderAdapterValidationError");
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("rejects startSession when cwd is missing", () =>
  Effect.gen(function* () {
    const adapter = yield* makeTestAdapter("ws://127.0.0.1:1");
    const threadId = ThreadId.make("openclaw-cwd-missing");

    const error = yield* Effect.flip(
      adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("openclaw"),
        cwd: "   ",
        runtimeMode: "full-access",
      }),
    );
    assert.equal(error._tag, "ProviderAdapterValidationError");
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);

it.live("rejects sendTurn with empty input", () =>
  Effect.gen(function* () {
    const mock = yield* Effect.promise(() => startMockOpenClawGateway());
    const adapter = yield* makeTestAdapter(mock.url);
    const threadId = ThreadId.make("openclaw-empty-turn");

    yield* adapter.startSession(startSessionInput(threadId));
    const error = yield* Effect.flip(adapter.sendTurn({ threadId, input: "   ", attachments: [] }));
    assert.equal(error._tag, "ProviderAdapterValidationError");

    yield* Effect.promise(() => mock.close());
  }).pipe(Effect.provide(openClawAdapterTestLayer)),
);
