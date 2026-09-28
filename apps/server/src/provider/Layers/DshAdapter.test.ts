// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as EffectAcpSchema from "effect-acp/schema";
import {
  ApprovalRequestId,
  DshSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import {
  dshPromptSettlementBelongsToContext,
  makeDshAdapter,
  selectDshPermissionOptionId,
} from "./DshAdapter.ts";

const decodeDshSettings = Schema.decodeSync(DshSettings);
const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");

async function makeMockDshWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dsh-acp-mock-"));
  return writeFakeCli({
    directory: dir,
    name: "fake-dsh",
    env: extraEnv ?? {},
    source: execScriptSource({ scriptPath: mockAgentPath }),
  });
}

const readJsonRpcRequests = async (filePath: string) => {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
};

const dshAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-dsh-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string) =>
  makeDshAdapter(decodeDshSettings({ binaryPath }), {}).pipe(Effect.orDie);

it("maps approval decisions to DSH permission option ids", () => {
  const request: EffectAcpSchema.RequestPermissionRequest = {
    sessionId: "s1",
    toolCall: { title: "Run tool", toolCallId: "tool-1" },
    options: [
      { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
      { kind: "allow_always", name: "Always allow", optionId: "allow-always" },
      { kind: "reject_once", name: "Reject", optionId: "reject-once" },
    ],
  };

  assert.equal(selectDshPermissionOptionId(request, "accept"), "allow-once");
  assert.equal(selectDshPermissionOptionId(request, "acceptForSession"), "allow-always");
  assert.equal(selectDshPermissionOptionId(request, "acceptAlways"), "allow-always");
  assert.equal(selectDshPermissionOptionId(request, "decline"), "reject-once");
});

it("falls back to allow_once when the request has no allow_always", () => {
  const request: EffectAcpSchema.RequestPermissionRequest = {
    sessionId: "s1",
    toolCall: { title: "Run tool", toolCallId: "tool-1" },
    options: [
      { kind: "allow_once", name: "Allow once", optionId: "allow-once" },
      { kind: "reject_once", name: "Reject", optionId: "reject-once" },
    ],
  };

  assert.equal(selectDshPermissionOptionId(request, "acceptForSession"), "allow-once");
  assert.equal(selectDshPermissionOptionId(request, "accept"), "allow-once");
});

it("returns undefined when no matching permission option exists", () => {
  const rejectOnly: EffectAcpSchema.RequestPermissionRequest = {
    sessionId: "s1",
    toolCall: { title: "Run tool", toolCallId: "tool-1" },
    options: [{ kind: "reject_once", name: "Reject", optionId: "reject-once" }],
  };

  assert.equal(selectDshPermissionOptionId(rejectOnly, "accept"), undefined);
  assert.equal(selectDshPermissionOptionId(rejectOnly, "acceptForSession"), undefined);

  const blankIds: EffectAcpSchema.RequestPermissionRequest = {
    sessionId: "s1",
    toolCall: { title: "Run tool", toolCallId: "tool-1" },
    options: [{ kind: "allow_once", name: "Allow once", optionId: "   " }],
  };

  assert.equal(selectDshPermissionOptionId(blankIds, "accept"), undefined);
  assert.equal(selectDshPermissionOptionId(blankIds, "acceptForSession"), undefined);

  const noOptions: EffectAcpSchema.RequestPermissionRequest = {
    sessionId: "s1",
    toolCall: { title: "Run tool", toolCallId: "tool-1" },
    options: [],
  };
  assert.equal(selectDshPermissionOptionId(noOptions, "decline"), undefined);
});

it("only accepts prompt settlements from the same ACP session and turn", () => {
  const turnId = TurnId.make("turn-1");

  assert.isTrue(
    dshPromptSettlementBelongsToContext({
      liveAcpSessionId: "mock-session-1",
      expectedAcpSessionId: "mock-session-1",
      liveActiveTurnId: turnId,
      liveSessionActiveTurnId: undefined,
      turnId,
    }),
  );
  assert.isTrue(
    dshPromptSettlementBelongsToContext({
      liveAcpSessionId: "mock-session-1",
      expectedAcpSessionId: "mock-session-1",
      liveActiveTurnId: undefined,
      liveSessionActiveTurnId: turnId,
      turnId,
    }),
  );
  assert.isFalse(
    dshPromptSettlementBelongsToContext({
      liveAcpSessionId: "mock-session-2",
      expectedAcpSessionId: "mock-session-1",
      liveActiveTurnId: turnId,
      liveSessionActiveTurnId: turnId,
      turnId,
    }),
  );
  assert.isFalse(
    dshPromptSettlementBelongsToContext({
      liveAcpSessionId: "mock-session-1",
      expectedAcpSessionId: "mock-session-1",
      liveActiveTurnId: undefined,
      liveSessionActiveTurnId: undefined,
      turnId,
    }),
  );
  assert.isFalse(
    dshPromptSettlementBelongsToContext({
      liveAcpSessionId: "mock-session-1",
      expectedAcpSessionId: "mock-session-1",
      liveActiveTurnId: TurnId.make("turn-2"),
      liveSessionActiveTurnId: TurnId.make("turn-3"),
      turnId,
    }),
  );
});

it.layer(dshAdapterTestLayer)("DshAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("dsh-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockDshWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("dsh"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("dsh"), model: "composer-2" },
      });

      assert.equal(session.provider, "dsh");
      assert.equal(session.model, "composer-2");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello dsh",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockDshWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("dsh-provider-mismatch");

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("dsh"), model: "default" },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects startSession with a blank cwd", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockDshWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("dsh-blank-cwd");

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("dsh"),
          cwd: "   ",
          runtimeMode: "full-access",
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("resumes an existing DSH session through session/resume", () =>
    Effect.gen(function* () {
      const logDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "dsh-resume-log-")),
      );
      const requestLogPath = NodePath.join(logDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDshWrapper({ T3_ACP_REQUEST_LOG_PATH: requestLogPath }),
      );

      const firstThread = ThreadId.make("dsh-resume-first");
      const firstAdapter = yield* makeTestAdapter(wrapperPath);
      const firstSession = yield* firstAdapter.startSession({
        threadId: firstThread,
        provider: ProviderDriverKind.make("dsh"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("dsh"), model: "default" },
      });
      assert.deepStrictEqual(firstSession.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      yield* firstAdapter.stopSession(firstThread);

      const resumedThread = ThreadId.make("dsh-resume-second");
      const resumedAdapter = yield* makeTestAdapter(wrapperPath);
      const resumedSession = yield* resumedAdapter.startSession({
        threadId: resumedThread,
        provider: ProviderDriverKind.make("dsh"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("dsh"), model: "default" },
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });
      // The resumed session keeps the agent's session id; no new session is opened.
      assert.deepStrictEqual(resumedSession.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      yield* resumedAdapter.stopSession(resumedThread);

      const requests = yield* Effect.promise(() => readJsonRpcRequests(requestLogPath));
      const resumeRequest = requests.find((request) => request.method === "session/resume");
      assert.isDefined(resumeRequest);
      assert.equal(resumeRequest?.params?.sessionId, "mock-session-1");
      // DSH has no session/load; resume must be the only restore path.
      assert.isUndefined(requests.find((request) => request.method === "session/load"));
    }),
  );

  it.effect("surfaces a manual approval request and settles the turn after accept", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("dsh-permission");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockDshWrapper({ T3_ACP_EMIT_TOOL_CALLS: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "request.opened"
              ? Deferred.succeed(requestOpened, event)
              : event.type === "turn.completed"
                ? Deferred.succeed(turnCompleted, undefined)
                : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("dsh"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("dsh"), model: "default" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "hello dsh", attachments: [] })
        .pipe(Effect.forkChild);
      const opened = yield* Deferred.await(requestOpened);
      assert.equal(opened.type, "request.opened");
      assert.isDefined(opened.requestId);
      assert.isTrue((opened.payload.detail ?? "").length > 0);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(opened.requestId)),
        "accept",
      );
      yield* Fiber.join(sendTurnFiber);
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);

      const types = runtimeEvents.map((event) => event.type);
      assert.includeMembers(types, [
        "turn.started",
        "request.opened",
        "request.resolved",
        "content.delta",
        "turn.completed",
      ] as const);

      const resolved = runtimeEvents.find((event) => event.type === "request.resolved");
      assert.isDefined(resolved);
      if (resolved?.type === "request.resolved") {
        assert.equal(resolved.payload.decision, "accept");
      }
      const delta = runtimeEvents.find((event) => event.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }
      const completed = runtimeEvents.find((event) => event.type === "turn.completed");
      assert.isDefined(completed);
      if (completed?.type === "turn.completed") {
        assert.equal(completed.payload.state, "completed");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "settles the turn when the agent omits allow_always and the user accepts for the session",
    () =>
      Effect.gen(function* () {
        const threadId = ThreadId.make("dsh-permission-fallback");
        const wrapperPath = yield* Effect.promise(() =>
          makeMockDshWrapper({
            T3_ACP_EMIT_TOOL_CALLS: "1",
            T3_ACP_OMIT_ALLOW_ALWAYS: "1",
          }),
        );
        const adapter = yield* makeTestAdapter(wrapperPath);

        const runtimeEvents: ProviderRuntimeEvent[] = [];
        const requestOpened =
          yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
        const turnCompleted = yield* Deferred.make<void>();
        const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
          Effect.sync(() => {
            runtimeEvents.push(event);
          }).pipe(
            Effect.andThen(
              event.type === "request.opened"
                ? Deferred.succeed(requestOpened, event)
                : event.type === "turn.completed"
                  ? Deferred.succeed(turnCompleted, undefined)
                  : Effect.void,
            ),
          ),
        ).pipe(Effect.forkChild);

        yield* adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("dsh"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: { instanceId: ProviderInstanceId.make("dsh"), model: "default" },
        });

        const sendTurnFiber = yield* adapter
          .sendTurn({ threadId, input: "hello dsh", attachments: [] })
          .pipe(Effect.forkChild);
        const opened = yield* Deferred.await(requestOpened);
        assert.isDefined(opened.requestId);

        // With no allow_always option, acceptForSession must fall back to
        // allow_once instead of cancelling the tool call.
        yield* adapter.respondToRequest(
          threadId,
          ApprovalRequestId.make(String(opened.requestId)),
          "acceptForSession",
        );
        yield* Fiber.join(sendTurnFiber);
        yield* Deferred.await(turnCompleted);
        yield* Fiber.interrupt(runtimeEventsFiber);

        const completed = runtimeEvents.find((event) => event.type === "turn.completed");
        assert.isDefined(completed);
        if (completed?.type === "turn.completed") {
          assert.equal(completed.payload.state, "completed");
          assert.equal(completed.payload.stopReason, "end_turn");
        }

        yield* adapter.stopSession(threadId);
      }),
  );
});
