import * as NodeServices from "@effect/platform-node/NodeServices";
import { createUuidV7Mint, type NotificationHandler, type ProcessExit } from "@muse-code/sdk";
import {
  ApprovalRequestId,
  MuseSettings,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
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
import type { MuseSdkHost } from "../museSdk.ts";
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
  let beforeTurnAck: (() => Promise<void>) | undefined;
  let beforeSessionAck: (() => Promise<void>) | undefined;
  let deferTurnStarted = false;
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
        if (method === "session/start" || method === "session/resume") {
          nativeSessionId = String(params.sessionId);
          await beforeSessionAck?.();
          return {
            session: {
              sessionId: nativeSessionId,
              modelId: params.modelId ?? "muse-spark-1.3-contributor",
              activeTurnId: activeTurnId ?? null,
            },
            history: { items: historyPages ? null : history },
          };
        }
        if (method === "turn/start") {
          await beforeTurnAck?.();
          activeTurnId ??= options?.commandId;
          if (!deferTurnStarted) emit("turn/started", { turnId: activeTurnId });
          return { turnId: activeTurnId, disposition: "queued" };
        }
        if (method === "turn/interrupt")
          emit("turn/completed", { turnId: activeTurnId, terminal: "cancelled" });
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
    reject: (method: string) => {
      rejectMethod = method;
    },
    beforeTurn: (callback: () => Promise<void>) => {
      beforeTurnAck = callback;
    },
    beforeSession: (callback: () => Promise<void>) => {
      beforeSessionAck = callback;
    },
    resumeTurn: (turnId: string) => {
      activeTurnId = turnId;
    },
    deferTurnStarted: () => {
      deferTurnStarted = true;
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

describe("MuseAdapter", () => {
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
        adapter.respondToRequest(threadId, ApprovalRequestId.make("approval"), "acceptAlways"),
      );
      assert.equal(unavailable._tag, "Failure");
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("approval"), "accept");
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
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("resumed-question"), {
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
        const opened = (yield* collectUntil(adapter, "request.opened")).find(
          (event) => event.type === "request.opened",
        );
        assert.deepEqual(opened?.payload.options, [{ decision: "decline", label: "Deny" }]);
        yield* adapter.respondToRequest(threadId, ApprovalRequestId.make("approval"), "decline");
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
          item: { itemId: outcome, kind: "compaction", revision: 1, status: "completed", outcome },
        });
      }
      fake.emit("session/contextUsage", { usedTokens: 10 });
      const nonFailures = yield* collectUntil(adapter, "thread.token-usage.updated");
      assert.isFalse(nonFailures.some((event) => event.type === "runtime.error"));
      fake.emit("item/completed", {
        item: {
          itemId: "failed-compaction",
          kind: "compaction",
          revision: 1,
          status: "failed",
          outcome: "failed",
          reason: "Summarizer failed",
        },
      });
      const actualFailure = yield* collectUntil(adapter, "runtime.error");
      assert.equal(
        actualFailure.find((event) => event.type === "runtime.error")?.payload.message,
        "Summarizer failed",
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
      yield* collectUntil(adapter, "user-input.requested");
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("question"), {
        q: ["A", "B", "Additional detail"],
      });
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
      yield* collectUntil(adapter, "user-input.requested");
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("custom"), {
        q: "Custom answer",
      });
      assert.deepEqual(
        fake.calls.findLast((call) => call.method === "userInput/answer")?.params.answers,
        [{ questionId: "q", freeText: "Custom answer" }],
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
        const adapter = yield* makeMuseAdapter(settings, { createHost: async () => fake.host });
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
        yield* adapter.stopAll();
        assert.equal(fake.closeCount, 1);
      }
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect(
    "rejected turn submission terminates once and unsupported effort never starts a turn",
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
              options: [{ id: "reasoningEffort", value: "max" }],
            },
          }),
        );
        assert.equal(invalid._tag, "Failure");
        assert.isFalse(fake.calls.some((call) => call.method === "turn/start"));
        fake.reject("turn/start");
        const rejected = yield* Effect.result(adapter.sendTurn({ threadId, input: "Try" }));
        assert.equal(rejected._tag, "Failure");
        const events = yield* collectUntil(adapter, "turn.completed");
        assert.equal(
          events.find((event) => event.type === "turn.completed")?.payload.state,
          "failed",
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
