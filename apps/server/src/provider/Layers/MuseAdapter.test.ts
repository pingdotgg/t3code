import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  Connection,
  createUuidV7Mint,
  type NotificationHandler,
  type ProcessExit,
} from "@muse-code/sdk";
import {
  ApprovalRequestId,
  EnvironmentId,
  MuseSettings,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import type { MuseSdkHost, MuseSdkHostOptions } from "../museSdk.ts";
import { museModelCapabilities } from "../museModelCatalog.ts";
import { makeMuseAdapter } from "./MuseAdapter.ts";

function makeFakeHost() {
  let notify: NotificationHandler = () => {};
  let onProtocolError: Parameters<MuseSdkHost["connection"]["onProtocolError"]>[0] = () => {};
  let resolveExit = (_exit: ProcessExit) => {};
  let resolveClosed = () => {};
  const exited = new Promise<ProcessExit>((resolve) => {
    resolveExit = resolve;
  });
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  let nativeSessionId = "";
  let activeTurnId: string | undefined;
  let closeCount = 0;
  const emit = (method: string, params: Record<string, unknown>) => {
    if (method === "turn/completed") activeTurnId = undefined;
    notify({ jsonrpc: "2.0", method, params: { sessionId: nativeSessionId, ...params } });
  };
  const history: Array<Record<string, unknown>> = [];
  let historyPages:
    | Array<{ events: Array<Record<string, unknown>>; nextCursor: string | null }>
    | undefined;
  let rejectMethod: string | undefined;
  let beforeTurnAck: ((commandId?: string) => Promise<void>) | undefined;
  let beforeSessionAck: (() => Promise<void>) | undefined;
  let deferTurnStarted = false;
  let deferTurnInterrupted = false;
  let onInterrupt = () => {};
  let sessionResultId: string | undefined;
  let compactStatus = "accepted";
  const host: MuseSdkHost = {
    initializeResult: {
      experimentalApi: false,
      grantedCapabilities: [],
      museHome: "/fake/muse",
      platformFamily: "unix",
      platformOs: "linux",
      schema: { version: 1, fingerprint: "test" },
      serverInfo: { name: "Muse", version: "test" },
      userAgent: "test",
      sessionDurability: "durable",
    },
    connection: {
      closed,
      mintCommandId: createUuidV7Mint(),
      onNotification: (handler) => {
        notify = handler;
      },
      onServerRequest: () => {},
      onProtocolError: (handler) => {
        onProtocolError = handler;
      },
      request: async (method, params = {}) => {
        calls.push({ method, params });
        if (method === "view/page") {
          const pageIndex =
            params.cursor === undefined
              ? 0
              : (historyPages?.findIndex((page) => page.nextCursor === params.cursor) ?? -1) + 1;
          const page = historyPages?.[pageIndex];
          if (!page) throw new Error("Unexpected history page request.");
          return page;
        }
        return {
          session: { sessionId: nativeSessionId },
          history: { items: params.excludeItems === false && !historyPages ? history : null },
        };
      },
      command: async (method, params, options) => {
        calls.push({ method, params });
        if (rejectMethod === method) throw new Error("Native command rejected.");
        if (method === "session/fork") {
          return { session: { sessionId: "forked-muse-session" } };
        }
        if (method === "session/start" || method === "session/resume") {
          nativeSessionId = String(params.sessionId);
          await beforeSessionAck?.();
          return {
            session: {
              sessionId: sessionResultId ?? nativeSessionId,
              modelId: params.modelId ?? "muse-spark-1.3-contributor",
              activeTurnId: activeTurnId ?? null,
            },
            history: { items: historyPages ? null : history },
          };
        }
        if (method === "turn/start") {
          await beforeTurnAck?.(options?.commandId);
          activeTurnId ??= options?.commandId;
          if (!deferTurnStarted) emit("turn/started", { turnId: activeTurnId });
          return { turnId: activeTurnId, disposition: "queued" };
        }
        if (method === "turn/interrupt") {
          onInterrupt();
          if (!deferTurnInterrupted)
            emit("turn/completed", { turnId: activeTurnId, terminal: "cancelled" });
        }
        if (method === "session/compact")
          return { status: compactStatus, reason: "no_compactable_history" };
        if (method === "approval/decide")
          emit("approval/resolved", { approvalId: params.approvalId, decision: "approved" });
        if (method === "userInput/answer")
          emit("userInput/settled", { userInputId: params.userInputId, answers: params.answers });
        return {};
      },
    },
    exited,
    close: async () => {
      closeCount++;
      resolveClosed();
      resolveExit({ code: 0, signal: null });
    },
  };
  return {
    host,
    calls,
    emit,
    history,
    pageHistory: (pages: NonNullable<typeof historyPages>) => {
      historyPages = pages;
    },
    reject: (method?: string) => {
      rejectMethod = method;
    },
    beforeTurn: (callback: (commandId?: string) => Promise<void>) => {
      beforeTurnAck = callback;
    },
    beforeSession: (callback: () => Promise<void>) => {
      beforeSessionAck = callback;
    },
    resumeTurn: (turnId?: string) => {
      activeTurnId = turnId;
    },
    deferTurnStarted: () => {
      deferTurnStarted = true;
    },
    deferTurnInterrupted: () => {
      deferTurnInterrupted = true;
    },
    onInterrupt: (callback: () => void) => {
      onInterrupt = callback;
    },
    sessionResultId: (id: string) => {
      sessionResultId = id;
    },
    compactStatus: (status: string) => {
      compactStatus = status;
    },
    crash: () => {
      resolveExit({ code: 1, signal: null });
    },
    protocolError: (error: Parameters<typeof onProtocolError>[0]) => {
      onProtocolError(error);
    },
    get closeCount() {
      return closeCount;
    },
  };
}

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3-muse-adapter-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);
const settings = Schema.decodeSync(MuseSettings)({});
const threadId = ThreadId.make("muse-thread");
const startInput = { threadId, cwd: process.cwd(), runtimeMode: "approval-required" as const };
const collectUntil = (
  adapter: { streamEvents: Stream.Stream<ProviderRuntimeEvent> },
  type: ProviderRuntimeEvent["type"],
) => Stream.runCollect(adapter.streamEvents.pipe(Stream.takeUntil((event) => event.type === type)));
const requestIdFrom = (
  events: ReadonlyArray<ProviderRuntimeEvent>,
  type: "request.opened" | "user-input.requested",
) => {
  const event = events.find((event) => event.type === type);
  assert.isDefined(event);
  assert.isDefined(event.requestId);
  return ApprovalRequestId.make(event.requestId);
};
const decodeMuseWireRequest = Schema.decodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      id: Schema.Union([Schema.String, Schema.Int]),
      method: Schema.String,
      params: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
);

describe("MuseAdapter", () => {
  it.effect("retries unadmitted turn requests through the SDK without duplicating the turn", () =>
    Effect.gen(function* () {
      const frames: string[] = [];
      let wake = () => {};
      let ended = false;
      const deliver = (frame: Record<string, unknown>) => {
        frames.push(`${JSON.stringify(frame)}\n`);
        wake();
      };
      const submissions: Record<string, unknown>[] = [];
      const retries: string[] = [];
      let admitted = 0;
      const connection = new Connection({
        incoming: (async function* () {
          while (true) {
            const frame = frames.shift();
            if (frame !== undefined) yield frame;
            else if (ended) return;
            else
              await new Promise<void>((resolve) => {
                wake = resolve;
              });
          }
        })(),
        write: async (chunk) => {
          const request = decodeMuseWireRequest(chunk);
          const response = { jsonrpc: "2.0", id: request.id };
          if (request.method === "session/start") {
            deliver({ ...response, result: { session: { sessionId: request.params.sessionId } } });
            return;
          }
          assert.equal(request.method, "turn/start");
          submissions.push(request.params);
          if (submissions.length < 3) {
            const first = submissions.length === 1;
            deliver({
              ...response,
              error: {
                code: first ? -32001 : -32031,
                message: "No turn admitted",
                data: { kind: first ? "overloaded" : "backpressured", retryable: true },
              },
            });
            return;
          }
          admitted++;
          deliver({
            ...response,
            result: {
              commandId: request.params.commandId,
              turnId: request.params.commandId,
              disposition: "started",
            },
          });
          deliver({
            jsonrpc: "2.0",
            method: "turn/started",
            params: {
              sessionId: request.params.sessionId,
              turnId: request.params.commandId,
            },
          });
        },
        close: async (flushed) => {
          await flushed;
          ended = true;
          wake();
        },
      });
      const fake = makeFakeHost();
      const host: MuseSdkHost = {
        ...fake.host,
        connection: {
          command: (method, params, options) =>
            connection.command(method, params, {
              ...options,
              retryDelay: async (_attempt, error) => {
                retries.push(error.kind);
              },
            }),
          request: connection.request.bind(connection),
          mintCommandId: connection.mintCommandId.bind(connection),
          onNotification: connection.onNotification.bind(connection),
          onServerRequest: connection.onServerRequest.bind(connection),
          onProtocolError: connection.onProtocolError.bind(connection),
          closed: connection.closed,
        },
        close: async () => {
          await connection.close();
          await fake.host.close();
        },
      };
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => host });
      const session = yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Submit once under load" });
      assert.deepEqual(retries, ["overloaded", "backpressured"]);
      assert.equal(submissions.length, 3);
      assert.equal(admitted, 1);
      assert.deepEqual(
        submissions.map((params) => params.commandId),
        [turn.turnId, turn.turnId, turn.turnId],
      );
      assert.deepEqual(submissions[1], submissions[0]);
      assert.deepEqual(submissions[2], submissions[0]);
      deliver({
        jsonrpc: "2.0",
        method: "turn/completed",
        params: {
          sessionId: (session.resumeCursor as { sessionId: string }).sessionId,
          turnId: turn.turnId,
          terminal: "completed",
        },
      });
      const events = yield* collectUntil(adapter, "turn.completed");
      assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
      assert.isFalse(events.some((event) => event.type === "runtime.error"));
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "scopes device CLI access to the granted thread without changing provider permissions",
    () =>
      Effect.gen(function* () {
        const deviceThreadId = ThreadId.make("muse-device-thread");
        const otherThreadId = ThreadId.make("muse-other-thread");
        const baseEnvironment = { PATH: "/provider/bin", KEEP: "provider-value" };
        const spawned: MuseSdkHostOptions[] = [];
        const adapter = yield* makeMuseAdapter(settings, {
          environment: baseEnvironment,
          createHost: async (options) => {
            spawned.push(options);
            return makeFakeHost().host;
          },
        });
        McpProviderSession.setMcpProviderSession({
          environmentId: EnvironmentId.make("test-environment"),
          threadId: deviceThreadId,
          providerSessionId: "test-provider-session",
          providerInstanceId: ProviderInstanceId.make("muse"),
          endpoint: "http://localhost:1234/mcp",
          authorizationHeader: "test-mcp-header-must-not-be-forwarded",
          capabilities: new Set(["device"]),
          agentDeviceEnvironment: {
            PATH: "/device/shim",
            PATH_SEPARATOR: ":",
            AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
          },
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => McpProviderSession.clearMcpProviderSession(deviceThreadId)),
        );
        yield* adapter.startSession({ ...startInput, threadId: deviceThreadId });
        yield* adapter.startSession({ ...startInput, threadId: otherThreadId });
        assert.deepEqual(spawned[0]?.environment, {
          PATH: "/device/shim:/provider/bin",
          KEEP: "provider-value",
          AGENT_DEVICE_NO_UPDATE_NOTIFIER: "1",
        });
        assert.deepEqual(spawned[1]?.environment, baseEnvironment);
        assert.deepEqual(baseEnvironment, { PATH: "/provider/bin", KEEP: "provider-value" });
        assert.equal(spawned[0]?.runtimeMode, "approval-required");
        assert.equal(spawned[1]?.runtimeMode, "approval-required");
        McpProviderSession.clearMcpProviderSession(deviceThreadId);
        yield* adapter.startSession({ ...startInput, threadId: deviceThreadId });
        assert.deepEqual(spawned[2]?.environment, baseEnvironment);
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rewinds by forking at a paged terminal boundary and releases the source host", () =>
    Effect.gen(function* () {
      const source = makeFakeHost();
      const fork = makeFakeHost();
      const firstTurnId = "first-turn";
      source.pageHistory([
        {
          events: [
            { method: "turn/completed", params: { turnId: firstTurnId, terminal: "completed" } },
          ],
          nextCursor: "next-page",
        },
        {
          events: [
            { method: "turn/completed", params: { turnId: "second-turn", terminal: "failed" } },
          ],
          nextCursor: null,
        },
      ]);
      fork.history.push({
        itemId: "retained-answer",
        turnId: firstTurnId,
        kind: "agentMessage",
        status: "completed",
        revision: 1,
        text: "Retained answer",
      });
      let created = 0;
      const adapter = yield* makeMuseAdapter(settings, {
        createHost: async () => (created++ === 0 ? source.host : fork.host),
      });
      const initial = yield* adapter.startSession(startInput);
      const snapshot = yield* adapter.rollbackThread(threadId, 1);
      assert.deepEqual(source.calls.find((call) => call.method === "session/fork")?.params, {
        sessionId: (initial.resumeCursor as { sessionId: string }).sessionId,
        cutPoint: { lastTurnId: firstTurnId },
        excludeItems: true,
      });
      assert.equal(source.closeCount, 1);
      assert.equal(fork.closeCount, 0);
      assert.deepEqual(
        snapshot.turns.map((turn) => turn.id),
        [firstTurnId],
      );
      const [session] = yield* adapter.listSessions();
      assert.deepEqual(session?.resumeCursor, { sessionId: "forked-muse-session" });
      assert.equal(
        fork.calls.find((call) => call.method === "session/resume")?.params.sessionId,
        "forked-muse-session",
      );
      const next = yield* adapter.sendTurn({
        threadId,
        input: "Continue from the retained answer",
      });
      assert.deepEqual(next.resumeCursor, session?.resumeCursor);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("rewinds all turns into a fresh empty session and keeps the selected model", () =>
    Effect.gen(function* () {
      const source = makeFakeHost();
      source.pageHistory([
        {
          events: [
            { method: "turn/completed", params: { turnId: "only-turn", terminal: "completed" } },
          ],
          nextCursor: null,
        },
      ]);
      const fresh = makeFakeHost();
      let created = 0;
      const adapter = yield* makeMuseAdapter(settings, {
        createHost: async () => (created++ === 0 ? source.host : fresh.host),
      });
      const initial = yield* adapter.startSession({
        ...startInput,
        modelSelection: {
          instanceId: ProviderInstanceId.make("muse"),
          model: "muse-spark-1.3",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      const snapshot = yield* adapter.rollbackThread(threadId, 1);
      assert.deepEqual(snapshot.turns, []);
      assert.equal(
        source.calls.some((call) => call.method === "session/fork"),
        false,
      );
      assert.equal(source.closeCount, 1);
      const [session] = yield* adapter.listSessions();
      assert.notDeepEqual(session?.resumeCursor, initial.resumeCursor);
      assert.equal(session?.model, "muse-spark-1.3");
      assert.equal(
        fresh.calls.find((call) => call.method === "session/start")?.params.modelId,
        "muse-spark-1.3",
      );
      yield* adapter.sendTurn({ threadId, input: "Start again" });
      assert.equal(
        fresh.calls.find((call) => call.method === "turn/start")?.params.reasoningEffort,
        "high",
      );
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "rejects rewind during an active turn and leaves the original session usable after a fork rejection",
    () =>
      Effect.gen(function* () {
        const source = makeFakeHost();
        const adapter = yield* makeMuseAdapter(settings, { createHost: async () => source.host });
        const initial = yield* adapter.startSession(startInput);
        const turn = yield* adapter.sendTurn({ threadId, input: "Work" });
        assert.isTrue(Exit.isFailure(yield* Effect.exit(adapter.rollbackThread(threadId, 1))));
        assert.equal(
          source.calls.some((call) => call.method === "session/fork"),
          false,
        );
        yield* adapter.interruptTurn(threadId, turn.turnId);
        source.pageHistory([
          {
            events: ["one", "two"].map((turnId) => ({
              method: "turn/completed",
              params: { turnId, terminal: "completed" },
            })),
            nextCursor: null,
          },
        ]);
        source.reject("session/fork");
        assert.isTrue(Exit.isFailure(yield* Effect.exit(adapter.rollbackThread(threadId, 1))));
        assert.equal(source.closeCount, 0);
        assert.deepEqual((yield* adapter.listSessions())[0]?.resumeCursor, initial.resumeCursor);
        yield* adapter.sendTurn({ threadId, input: "Still usable" });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect(
    "streams each text/reasoning fragment once and waits for the native turn terminal",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeHost();
        const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
        yield* adapter.startSession(startInput);
        const result = yield* adapter.sendTurn({ threadId, input: "Hello" });
        const item = {
          itemId: "reply",
          turnId: result.turnId,
          kind: "agentMessage",
          revision: 1,
          status: "inProgress",
          text: "",
        };
        fake.emit("item/started", { item });
        fake.emit("item/delta", { itemId: "reply", field: "text", delta: "Hello" });
        fake.emit("item/completed", {
          item: { ...item, revision: 2, status: "completed", text: "Hello world" },
        });
        yield* collectUntil(adapter, "item.completed");
        assert.equal((yield* adapter.listSessions())[0]?.status, "running");
        fake.emit("item/completed", {
          item: {
            itemId: "reason",
            turnId: result.turnId,
            kind: "reasoning",
            revision: 1,
            status: "completed",
            summary: ["Thinking"],
          },
        });
        fake.emit("turn/completed", { turnId: result.turnId, terminal: "completed" });
        const rest = yield* collectUntil(adapter, "turn.completed");
        assert.deepEqual(
          rest.filter((event) => event.type === "content.delta").map((event) => event.payload),
          [{ streamKind: "reasoning_summary_text", delta: "Thinking" }],
        );
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("deduplicates completed snapshots and forwards model, effort and tool activity", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, {
        createHost: async () => fake.host,
        instanceId: ProviderInstanceId.make("muse-personal"),
      });
      yield* adapter.startSession(startInput);
      const result = yield* adapter.sendTurn({
        threadId,
        input: "Edit",
        modelSelection: {
          instanceId: ProviderInstanceId.make("muse-personal"),
          model: "custom-muse",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      assert.deepEqual(
        fake.calls.find((call) => call.method === "session/setModel")?.params.model,
        { modelId: "custom-muse", providerId: "meta" },
      );
      assert.equal(
        fake.calls.find((call) => call.method === "turn/start")?.params.reasoningEffort,
        "high",
      );
      const item = {
        itemId: "reply",
        turnId: result.turnId,
        kind: "agentMessage",
        revision: 1,
        status: "inProgress",
        text: "",
      };
      fake.emit("item/started", { item });
      fake.emit("item/delta", { itemId: "reply", field: "text", delta: "Hello" });
      fake.emit("item/completed", {
        item: { ...item, revision: 2, status: "completed", text: "Hello" },
      });
      fake.emit("item/completed", {
        item: { ...item, revision: 2, status: "completed", text: "Hello" },
      });
      fake.emit("item/completed", {
        item: {
          itemId: "tool",
          turnId: result.turnId,
          kind: "toolCall",
          revision: 1,
          status: "completed",
          tool: "write_file",
          args: "{}",
          visibleOutput: "Saved",
        },
      });
      fake.emit("turn/completed", { turnId: result.turnId, terminal: "completed" });
      fake.emit("turn/completed", { turnId: result.turnId, terminal: "completed" });
      const events = yield* collectUntil(adapter, "turn.completed");
      assert.equal(
        events
          .flatMap((event) =>
            event.type === "content.delta" && event.payload.streamKind === "assistant_text"
              ? [event.payload.delta]
              : [],
          )
          .join(""),
        "Hello",
      );
      assert.equal(
        events.filter((event) => event.type === "item.completed" && event.itemId === "reply")
          .length,
        1,
      );
      assert.isTrue(
        events.some(
          (event) => event.type === "item.completed" && event.payload.itemType === "file_change",
        ),
      );
      assert.isTrue(events.every((event) => event.providerInstanceId === "muse-personal"));
      yield* adapter.stopSession(threadId);
      const tail = yield* collectUntil(adapter, "session.exited");
      assert.equal(tail.filter((event) => event.type === "turn.completed").length, 0);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "resumes native history in a new adapter and reapplies the selected approval mode",
    () =>
      Effect.gen(function* () {
        const first = makeFakeHost();
        const adapter = yield* makeMuseAdapter(settings, { createHost: async () => first.host });
        const session = yield* adapter.startSession(startInput);
        yield* adapter.stopAll();
        assert.equal(first.closeCount, 1);
        const second = makeFakeHost();
        second.history.push({
          itemId: "old",
          turnId: "old-turn",
          kind: "agentMessage",
          revision: 1,
          status: "completed",
          text: "Remember me",
        });
        const resumedAdapter = yield* makeMuseAdapter(settings, {
          createHost: async () => second.host,
        });
        const resumed = yield* resumedAdapter.startSession({
          ...startInput,
          resumeCursor: session.resumeCursor,
        });
        assert.deepEqual(resumed.resumeCursor, session.resumeCursor);
        assert.equal(second.calls[0]?.method, "session/resume");
        assert.equal(
          second.calls.find((call) => call.method === "session/setApprovalMode")?.params.mode,
          "promptUnmatched",
        );
        const snapshot = yield* resumedAdapter.readThread(threadId);
        assert.equal(snapshot.turns[0]?.id, "old-turn");
        assert.equal(
          second.calls.find((call) => call.method === "session/read")?.params.excludeItems,
          false,
        );
        second.history.push({
          itemId: "new-native-item",
          turnId: "new-native-turn",
          kind: "agentMessage",
          revision: 1,
          status: "completed",
          text: "Read from durable history",
        });
        assert.equal(
          (yield* resumedAdapter.readThread(threadId)).turns.at(-1)?.id,
          "new-native-turn",
        );
        assert.isTrue(yield* resumedAdapter.hasSession(threadId));
        assert.isFalse(yield* adapter.hasSession(threadId));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("routes approvals with stage guards and refuses unavailable decisions", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Run tool" });
      fake.emit("approval/requested", {
        approvalId: "approval",
        turnId: turn.turnId,
        toolName: "shell",
        subject: { kind: "shell", command: "ls" },
        currentRequirementId: { approvalId: "approval", sourceIndex: 1 },
        availableChoices: [
          { choiceId: "yes-once", label: "Allow once", decision: "approved", scope: "once" },
          {
            choiceId: "yes-session",
            label: "Allow session",
            decision: "approvedForSession",
            scope: "session",
          },
          {
            choiceId: "session-policy",
            label: "Amend session policy",
            decision: "approvedPolicyAmendment",
            scope: "session",
          },
        ],
      });
      const events = yield* collectUntil(adapter, "request.opened");
      assert.deepEqual(events.find((event) => event.type === "request.opened")?.payload.options, [
        { decision: "accept", label: "Allow once" },
        { decision: "acceptForSession", label: "Allow session" },
      ]);
      const unavailable = yield* Effect.result(
        adapter.respondToRequest(threadId, requestIdFrom(events, "request.opened"), "acceptAlways"),
      );
      assert.equal(unavailable._tag, "Failure");
      yield* adapter.respondToRequest(threadId, requestIdFrom(events, "request.opened"), "accept");
      assert.deepEqual(fake.calls.find((call) => call.method === "approval/decide")?.params, {
        sessionId:
          (yield* adapter.listSessions())[0]!.resumeCursor && fake.calls[0]?.params.sessionId,
        approvalId: "approval",
        requirementId: { approvalId: "approval", sourceIndex: 1 },
        choiceId: "yes-once",
      });
      const resolved = yield* collectUntil(adapter, "request.resolved");
      assert.equal(
        resolved.find((event) => event.type === "request.resolved")?.payload.decision,
        "accept",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reissues resumed pending requests with fresh IDs and rejects stale responses", () =>
    Effect.gen(function* () {
      const first = makeFakeHost();
      const second = makeFakeHost();
      const hosts = [first.host, second.host];
      const adapter = yield* makeMuseAdapter(settings, {
        createHost: async () => {
          const host = hosts.shift();
          if (!host) throw new Error("Unexpected host creation.");
          return host;
        },
      });
      const session = yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Ask before proceeding" });
      const approval = {
        approvalId: "pending-approval",
        turnId: turn.turnId,
        subject: { kind: "shell", command: "ls" },
        currentRequirementId: { approvalId: "pending-approval", sourceIndex: 0 },
        availableChoices: [
          { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
        ],
      };
      const question = {
        userInputId: "pending-question",
        turnId: turn.turnId,
        questions: [
          {
            id: "q",
            header: "Continue",
            question: "Continue?",
            options: [{ label: "Yes" }],
            selection: { mode: "single" },
          },
        ],
      };
      first.emit("approval/requested", approval);
      first.emit("userInput/requested", question);
      const opened = yield* collectUntil(adapter, "user-input.requested");
      const oldApprovalId = requestIdFrom(opened, "request.opened");
      const oldQuestionId = requestIdFrom(opened, "user-input.requested");
      yield* adapter.stopSession(threadId);
      const closed = yield* collectUntil(adapter, "session.exited");
      assert.equal(
        closed.find((event) => event.type === "request.resolved")?.requestId?.toString(),
        oldApprovalId,
      );
      assert.equal(
        closed.find((event) => event.type === "user-input.resolved")?.requestId?.toString(),
        oldQuestionId,
      );

      second.resumeTurn(turn.turnId);
      second.beforeSession(async () => {
        second.emit("approval/requested", approval);
        second.emit("userInput/requested", question);
      });
      yield* adapter.startSession({ ...startInput, resumeCursor: session.resumeCursor });
      const reopened = yield* collectUntil(adapter, "user-input.requested");
      const approvalId = requestIdFrom(reopened, "request.opened");
      const questionId = requestIdFrom(reopened, "user-input.requested");
      assert.notEqual(approvalId, oldApprovalId);
      assert.notEqual(questionId, oldQuestionId);
      const staleApproval = yield* adapter
        .respondToRequest(threadId, oldApprovalId, "accept")
        .pipe(Effect.result);
      const staleQuestion = yield* adapter
        .respondToUserInput(threadId, oldQuestionId, { q: "Yes" })
        .pipe(Effect.result);
      assert.equal(staleApproval._tag, "Failure");
      assert.equal(staleQuestion._tag, "Failure");
      assert.isFalse(
        second.calls.some(
          (call) => call.method === "approval/decide" || call.method === "userInput/answer",
        ),
      );

      yield* adapter.respondToRequest(threadId, approvalId, "accept");
      yield* adapter.respondToUserInput(threadId, questionId, { q: "Yes" });
      const settled = yield* collectUntil(adapter, "user-input.resolved");
      assert.equal(
        settled.find((event) => event.type === "request.resolved")?.requestId?.toString(),
        approvalId,
      );
      assert.equal(
        settled.find((event) => event.type === "user-input.resolved")?.requestId?.toString(),
        questionId,
      );
      assert.equal(
        second.calls.find((call) => call.method === "approval/decide")?.params.approvalId,
        approval.approvalId,
      );
      assert.equal(
        second.calls.find((call) => call.method === "userInput/answer")?.params.userInputId,
        question.userInputId,
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejects mismatched session identities before applying resume history or settings",
    () =>
      Effect.gen(function* () {
        for (const resumeCursor of [undefined, { sessionId: "expected-session" }]) {
          const fake = makeFakeHost();
          fake.sessionResultId("wrong-session");
          fake.resumeTurn("unexpected-turn");
          fake.pageHistory([{ events: [], nextCursor: null }]);
          const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
          const result = yield* adapter
            .startSession({ ...startInput, ...(resumeCursor ? { resumeCursor } : {}) })
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          if (result._tag === "Failure") {
            assert.equal(result.failure._tag, "ProviderAdapterRequestError");
            assert.include(String(result.failure), "unexpected session identity");
          }
          assert.deepEqual(
            fake.calls.map((call) => call.method),
            [resumeCursor ? "session/resume" : "session/start"],
          );
          assert.equal(fake.closeCount, 1);
          assert.isFalse(yield* adapter.hasSession(threadId));
          const events = yield* collectUntil(adapter, "session.exited");
          assert.isFalse(
            events.some(
              (event) => event.type === "turn.started" || event.type === "session.started",
            ),
          );
        }
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "waits beyond the RPC deadline for acknowledged interruption and bounds host cleanup",
    () =>
      Effect.gen(function* () {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          for (const nativeCompletes of [true, false]) {
            const fake = makeFakeHost();
            fake.deferTurnInterrupted();
            let acknowledge = () => {};
            const acknowledged = new Promise<void>((resolve) => {
              acknowledge = resolve;
            });
            fake.onInterrupt(acknowledge);
            const adapter = yield* makeMuseAdapter(settings, {
              createHost: async () => fake.host,
              requestTimeoutMs: 20,
              interruptTimeoutMs: 100,
            });
            yield* adapter.startSession(startInput);
            const turn = yield* adapter.sendTurn({ threadId, input: "Work" });
            const stopping = yield* adapter
              .interruptTurn(threadId, turn.turnId)
              .pipe(Effect.result, Effect.forkChild);
            yield* Effect.promise(() => acknowledged);
            yield* Effect.promise(() => vi.advanceTimersByTimeAsync(21));
            assert.equal(fake.closeCount, 0);
            assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, turn.turnId);
            if (nativeCompletes)
              fake.emit("turn/completed", { turnId: turn.turnId, terminal: "cancelled" });
            else yield* Effect.promise(() => vi.advanceTimersByTimeAsync(100));
            assert.equal(
              (yield* Fiber.join(stopping))._tag,
              nativeCompletes ? "Success" : "Failure",
            );
            const events = yield* collectUntil(
              adapter,
              nativeCompletes ? "turn.completed" : "session.exited",
            );
            assert.equal(
              events.find((event) => event.type === "turn.completed")?.payload.state,
              nativeCompletes ? "interrupted" : "failed",
            );
            assert.equal(fake.closeCount, nativeCompletes ? 0 : 1);
            assert.equal(
              events.some((event) => event.type === "runtime.warning"),
              !nativeCompletes,
            );
            assert.equal(
              events.some((event) => event.type === "session.exited"),
              !nativeCompletes,
            );
            if (!nativeCompletes)
              assert.include(
                events.find((event) => event.type === "session.exited")?.payload.reason,
                "forcibly closed",
              );
            yield* adapter.stopSession(threadId);
          }
        } finally {
          vi.useRealTimers();
        }
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("restores a resumed native active turn and waits for its real terminal", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      fake.resumeTurn("resumed-turn");
      fake.history.push({
        itemId: "active-item",
        turnId: "resumed-turn",
        kind: "agentMessage",
        revision: 1,
        status: "inProgress",
        text: "In progress",
      });
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      const session = yield* adapter.startSession({
        ...startInput,
        resumeCursor: { sessionId: "resumed-session" },
      });
      assert.equal(session.status, "running");
      assert.equal(session.activeTurnId, "resumed-turn");
      fake.emit("item/completed", {
        item: {
          itemId: "active-item",
          turnId: "resumed-turn",
          kind: "agentMessage",
          revision: 2,
          status: "completed",
          text: "In progress, now complete",
        },
      });
      yield* adapter.interruptTurn(threadId);
      const events = yield* collectUntil(adapter, "turn.completed");
      assert.deepEqual(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta),
        [", now complete"],
      );
      assert.equal(events.filter((event) => event.type === "turn.started").length, 1);
      assert.equal(
        events.find((event) => event.type === "turn.completed")?.payload.state,
        "interrupted",
      );
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("pages budget-limited history on resume and read without replaying old events", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const item = {
        itemId: "old-item",
        turnId: "old-turn",
        kind: "agentMessage",
        revision: 1,
        status: "inProgress",
        text: "Old",
      };
      fake.pageHistory([
        { events: [{ method: "item/started", params: { item } }], nextCursor: "page-two" },
        {
          events: [
            {
              method: "item/completed",
              params: { item: { ...item, revision: 2, status: "completed", text: "Old response" } },
            },
          ],
          nextCursor: null,
        },
      ]);
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession({ ...startInput, resumeCursor: { sessionId: "resume-history" } });
      const snapshot = yield* adapter.readThread(threadId);
      assert.deepEqual(snapshot.turns, [
        {
          id: TurnId.make("old-turn"),
          items: [{ ...item, revision: 2, status: "completed", text: "Old response" }],
        },
      ]);
      assert.deepEqual(
        fake.calls.filter((call) => call.method === "view/page").map((call) => call.params.cursor),
        [undefined, "page-two", undefined, "page-two"],
      );
      yield* adapter.stopSession(threadId);
      const events = yield* collectUntil(adapter, "session.exited");
      assert.isFalse(
        events.some((event) => event.type === "content.delta" || event.type === "turn.started"),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("buffers reissued resume questions until their native active turn is restored", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      fake.resumeTurn("resumed-turn");
      fake.beforeSession(async () => {
        fake.emit("userInput/requested", {
          userInputId: "resumed-question",
          turnId: "resumed-turn",
          questions: [
            {
              id: "q",
              header: "Choose",
              question: "Continue?",
              options: [{ label: "Yes" }],
              selection: { mode: "single" },
            },
          ],
        });
      });
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession({ ...startInput, resumeCursor: { sessionId: "resume" } });
      const events = yield* collectUntil(adapter, "user-input.requested");
      assert.equal(
        events.find((event) => event.type === "user-input.requested")?.turnId,
        "resumed-turn",
      );
      yield* adapter.respondToUserInput(threadId, requestIdFrom(events, "user-input.requested"), {
        q: "Yes",
      });
      assert.deepEqual(
        fake.calls.find((call) => call.method === "userInput/answer")?.params.answers,
        [{ questionId: "q", selectedLabel: "Yes" }],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "uses the least durable matching approval choice even when amendments appear first",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeHost();
        const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
        yield* adapter.startSession(startInput);
        const turn = yield* adapter.sendTurn({ threadId, input: "Run" });
        fake.emit("approval/requested", {
          approvalId: "approval",
          turnId: turn.turnId,
          subject: { kind: "shell", command: "ls" },
          currentRequirementId: { approvalId: "approval", sourceIndex: 0 },
          availableChoices: [
            {
              choiceId: "always-deny",
              label: "Always deny",
              decision: "deniedPolicyAmendment",
              scope: "localPersistent",
            },
            { choiceId: "deny-once", label: "Deny", decision: "denied", scope: "once" },
          ],
        });
        const events = yield* collectUntil(adapter, "request.opened");
        const opened = events.find((event) => event.type === "request.opened");
        assert.deepEqual(opened?.payload.options, [{ decision: "decline", label: "Deny" }]);
        yield* adapter.respondToRequest(
          threadId,
          requestIdFrom(events, "request.opened"),
          "decline",
        );
        assert.equal(
          fake.calls.find((call) => call.method === "approval/decide")?.params.choiceId,
          "deny-once",
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("auto-accepts file edits once while keeping shell approval interactive", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession({ ...startInput, runtimeMode: "auto-accept-edits" });
      const turn = yield* adapter.sendTurn({ threadId, input: "Edit" });
      const approval = {
        approvalId: "edit",
        protectedWrite: false,
        judgeEscalated: false,
        turnId: turn.turnId,
        subject: { kind: "fileAccess", access: "write", path: "src/app.ts" },
        currentRequirementId: { approvalId: "edit", sourceIndex: 0 },
        availableChoices: [
          { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
        ],
      };
      fake.emit("approval/requested", approval);
      fake.emit("session/contextUsage", { usedTokens: 10 });
      const events = yield* collectUntil(adapter, "thread.token-usage.updated");
      assert.isFalse(
        events.some(
          (event) => event.type === "request.opened" || event.type === "request.resolved",
        ),
      );
      assert.equal(
        fake.calls.find((call) => call.method === "approval/decide")?.params.choiceId,
        "once",
      );
      fake.emit("approval/requested", {
        ...approval,
        approvalId: "shell",
        currentRequirementId: { approvalId: "shell", sourceIndex: 0 },
        subject: { kind: "shell", command: "ls" },
      });
      const shellEvents = yield* collectUntil(adapter, "request.opened");
      assert.isFalse(shellEvents.some((event) => event.type === "request.resolved"));
      const shell = shellEvents.find((event) => event.type === "request.opened");
      assert.equal(shell?.payload.requestType, "command_execution_approval");
      assert.equal(fake.calls.filter((call) => call.method === "approval/decide").length, 1);
      for (const [index, extra] of [
        { protectedWrite: true },
        { judgeEscalated: true },
        { subject: { kind: "fileAccess", access: "write", path: "../outside.ts" } },
        { subject: { kind: "fileAccess", access: "write" } },
      ].entries()) {
        const id = `guarded-edit-${index}`;
        fake.emit("approval/requested", {
          ...approval,
          ...extra,
          approvalId: id,
          currentRequirementId: { approvalId: id, sourceIndex: 0 },
        });
        const guarded = yield* collectUntil(adapter, "request.opened");
        assert.isTrue(requestIdFrom(guarded, "request.opened").endsWith(`:${id}`));
      }
      assert.equal(fake.calls.filter((call) => call.method === "approval/decide").length, 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("does not reopen settled approvals or questions on late native notifications", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Work" });
      const approval = {
        approvalId: "settled-approval",
        turnId: turn.turnId,
        subject: { kind: "shell", command: "ls" },
        currentRequirementId: { approvalId: "settled-approval", sourceIndex: 0 },
        availableChoices: [
          { choiceId: "once", label: "Allow once", decision: "approved", scope: "once" },
        ],
      };
      fake.emit("approval/requested", approval);
      const openedApproval = yield* collectUntil(adapter, "request.opened");
      fake.emit("approval/resolved", { approvalId: approval.approvalId, decision: "approved" });
      yield* collectUntil(adapter, "request.resolved");
      fake.emit("approval/updated", {
        ...approval,
        turnId: undefined,
        change: { kind: "policyPersistence", status: "succeeded" },
      });
      fake.emit("approval/requested", approval);
      fake.emit("approval/updated", { ...approval, approvalId: "never-requested" });
      const question = {
        userInputId: "settled-question",
        turnId: turn.turnId,
        questions: [
          {
            id: "q",
            header: "Choice",
            question: "Continue?",
            options: [],
            selection: { mode: "single" },
          },
        ],
      };
      fake.emit("userInput/requested", question);
      const opened = yield* collectUntil(adapter, "user-input.requested");
      assert.isFalse(opened.some((event) => event.type === "request.opened"));
      fake.emit("userInput/settled", {
        userInputId: question.userInputId,
        answers: [{ questionId: "q", freeText: "Yes" }],
      });
      yield* collectUntil(adapter, "user-input.resolved");
      fake.emit("userInput/requested", question);
      fake.emit("session/contextUsage", { usedTokens: 10 });
      const late = yield* collectUntil(adapter, "thread.token-usage.updated");
      assert.isFalse(
        late.some(
          (event) => event.type === "user-input.requested" || event.type === "request.opened",
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            adapter.respondToRequest(
              threadId,
              requestIdFrom(openedApproval, "request.opened"),
              "accept",
            ),
          ),
        ),
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("native compaction waits for the item outcome and surfaces no-op results", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      if (adapter.compaction?.type !== "native") return assert.fail("Expected native compaction");
      yield* adapter.compaction.start(threadId);
      fake.emit("item/completed", {
        item: {
          itemId: "compact",
          kind: "compaction",
          revision: 1,
          status: "completed",
          outcome: "compacted",
        },
      });
      const events = yield* collectUntil(adapter, "thread.state.changed");
      assert.equal(
        events.find((event) => event.type === "thread.state.changed")?.payload.state,
        "compacted",
      );
      fake.compactStatus("noop");
      yield* adapter.compaction.start(threadId);
      const failed = yield* collectUntil(adapter, "runtime.error");
      assert.equal(
        failed.find((event) => event.type === "runtime.error")?.payload.message,
        "no_compactable_history",
      );
      for (const outcome of ["noop", "cancelled"] as const) {
        fake.emit("item/completed", {
          item: {
            itemId: outcome,
            kind: "compaction",
            revision: 1,
            status: "completed",
            outcome,
            trigger: "auto",
          },
        });
      }
      fake.emit("session/contextUsage", { usedTokens: 10 });
      const nonFailures = yield* collectUntil(adapter, "thread.token-usage.updated");
      assert.isFalse(nonFailures.some((event) => event.type === "runtime.error"));
      assert.isFalse(nonFailures.some((event) => event.type === "item.completed"));
      for (const outcome of ["noop", "cancelled"] as const) {
        fake.emit("item/completed", {
          item: {
            itemId: `manual-${outcome}`,
            kind: "compaction",
            revision: 1,
            status: "completed",
            outcome,
            trigger: "manual",
          },
        });
        const terminal = yield* collectUntil(adapter, "item.completed");
        const completed = terminal.find((event) => event.type === "item.completed");
        assert.equal(completed?.payload.itemType, "context_compaction");
        assert.equal(completed?.payload.status, "declined");
        assert.isFalse(terminal.some((event) => event.type === "runtime.error"));
      }
      fake.emit("item/completed", {
        item: {
          itemId: "failed-compaction",
          kind: "compaction",
          revision: 1,
          status: "failed",
          outcome: "failed",
          trigger: "manual",
          reason: "Summarizer failed",
        },
      });
      const actualFailure = yield* collectUntil(adapter, "runtime.error");
      assert.equal(
        actualFailure.find((event) => event.type === "runtime.error")?.payload.message,
        "Summarizer failed",
      );
      const active = yield* adapter.sendTurn({ threadId, input: "Continue working" });
      fake.emit("item/completed", {
        item: {
          itemId: "automatic-compaction-failed",
          turnId: active.turnId,
          kind: "compaction",
          revision: 1,
          status: "failed",
          outcome: "failed",
          trigger: "auto",
          reason: "Automatic summarizer unavailable",
        },
      });
      fake.emit("session/contextUsage", { usedTokens: 11 });
      const automatic = yield* collectUntil(adapter, "thread.token-usage.updated");
      assert.isFalse(automatic.some((event) => event.type === "runtime.error"));
      assert.isFalse(automatic.some((event) => event.type === "turn.completed"));
      assert.equal(
        automatic.find((event) => event.type === "runtime.warning")?.payload.message,
        "Automatic summarizer unavailable",
      );
      const [running] = yield* adapter.listSessions();
      assert.equal(running?.status, "running");
      assert.equal(running?.activeTurnId, active.turnId);
      fake.emit("turn/completed", { turnId: active.turnId, terminal: "completed" });
      const terminal = yield* collectUntil(adapter, "turn.completed");
      assert.equal(
        terminal.find((event) => event.type === "turn.completed")?.payload.state,
        "completed",
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps selected effort across turns and ignores another instance's selection", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession({
        ...startInput,
        modelSelection: {
          instanceId: ProviderInstanceId.make("muse"),
          model: "chosen",
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      });
      yield* adapter.sendTurn({ threadId, input: "First" });
      yield* adapter.interruptTurn(threadId);
      yield* adapter.sendTurn({
        threadId,
        input: "Second",
        modelSelection: {
          instanceId: ProviderInstanceId.make("another-instance"),
          model: "other",
          options: [{ id: "reasoningEffort", value: "low" }],
        },
      });
      const starts = fake.calls.filter((call) => call.method === "turn/start");
      assert.deepEqual(
        starts.map((call) => call.params.reasoningEffort),
        ["high", "high"],
      );
      assert.deepEqual(
        starts.map((call) => call.params.displayText),
        ["First", "Second"],
      );
      assert.isFalse(fake.calls.some((call) => call.method === "session/setModel"));
      assert.equal(fake.calls.filter((call) => call.method === "turn/interrupt").length, 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps blank question presentation usable and writes native diagnostics", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const logged: Array<{ event: unknown; threadId: unknown }> = [];
      const adapter = yield* makeMuseAdapter(settings, {
        createHost: async () => fake.host,
        nativeEventLogger: {
          filePath: "/fake/log",
          write: (event, threadId) =>
            Effect.sync(() => {
              logged.push({ event, threadId });
            }),
          close: () => Effect.void,
        },
      });
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Choose" });
      fake.emit("userInput/requested", {
        userInputId: "blank",
        turnId: turn.turnId,
        questions: [
          {
            id: "q",
            header: "",
            question: "",
            options: [{ label: "" }],
            selection: { mode: "single" },
          },
        ],
      });
      const request = (yield* collectUntil(adapter, "user-input.requested")).find(
        (event) => event.type === "user-input.requested",
      );
      assert.deepEqual(request?.payload.questions, [
        {
          id: "q",
          header: "Question",
          question: "Muse needs your input.",
          options: [],
          allowCustomAnswer: true,
          multiSelect: false,
        },
      ]);
      assert.equal(logged.length, 2);
      assert.isTrue(logged.every((event) => event.threadId === threadId));
      assert.equal((yield* adapter.listSessions())[0]?.status, "running");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("answers multiple selection and free-form questions using native answer fields", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Choose" });
      fake.emit("userInput/requested", {
        userInputId: "question",
        turnId: turn.turnId,
        questions: [
          {
            id: "q",
            header: "Pick",
            question: "Which?",
            options: [{ label: "A" }, { label: "B" }],
            selection: { mode: "multiple" },
          },
        ],
      });
      const questions = yield* collectUntil(adapter, "user-input.requested");
      yield* adapter.respondToUserInput(
        threadId,
        requestIdFrom(questions, "user-input.requested"),
        {
          q: ["A", "B", "Additional detail"],
        },
      );
      assert.deepEqual(
        fake.calls.find((call) => call.method === "userInput/answer")?.params.answers,
        [{ questionId: "q", selectedLabels: ["A", "B"], note: "Additional detail" }],
      );
      const resolved = yield* collectUntil(adapter, "user-input.resolved");
      assert.deepEqual(
        resolved.find((event) => event.type === "user-input.resolved")?.payload.answers,
        { q: "A\nB\nAdditional detail" },
      );
      fake.emit("userInput/requested", {
        userInputId: "custom",
        turnId: turn.turnId,
        questions: [
          {
            id: "q",
            header: "Pick",
            question: "Which?",
            options: [{ label: "A" }],
            selection: { mode: "multiple" },
          },
        ],
      });
      const custom = yield* collectUntil(adapter, "user-input.requested");
      yield* adapter.respondToUserInput(threadId, requestIdFrom(custom, "user-input.requested"), {
        q: "Custom answer",
      });
      assert.deepEqual(
        fake.calls.findLast((call) => call.method === "userInput/answer")?.params.answers,
        [{ questionId: "q", freeText: "Custom answer" }],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects incomplete question answers before making a native request", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Choose" });
      fake.emit("userInput/requested", {
        userInputId: "two-questions",
        turnId: turn.turnId,
        questions: ["first", "second"].map((id) => ({
          id,
          header: "Continue",
          question: "Continue?",
          options: [{ label: "Yes" }],
          selection: { mode: "single" },
        })),
      });
      const events = yield* collectUntil(adapter, "user-input.requested");
      const requestId = requestIdFrom(events, "user-input.requested");
      const result = yield* adapter
        .respondToUserInput(threadId, requestId, { first: "Yes" })
        .pipe(Effect.result);
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "ProviderAdapterValidationError");
        if (result.failure._tag === "ProviderAdapterValidationError")
          assert.equal(result.failure.issue, "Muse requires an answer to every question.");
      }
      assert.isFalse(fake.calls.some((call) => call.method === "userInput/answer"));
      yield* adapter.respondToUserInput(threadId, requestId, { first: "Yes", second: "Yes" });
      assert.deepEqual(
        fake.calls.find((call) => call.method === "userInput/answer")?.params.answers,
        [
          { questionId: "first", selectedLabel: "Yes" },
          { questionId: "second", selectedLabel: "Yes" },
        ],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("reads image attachments on the execution host and forwards SDK image parts", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const config = yield* ServerConfig;
      const fileSystem = yield* FileSystem.FileSystem;
      const attachment = {
        type: "image" as const,
        id: "muse-thread-12345678-1234-1234-1234-123456789abc",
        name: "test.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const path = resolveAttachmentPath({ attachmentsDir: config.attachmentsDir, attachment });
      assert.isNotNull(path);
      yield* fileSystem.writeFile(path!, new Uint8Array([1, 2, 3, 4]));
      yield* adapter.sendTurn({ threadId, attachments: [attachment] });
      const input = fake.calls.find((call) => call.method === "turn/start")?.params.input;
      assert.equal(
        fake.calls.find((call) => call.method === "turn/start")?.params.displayText,
        "Image attachment",
      );
      assert.isArray(input);
      assert.deepEqual(Array.isArray(input) ? input.at(-1) : undefined, {
        type: "image",
        base64Data: "AQIDBA==",
        mediaType: "image/png",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "interrupt settles pending questions and terminal exactly once while allowing another turn",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeHost();
        const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
        yield* adapter.startSession(startInput);
        const first = yield* adapter.sendTurn({ threadId, input: "Ask" });
        fake.emit("userInput/requested", {
          userInputId: "pending",
          turnId: first.turnId,
          questions: [],
        });
        yield* collectUntil(adapter, "user-input.requested");
        yield* adapter.interruptTurn(threadId, first.turnId);
        const events = yield* collectUntil(adapter, "turn.completed");
        assert.isTrue(events.some((event) => event.type === "user-input.resolved"));
        assert.deepEqual(events.find((event) => event.type === "turn.completed")?.payload, {
          state: "interrupted",
        });
        const next = yield* adapter.sendTurn({ threadId, input: "Again" });
        assert.notEqual(first.turnId, next.turnId);
        yield* adapter.stopSession(threadId);
        const tail = yield* collectUntil(adapter, "session.exited");
        assert.equal(tail.filter((event) => event.type === "turn.completed").length, 1);
        assert.equal(fake.closeCount, 1);
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("host failure and view gaps close once with one failed turn and durable cursor", () =>
    Effect.gen(function* () {
      for (const failure of ["host", "gap"] as const) {
        const fake = makeFakeHost();
        const resumed = makeFakeHost();
        let hostCount = 0;
        const adapter = yield* makeMuseAdapter(settings, {
          createHost: async () => (hostCount++ === 0 ? fake.host : resumed.host),
        });
        const session = yield* adapter.startSession(startInput);
        yield* adapter.sendTurn({ threadId, input: "Run" });
        if (failure === "host") fake.crash();
        else fake.emit("view/gap", { after: "opaque1", next: "opaque2" });
        const events = yield* collectUntil(adapter, "session.exited");
        assert.equal(events.filter((event) => event.type === "turn.completed").length, 1);
        assert.equal(
          events.find((event) => event.type === "turn.completed")?.payload.state,
          "failed",
        );
        assert.deepEqual(
          events.find((event) => event.type === "session.started")?.payload.resume,
          session.resumeCursor,
        );
        assert.equal(
          events.find((event) => event.type === "session.exited")?.payload.recoverable,
          true,
        );
        yield* adapter.stopAll();
        assert.equal(fake.closeCount, 1);
        if (failure === "gap") {
          const error = events.find((event) => event.type === "runtime.error");
          assert.include(
            error?.payload.message,
            "missing updates will not be restored in this chat",
          );
          assert.include(error?.payload.message, "Muse Code retains the saved conversation");
          resumed.history.push({
            itemId: "missing-from-chat",
            turnId: "saved-turn",
            kind: "agentMessage",
            status: "completed",
            revision: 1,
            text: "Saved in Muse while delivery was interrupted",
          });
          const recovered = yield* adapter.startSession({
            ...startInput,
            resumeCursor: session.resumeCursor,
          });
          assert.deepEqual(recovered.resumeCursor, session.resumeCursor);
          const replay = yield* collectUntil(adapter, "session.state.changed");
          assert.equal(replay.filter((event) => event.type === "content.delta").length, 0);
          assert.equal(replay.filter((event) => event.type === "turn.completed").length, 0);
          assert.equal(
            resumed.calls.find((call) => call.method === "session/resume")?.params.sessionId,
            (session.resumeCursor as { sessionId: string }).sessionId,
          );
          const saved = yield* adapter.readThread(threadId);
          assert.equal(saved.turns[0]?.id, "saved-turn");
          yield* adapter.stopAll();
          assert.equal(resumed.closeCount, 1);
        }
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("forwards max effort unchanged when switching to Muse Spark 1.3", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, {
        createHost: async () => fake.host,
        modelCatalog: Effect.succeed([
          {
            slug: "muse-spark-1.3",
            name: "Muse Spark 1.3",
            isCustom: false,
            capabilities: museModelCapabilities("muse-spark-1.3"),
          },
        ]),
      });
      yield* adapter.startSession(startInput);
      yield* adapter.sendTurn({
        threadId,
        input: "Think carefully",
        modelSelection: {
          instanceId: ProviderInstanceId.make("muse"),
          model: "muse-spark-1.3",
          options: [{ id: "reasoningEffort", value: "max" }],
        },
      });
      assert.deepEqual(
        fake.calls.find((call) => call.method === "session/setModel")?.params.model,
        { modelId: "muse-spark-1.3", providerId: "meta" },
      );
      assert.equal(
        fake.calls.find((call) => call.method === "turn/start")?.params.reasoningEffort,
        "max",
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("normalizes saved and implicit efforts against the current model catalog", () =>
    Effect.gen(function* () {
      for (const { saved, tiers, expected } of [
        { saved: "ultra", tiers: ["medium", "xhigh"], expected: "medium" },
        { saved: undefined, tiers: ["xhigh", "max"], expected: "xhigh" },
        { saved: "high", tiers: [], expected: undefined },
      ]) {
        const fake = makeFakeHost();
        const model = "muse-spark-1.3-contributor";
        const adapter = yield* makeMuseAdapter(settings, {
          createHost: async () => fake.host,
          modelCatalog: Effect.succeed([
            {
              slug: model,
              name: model,
              isCustom: false,
              capabilities: museModelCapabilities(
                model,
                tiers.map((tier) => ({ tier })),
              ),
            },
          ]),
        });
        yield* adapter.startSession(startInput);
        yield* adapter.sendTurn({
          threadId,
          input: "Continue",
          modelSelection: {
            instanceId: ProviderInstanceId.make("muse"),
            model,
            ...(saved !== undefined ? { options: [{ id: "reasoningEffort", value: saved }] } : {}),
          },
        });
        const turn = fake.calls.find((call) => call.method === "turn/start");
        assert.equal(turn?.params.reasoningEffort, expected);
        assert.equal(Object.hasOwn(turn?.params ?? {}, "reasoningEffort"), expected !== undefined);
        yield* adapter.stopSession(threadId);
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("normalizes remembered max effort when switching to Contributor", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, {
        createHost: async () => fake.host,
        modelCatalog: Effect.succeed(
          ["muse-spark-1.3", "muse-spark-1.3-contributor"].map((model) => ({
            slug: model,
            name: model,
            isCustom: false,
            capabilities: museModelCapabilities(model),
          })),
        ),
      });
      yield* adapter.startSession({
        ...startInput,
        modelSelection: {
          instanceId: ProviderInstanceId.make("muse"),
          model: "muse-spark-1.3",
          options: [{ id: "reasoningEffort", value: "max" }],
        },
      });
      const first = yield* adapter.sendTurn({ threadId, input: "First" });
      yield* adapter.interruptTurn(threadId, first.turnId);
      yield* adapter.sendTurn({
        threadId,
        input: "Continue",
        modelSelection: {
          instanceId: ProviderInstanceId.make("muse"),
          model: "muse-spark-1.3-contributor",
        },
      });
      assert.deepEqual(
        fake.calls
          .filter((call) => call.method === "turn/start")
          .map((call) => call.params.reasoningEffort),
        ["max", "medium"],
      );
      yield* adapter.stopSession(threadId);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "queues stop requests during admission and interrupts the admitted turn only once",
    () =>
      Effect.gen(function* () {
        for (const startAfterAck of [false, true]) {
          const fake = makeFakeHost();
          if (startAfterAck) fake.deferTurnStarted();
          const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
          yield* adapter.startSession(startInput);
          let markAdmitting = (_turnId: TurnId) => {};
          const admitting = new Promise<TurnId>((resolve) => {
            markAdmitting = resolve;
          });
          let releaseAdmission = () => {};
          const admission = new Promise<void>((resolve) => {
            releaseAdmission = resolve;
          });
          fake.beforeTurn(async (commandId) => {
            if (!commandId) throw new Error("Expected a turn command ID.");
            markAdmitting(TurnId.make(commandId));
            await admission;
          });
          const sending = yield* adapter
            .sendTurn({ threadId, input: "Start work" })
            .pipe(Effect.forkChild);
          const pendingTurnId = yield* Effect.promise(() => admitting);
          const wrongStop = yield* adapter
            .interruptTurn(threadId, TurnId.make("older-turn"))
            .pipe(Effect.result, Effect.forkChild({ startImmediately: true }));
          const stopping = yield* adapter
            .interruptTurn(threadId, pendingTurnId)
            .pipe(Effect.forkChild({ startImmediately: true }));
          const duplicateStop = yield* adapter
            .interruptTurn(threadId)
            .pipe(Effect.forkChild({ startImmediately: true }));
          assert.equal(fake.calls.filter((call) => call.method === "turn/interrupt").length, 0);
          releaseAdmission();
          const admitted = yield* Fiber.join(sending);
          assert.equal((yield* Fiber.join(wrongStop))._tag, "Failure");
          yield* Fiber.join(stopping);
          yield* Fiber.join(duplicateStop);
          assert.equal(admitted.turnId, pendingTurnId);
          assert.deepEqual(
            fake.calls
              .filter((call) => call.method === "turn/interrupt")
              .map((call) => call.params.turnId),
            [pendingTurnId],
          );
          const events = yield* collectUntil(adapter, "turn.completed");
          assert.deepEqual(
            events.filter((event) => event.type === "turn.started").map((event) => event.turnId),
            [pendingTurnId],
          );
          assert.deepEqual(
            events
              .filter((event) => event.type === "turn.completed")
              .map((event) => event.payload.state),
            ["interrupted"],
          );
          assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
          yield* adapter.stopSession(threadId);
        }
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("a stop queued behind rejected admission does not cancel the next turn", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      let markAdmitting = () => {};
      const admitting = new Promise<void>((resolve) => {
        markAdmitting = resolve;
      });
      let releaseAdmission = () => {};
      const admission = new Promise<void>((resolve) => {
        releaseAdmission = resolve;
      });
      fake.beforeTurn(async () => {
        markAdmitting();
        await admission;
        throw new Error("Native admission rejected.");
      });
      const sending = yield* adapter
        .sendTurn({ threadId, input: "Try" })
        .pipe(Effect.result, Effect.forkChild);
      yield* Effect.promise(() => admitting);
      const stopping = yield* adapter
        .interruptTurn(threadId)
        .pipe(Effect.forkChild({ startImmediately: true }));
      releaseAdmission();
      assert.equal((yield* Fiber.join(sending))._tag, "Failure");
      yield* Fiber.join(stopping);
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      fake.beforeTurn(async () => {});
      const admitted = yield* adapter.sendTurn({ threadId, input: "Try again" });
      assert.isFalse(fake.calls.some((call) => call.method === "turn/interrupt"));
      assert.equal((yield* adapter.listSessions())[0]?.activeTurnId, admitted.turnId);
      fake.emit("turn/completed", { turnId: admitted.turnId, terminal: "completed" });
      const events = yield* collectUntil(adapter, "turn.completed");
      assert.deepEqual(
        events.filter((event) => event.type === "turn.started").map((event) => event.turnId),
        [admitted.turnId],
      );
      assert.deepEqual(
        events.filter((event) => event.type === "turn.completed").map((event) => event.turnId),
        [admitted.turnId],
      );
      assert.isFalse(events.some((event) => event.type === "runtime.error"));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejected submissions create no turn or checkpoint and allow a later admitted turn",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeHost();
        const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
        yield* adapter.startSession(startInput);
        const invalid = yield* Effect.result(
          adapter.sendTurn({
            threadId,
            input: "Try",
            modelSelection: {
              instanceId: ProviderInstanceId.make("muse"),
              model: "muse-spark-1.3-contributor",
              options: [{ id: "reasoningEffort", value: "invalid-effort" }],
            },
          }),
        );
        assert.equal(invalid._tag, "Failure");
        assert.isFalse(fake.calls.some((call) => call.method === "turn/start"));
        fake.reject("turn/start");
        const rejected = yield* Effect.result(adapter.sendTurn({ threadId, input: "Try" }));
        assert.equal(rejected._tag, "Failure");
        assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
        fake.reject();
        const admitted = yield* adapter.sendTurn({ threadId, input: "Try again" });
        fake.emit("turn/completed", { turnId: admitted.turnId, terminal: "completed" });
        const events = yield* collectUntil(adapter, "turn.completed");
        assert.deepEqual(
          events.filter((event) => event.type === "turn.started").map((event) => event.turnId),
          [admitted.turnId],
        );
        assert.deepEqual(
          events.filter((event) => event.type === "turn.completed").map((event) => event.turnId),
          [admitted.turnId],
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "does not reopen a native turn that completes before its admission acknowledgement",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeHost();
        const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
        yield* adapter.startSession(startInput);
        fake.deferTurnStarted();
        fake.beforeTurn(async (commandId) => {
          fake.emit("turn/started", { turnId: commandId });
          fake.emit("item/completed", {
            item: {
              itemId: "fast-answer",
              turnId: commandId,
              kind: "agentMessage",
              revision: 1,
              status: "completed",
              text: "Finished before admission returned",
            },
          });
          fake.emit("turn/completed", { turnId: commandId, terminal: "completed" });
        });
        const admitted = yield* adapter.sendTurn({ threadId, input: "Quick response" });
        const sessions = yield* adapter.listSessions();
        assert.equal(sessions[0]?.status, "ready");
        assert.isUndefined(sessions[0]?.activeTurnId);
        yield* adapter.stopSession(threadId);
        const events = yield* collectUntil(adapter, "session.exited");
        assert.deepEqual(
          events.filter((event) => event.type === "turn.started").map((event) => event.turnId),
          [admitted.turnId],
        );
        assert.deepEqual(
          events.filter((event) => event.type === "turn.completed").map((event) => event.turnId),
          [admitted.turnId],
        );
        assert.deepEqual(
          events
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta),
          ["Finished before admission returned"],
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("scoped disposal closes every instance-owned host", () =>
    Effect.gen(function* () {
      const first = makeFakeHost();
      const second = makeFakeHost();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const firstAdapter = yield* makeMuseAdapter(settings, {
            createHost: async () => first.host,
            instanceId: ProviderInstanceId.make("one"),
          });
          const secondAdapter = yield* makeMuseAdapter(settings, {
            createHost: async () => second.host,
            instanceId: ProviderInstanceId.make("two"),
          });
          yield* firstAdapter.startSession(startInput);
          yield* secondAdapter.startSession(startInput);
          yield* firstAdapter.stopAll();
          assert.equal(first.closeCount, 1);
          assert.equal(second.closeCount, 0);
          assert.isTrue(yield* secondAdapter.hasSession(threadId));
        }),
      );
      assert.equal(second.closeCount, 1);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("renders command details and output through the shared work log payload", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Inspect" });
      fake.emit("item/completed", {
        item: {
          itemId: "shell",
          turnId: turn.turnId,
          kind: "toolCall",
          revision: 1,
          status: "completed",
          tool: "shell",
          args: '{"command":"git status"}',
          visibleOutput: "working tree clean",
        },
      });
      const events = yield* collectUntil(adapter, "item.completed");
      const item = events.find((event) => event.type === "item.completed");
      assert.equal(item?.payload.itemType, "command_execution");
      assert.equal(item?.payload.detail, "git status");
      assert.deepInclude(item?.payload.data, {
        input: { command: "git status" },
        rawOutput: "working tree clean",
        toolName: "shell",
      });
      fake.emit("item/completed", {
        item: {
          itemId: "search",
          turnId: turn.turnId,
          kind: "toolCall",
          revision: 1,
          status: "rejected",
          tool: "search_files",
          args: "incomplete {",
        },
      });
      const rejected = (yield* collectUntil(adapter, "item.completed")).find(
        (event) => event.type === "item.completed",
      );
      assert.equal(rejected?.payload.itemType, "dynamic_tool_call");
      assert.equal(rejected?.payload.status, "declined");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("maps native todo, context usage and cache-normalized turn usage", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Work" });
      fake.emit("session/todoListChanged", {
        items: [
          { text: "Investigate", status: "completed" },
          { text: "Fix", status: "inProgress" },
          { text: "Abandoned", status: "cancelled" },
        ],
      });
      fake.emit("session/contextUsage", { usedTokens: 1300, windowTokens: 100000 });
      const usage = {
        inputTokens: 100,
        outputTokens: 20,
        cachedTokens: 50,
        cacheReadTokens: 30,
        cacheWriteTokens: 20,
        reasoningTokens: 10,
      };
      fake.emit("session/tokenUsage", { turnId: turn.turnId, promptTokens: 150, usage });
      fake.emit("turn/completed", { turnId: turn.turnId, terminal: "completed", usage });
      const events = yield* collectUntil(adapter, "turn.completed");
      assert.deepEqual(events.find((event) => event.type === "turn.plan.updated")?.payload.plan, [
        { step: "Investigate", status: "completed" },
        { step: "Fix", status: "inProgress" },
      ]);
      assert.deepEqual(
        events.find((event) => event.type === "thread.token-usage.updated")?.payload.usage,
        {
          usedTokens: 1300,
          maxTokens: 100000,
        },
      );
      assert.deepEqual(
        events.find((event) => event.type === "turn.completed")?.payload.tokenUsage,
        {
          usageScope: "main_agent",
          usageStatus: "complete",
          hasSubagents: false,
          inputTokens: 150,
          outputTokens: 20,
          cachedInputTokens: 30,
          cacheCreationTokens: 20,
          reasoningTokens: 10,
        },
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "retains observed partial usage when the native host fails before the turn terminal",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeHost();
        const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
        yield* adapter.startSession(startInput);
        const turn = yield* adapter.sendTurn({ threadId, input: "Work" });
        fake.emit("session/tokenUsage", {
          turnId: turn.turnId,
          promptTokens: 200,
          usage: { inputTokens: 100, outputTokens: 25, cachedTokens: 100, reasoningTokens: 5 },
        });
        fake.emit("session/contextUsage", { usedTokens: 225 });
        yield* collectUntil(adapter, "thread.token-usage.updated");
        fake.crash();
        const events = yield* collectUntil(adapter, "session.exited");
        assert.deepEqual(
          events.find((event) => event.type === "turn.completed")?.payload.tokenUsage,
          {
            usageScope: "main_agent",
            usageStatus: "partial",
            hasSubagents: false,
            inputTokens: 200,
            outputTokens: 25,
            cachedInputTokens: 100,
            reasoningTokens: 5,
          },
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps native subagent lifecycle visible after its parent turn finishes", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Delegate" });
      const child = {
        itemId: "child-item",
        subagentId: "child",
        childSessionId: "child-session",
        turnId: turn.turnId,
        kind: "subagent",
        revision: 1,
        status: "inProgress",
        controlStatus: "running",
        objective: "Review the patch",
        role: "reviewer",
      };
      fake.emit("item/started", { item: child });
      fake.emit("turn/completed", { turnId: turn.turnId, terminal: "completed" });
      const events = yield* collectUntil(adapter, "turn.completed");
      assert.deepEqual(events.find((event) => event.type === "task.started")?.payload, {
        taskId: RuntimeTaskId.make("child"),
        taskType: "subagent",
        title: "Review the patch",
        description: "Review the patch",
        role: "reviewer",
      });
      fake.emit("item/completed", {
        item: {
          ...child,
          revision: 2,
          status: "completed",
          result: { summary: "No issues found" },
        },
      });
      const completed = (yield* collectUntil(adapter, "task.completed")).find(
        (event) => event.type === "task.completed",
      );
      assert.equal(completed?.turnId, turn.turnId);
      assert.deepEqual(completed?.payload, {
        taskId: RuntimeTaskId.make("child"),
        taskType: "subagent",
        title: "Review the patch",
        role: "reviewer",
        status: "completed",
        summary: "No issues found",
      });
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "stopping the session settles unfinished subagents and ignores obsolete questions",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeHost();
        const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
        yield* adapter.startSession(startInput);
        const turn = yield* adapter.sendTurn({ threadId, input: "Delegate" });
        fake.emit("item/started", {
          item: {
            itemId: "child",
            kind: "subagent",
            turnId: turn.turnId,
            revision: 1,
            status: "inProgress",
          },
        });
        fake.emit("turn/completed", { turnId: turn.turnId, terminal: "completed" });
        fake.emit("userInput/requested", {
          userInputId: "stale",
          turnId: turn.turnId,
          questions: [],
        });
        yield* collectUntil(adapter, "turn.completed");
        yield* adapter.stopSession(threadId);
        const events = yield* collectUntil(adapter, "session.exited");
        assert.isFalse(events.some((event) => event.type === "user-input.requested"));
        assert.equal(
          events.find((event) => event.type === "task.completed")?.payload.status,
          "stopped",
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "tracks the authoritative new turn when a steering target finishes before admission",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeHost();
        const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
        yield* adapter.startSession(startInput);
        const first = yield* adapter.sendTurn({ threadId, input: "First" });
        fake.beforeTurn(async () => {
          fake.emit("turn/completed", { turnId: first.turnId, terminal: "completed" });
        });
        const second = yield* adapter.sendTurn({ threadId, input: "Second" });
        assert.notEqual(second.turnId, first.turnId);
        fake.emit("item/completed", {
          item: {
            itemId: "second-reply",
            turnId: second.turnId,
            kind: "agentMessage",
            revision: 1,
            status: "completed",
            text: "Second response",
          },
        });
        fake.emit("turn/completed", { turnId: second.turnId, terminal: "completed" });
        const events = yield* Stream.runCollect(
          adapter.streamEvents.pipe(
            Stream.takeUntil(
              (event) => event.type === "turn.completed" && event.turnId === second.turnId,
            ),
          ),
        );
        assert.equal(events.filter((event) => event.type === "turn.completed").length, 2);
        assert.equal(events.filter((event) => event.type === "turn.started").length, 2);
        assert.isTrue(
          events.some(
            (event) =>
              event.type === "content.delta" &&
              event.turnId === second.turnId &&
              event.payload.delta === "Second response",
          ),
        );
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "closes a host that finishes initialization after its adapter scope and ends the event stream",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeHost();
        let resolveHost = (_host: MuseSdkHost) => {};
        let markStarted = () => {};
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const pendingHost = new Promise<MuseSdkHost>((resolve) => {
          resolveHost = resolve;
        });
        const scope = yield* Scope.make();
        const adapter = yield* makeMuseAdapter(settings, {
          createHost: () => {
            markStarted();
            return pendingHost;
          },
        }).pipe(Scope.provide(scope));
        const starting = yield* adapter
          .startSession(startInput)
          .pipe(Effect.result, Effect.forkChild);
        yield* Effect.promise(() => started);
        yield* Scope.close(scope, Exit.void);
        resolveHost(fake.host);
        const outcome = yield* Fiber.join(starting);
        assert.equal(outcome._tag, "Failure");
        assert.equal(fake.closeCount, 1);
        assert.isFalse(yield* adapter.hasSession(threadId));
        assert.isTrue(Exit.isFailure(yield* Effect.exit(Stream.runDrain(adapter.streamEvents))));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("shows native retry progress without completing the turn", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Continue" });
      const retry = {
        turnId: turn.turnId,
        attempt: 1,
        nextAttempt: 2,
        maxAttempts: 3,
        reason: "Provider temporarily unavailable",
        retryDelayMs: 1500,
      };
      fake.emit("turn/retryScheduled", { ...retry, turnId: "older-turn" });
      fake.emit("turn/retryScheduled", retry);
      const events = yield* collectUntil(adapter, "runtime.warning");
      assert.equal(events.filter((event) => event.type === "runtime.warning").length, 1);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 0);
      const warning = events.find((event) => event.type === "runtime.warning");
      assert.include(warning?.payload.message, "attempt 2 of 3");
      assert.include(warning?.payload.detail, "2 seconds");
      assert.equal((yield* adapter.listSessions())[0]?.status, "running");
      fake.emit("turn/completed", { turnId: turn.turnId, terminal: "completed" });
      yield* collectUntil(adapter, "turn.completed");
      assert.equal((yield* adapter.listSessions())[0]?.status, "ready");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("preserves native reminder activity without inventing a delegated agent", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Reply without using tools" });
      fake.emit("item/completed", {
        item: {
          itemId: "reminder-item",
          turnId: turn.turnId,
          kind: "reminderChild",
          revision: 1,
          status: "completed",
          fallbackText: "Reminder child session",
          childSessionId: "reminder-session",
        },
      });
      const events = yield* collectUntil(adapter, "item.completed");
      const completed = events.find((event) => event.type === "item.completed");
      assert.equal(completed?.payload.title, "Reminder");
      assert.equal(completed?.payload.detail, "Reminder child session");
      assert.equal(completed?.payload.status, "completed");
      assert.deepInclude(completed?.payload.data, {
        item: {
          itemId: "reminder-item",
          turnId: turn.turnId,
          kind: "reminderChild",
          revision: 1,
          status: "completed",
          fallbackText: "Reminder child session",
          childSessionId: "reminder-session",
        },
      });
      assert.isFalse(events.some((event) => event.type.startsWith("task.")));
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("keeps unfamiliar Muse activity visible without inventing a failure", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Run workflow" });
      fake.emit("item/completed", {
        item: {
          itemId: "future-item",
          turnId: turn.turnId,
          kind: "futureWorkflow",
          revision: 1,
          status: "handedOff",
          fallbackText: "Work handed to the next stage",
        },
      });
      const events = yield* collectUntil(adapter, "item.completed");
      const completed = events.find((event) => event.type === "item.completed");
      assert.equal(completed?.payload.itemType, "dynamic_tool_call");
      assert.equal(completed?.payload.title, "futureWorkflow");
      assert.include(completed?.payload.detail, "handedOff");
      assert.include(completed?.payload.detail, "Work handed to the next stage");
      assert.isUndefined(completed?.payload.status);
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("warns once when a Muse output surface is truncated", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const turn = yield* adapter.sendTurn({ threadId, input: "Long response" });
      const item = {
        itemId: "clipped-reply",
        turnId: turn.turnId,
        kind: "agentMessage",
        revision: 1,
        status: "inProgress",
        text: "Visible prefix",
        truncated: true,
      };
      fake.emit("item/updated", { item });
      fake.emit("item/completed", {
        item: { ...item, revision: 2, status: "completed" },
      });
      fake.emit("turn/completed", { turnId: turn.turnId, terminal: "completed" });
      const events = yield* collectUntil(adapter, "turn.completed");
      const warnings = events.filter((event) => event.type === "runtime.warning");
      assert.equal(warnings.length, 1);
      assert.include(warnings[0]?.payload.message, "shortened");
      assert.equal(warnings[0]?.itemId, "clipped-reply");
      assert.deepEqual(
        events
          .filter((event) => event.type === "content.delta")
          .map((event) => event.payload.delta),
        ["Visible prefix"],
      );
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "accepts a steering successor before the predecessor terminal notification arrives",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeHost();
        const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
        yield* adapter.startSession(startInput);
        const first = yield* adapter.sendTurn({ threadId, input: "First" });
        fake.resumeTurn();
        fake.deferTurnStarted();
        const second = yield* adapter.sendTurn({ threadId, input: "Second" });
        assert.notEqual(second.turnId, first.turnId);
        fake.emit("turn/completed", { turnId: first.turnId, terminal: "completed" });
        fake.emit("turn/started", { turnId: second.turnId });
        fake.emit("turn/completed", { turnId: second.turnId, terminal: "completed" });
        const events = yield* Stream.runCollect(
          adapter.streamEvents.pipe(
            Stream.takeUntil(
              (event) => event.type === "turn.completed" && event.turnId === second.turnId,
            ),
          ),
        );
        assert.deepEqual(
          events.filter((event) => event.type === "turn.started").map((event) => event.turnId),
          [first.turnId, second.turnId],
        );
        assert.deepEqual(
          events
            .filter((event) => event.type === "turn.completed")
            .map((event) => event.payload.state),
          ["completed", "completed"],
        );
        assert.isFalse(events.some((event) => event.type === "runtime.error"));
      }).pipe(Effect.provide(testLayer)),
  );

  it.effect("tracks the successor when a steering start notification arrives after admission", () =>
    Effect.gen(function* () {
      const fake = makeFakeHost();
      const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
      yield* adapter.startSession(startInput);
      const first = yield* adapter.sendTurn({ threadId, input: "First" });
      fake.deferTurnStarted();
      fake.beforeTurn(async () => {
        fake.emit("turn/completed", { turnId: first.turnId, terminal: "completed" });
      });
      const second = yield* adapter.sendTurn({ threadId, input: "Second" });
      assert.notEqual(second.turnId, first.turnId);
      fake.emit("turn/started", { turnId: second.turnId });
      fake.emit("item/completed", {
        item: {
          itemId: "reply",
          turnId: second.turnId,
          kind: "agentMessage",
          revision: 1,
          status: "completed",
          text: "Second response",
        },
      });
      fake.emit("turn/completed", { turnId: second.turnId, terminal: "completed" });
      const events = yield* Stream.runCollect(
        adapter.streamEvents.pipe(
          Stream.takeUntil(
            (event) => event.type === "turn.completed" && event.turnId === second.turnId,
          ),
        ),
      );
      assert.equal(events.filter((event) => event.type === "turn.started").length, 2);
      assert.equal(events.filter((event) => event.type === "turn.completed").length, 2);
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "content.delta" &&
            event.turnId === second.turnId &&
            event.payload.delta === "Second response",
        ),
      );
    }).pipe(Effect.provide(testLayer)),
  );
});
