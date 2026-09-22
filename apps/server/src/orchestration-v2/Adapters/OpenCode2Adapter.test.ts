import { describe, it, assert } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { FormInfo } from "@opencode/client";
import * as Stream from "effect/Stream";
import * as Layer from "effect/Layer";
import * as Native from "../../provider/OpenCode2Client.ts";
import { IdAllocatorV2, layer as idsLayer } from "../IdAllocator.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2TurnInput } from "../ProviderAdapter.ts";
import * as Adapter from "./OpenCode2Adapter.ts";

function httpFixture() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const closed = new WeakSet<ReadableStreamDefaultController<Uint8Array>>();
  let finish!: () => void;
  let wait = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  let history: unknown[] = [];
  let forms: FormInfo[] = [];
  let admission: Promise<void> | undefined;
  let admit: (() => void) | undefined;
  let outcome = "succeeded";
  let count = 0;
  const encoder = new TextEncoder();
  const push = (type: string, data: unknown) =>
    controller.enqueue(
      encoder.encode(
        `data: ${JSON.stringify({ id: `event_${count++}`, created: 1, type, data })}\n\n`,
      ),
    );
  const session = () => ({
    id: "ses_test",
    location: { directory: "/workspace" },
    time: { created: 1, updated: 1 },
    outcome,
  });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    requests.push({ path: url.pathname, body });
    if (url.pathname === "/api/event")
      return new Response(
        new ReadableStream<Uint8Array>({
          start(value) {
            controller = value;
            push("server.connected", {});
            init?.signal?.addEventListener(
              "abort",
              () => {
                if (!closed.has(value)) {
                  closed.add(value);
                  value.close();
                }
              },
              { once: true },
            );
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    if (url.pathname.endsWith("/wait")) {
      await wait;
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/form/frm_question/reply")) {
      forms = [];
      admit?.();
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/form/frm_question") && init?.method === "DELETE") {
      forms = [];
      admit?.();
      return new Response(null, { status: 204 });
    }
    if (url.pathname.endsWith("/prompt")) {
      if (admission) await admission;
      return Response.json({ data: { id: "msg_user", type: "user", text: body.text } });
    }
    if (url.pathname.endsWith("/interrupt")) {
      outcome = "interrupted";
      finish();
      return Response.json({ data: { interrupted: true } });
    }
    if (url.pathname.endsWith("/message")) return Response.json({ data: history, cursor: {} });
    if (url.pathname.endsWith("/form")) return Response.json({ data: forms });
    if (url.pathname.endsWith("/permission")) return Response.json({ data: [] });
    if (
      url.pathname === "/api/session" ||
      (url.pathname === "/api/session/ses_test" && (!init?.method || init.method === "GET"))
    )
      return Response.json({ data: session() });
    return new Response(null, { status: 204 });
  };
  return {
    fetch,
    push,
    requests,
    drop: () => {
      closed.add(controller);
      controller.close();
    },
    setForms: (value: FormInfo[]) => {
      forms = value;
    },
    blockAdmission: () => {
      admission = new Promise<void>((resolve) => {
        admit = resolve;
      });
    },
    finish: () => finish(),
    setHistory: (value: unknown[]) => {
      history = value;
    },
    reset: () => {
      outcome = "succeeded";
      wait = new Promise<void>((resolve) => {
        finish = resolve;
      });
    },
  };
}

const harness = Effect.fn("OpenCode2Test.harness")(function* () {
  const http = httpFixture();
  const ids = yield* IdAllocatorV2;
  const instanceId = ProviderInstanceId.make("opencode-instance");
  const threadId = ThreadId.make("thread-native");
  const modelSelection = { instanceId, model: "test/model", options: [] };
  const runtimePolicy = {
    cwd: "/workspace",
    runtimeMode: "approval-required" as const,
    interactionMode: "default" as const,
  };
  const adapter = Adapter.make({
    instanceId,
    idAllocator: ids,
    fileSystem: yield* FileSystem.FileSystem,
    serverConfig: { cwd: "/workspace", attachmentsDir: "/attachments" },
    connect: Effect.succeed(Native.make({ url: "http://native.test", fetch: http.fetch })),
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("provider-session"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const now = yield* DateTime.now;
  const input: ProviderAdapterV2TurnInput = {
    threadId,
    runId: RunId.make("run-one"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("attempt-one"),
    rootNodeId: NodeId.make("root-one"),
    providerThread,
    modelSelection,
    runtimePolicy,
    message: {
      messageId: MessageId.make("message-one"),
      text: "hello",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    appThread: {
      id: threadId,
      projectId: ProjectId.make("project"),
      title: "Native test",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  };
  const events: ProviderAdapterV2Event[] = [];
  const listeners: Array<{
    predicate: (event: ProviderAdapterV2Event) => boolean;
    receipt: Deferred.Deferred<ProviderAdapterV2Event>;
  }> = [];
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        events.push(event);
        for (const listener of listeners)
          if (listener.predicate(event)) yield* Deferred.succeed(listener.receipt, event);
      }),
    ),
    Effect.forkScoped,
  );
  const until = Effect.fnUntraced(function* (
    predicate: (event: ProviderAdapterV2Event) => boolean,
  ) {
    const found = events.find(predicate);
    if (found) return found;
    const receipt = yield* Deferred.make<ProviderAdapterV2Event>();
    listeners.push({ predicate, receipt });
    return yield* Deferred.await(receipt);
  });
  return { http, runtime, input, events, until };
});

const testLayer = idsLayer.pipe(Layer.provideMerge(NodeServices.layer));
const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.scoped, Effect.provide(testLayer));

describe("native OpenCode 2 adapter", () => {
  const question: FormInfo = {
    id: "frm_question",
    sessionID: "ses_test",
    title: "Count",
    fields: [{ key: "count", type: "integer", required: true }],
  };

  it.effect("answers a prompt-hook question while prompt admission is still pending", () =>
    provide(
      Effect.gen(function* () {
        const h = yield* harness();
        h.http.blockAdmission();
        const start = yield* h.runtime.startTurn(h.input).pipe(Effect.forkScoped);
        yield* h.until((event) => event.type === "provider_turn.updated");
        h.http.push("form.created", { form: question });
        const event = yield* h.until(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.kind === "user_input",
        );
        if (event.type !== "runtime_request.updated") return;
        yield* h.runtime.respondToRuntimeRequest({
          requestId: event.runtimeRequest.id,
          answers: { count: "2" },
        });
        yield* Fiber.join(start);
        assert.deepEqual(
          h.http.requests.find((request) => request.path.endsWith("/form/frm_question/reply"))
            ?.body,
          { answer: { count: 2 } },
        );
        h.http.finish();
        yield* h.until((event) => event.type === "turn.terminal");
      }),
    ),
  );

  it.effect("recovers a question missed during an SSE disconnect", () =>
    provide(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.runtime.startTurn(h.input);
        h.http.setForms([question]);
        h.http.drop();
        yield* TestClock.adjust("250 millis");
        const event = yield* h.until(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.kind === "user_input",
        );
        if (event.type !== "runtime_request.updated") return;
        const invalid = yield* h.runtime
          .respondToRuntimeRequest({
            requestId: event.runtimeRequest.id,
            answers: { count: "1.5" },
          })
          .pipe(Effect.exit);
        assert.equal(invalid._tag, "Failure");
        yield* h.runtime.respondToRuntimeRequest({
          requestId: event.runtimeRequest.id,
          answers: { count: "3" },
        });
        h.http.finish();
        yield* h.until((event) => event.type === "turn.terminal");
        assert.equal(
          h.events.filter(
            (value) =>
              value.type === "runtime_request.updated" && value.runtimeRequest.status === "pending",
          ).length,
          1,
        );
      }),
    ),
  );

  it.effect("Stop cancels a prompt-hook question before waiting for admission", () =>
    provide(
      Effect.gen(function* () {
        const h = yield* harness();
        h.http.blockAdmission();
        const start = yield* h.runtime.startTurn(h.input).pipe(Effect.forkScoped);
        const turn = yield* h.until((event) => event.type === "provider_turn.updated");
        h.http.push("form.created", { form: question });
        yield* h.until(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        if (turn.type !== "provider_turn.updated") return;
        yield* h.runtime.interruptTurn({
          providerThread: h.input.providerThread,
          providerTurnId: turn.providerTurn.id,
        });
        yield* Fiber.await(start);
        const terminal = yield* h.until((event) => event.type === "turn.terminal");
        assert.isTrue(terminal.type === "turn.terminal" && terminal.status === "interrupted");
        const cancelled = h.http.requests.findIndex((request) =>
          request.path.endsWith("/form/frm_question"),
        );
        const interrupted = h.http.requests.findIndex((request) =>
          request.path.endsWith("/interrupt"),
        );
        assert.isTrue(cancelled >= 0 && interrupted > cancelled);
      }),
    ),
  );
  it.effect("streams whitespace exactly and reconciles final output before completion", () =>
    provide(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.runtime.startTurn(h.input);
        h.http.push("session.text.delta", {
          sessionID: "ses_test",
          assistantMessageID: "msg_answer",
          ordinal: 0,
          delta: "Hello",
        });
        h.http.push("session.text.delta", {
          sessionID: "ses_test",
          assistantMessageID: "msg_answer",
          ordinal: 0,
          delta: " \n",
        });
        h.http.push("session.text.delta", {
          sessionID: "ses_test",
          assistantMessageID: "msg_answer",
          ordinal: 0,
          delta: "world",
        });
        yield* h.until(
          (event) => event.type === "message.updated" && event.message.text === "Hello \nworld",
        );
        h.http.setHistory([
          {
            id: "msg_answer",
            type: "assistant",
            time: { created: 1, completed: 2 },
            content: [{ type: "text", text: "Hello \nworld!" }],
          },
        ]);
        h.http.finish();
        yield* h.until((event) => event.type === "turn.terminal");
        const terminalIndex = h.events.findIndex((event) => event.type === "turn.terminal");
        const finalIndex = h.events.findIndex(
          (event) =>
            event.type === "message.updated" &&
            event.message.text === "Hello \nworld!" &&
            !event.message.streaming,
        );
        assert.isTrue(finalIndex >= 0 && finalIndex < terminalIndex);
        assert.equal(h.events.filter((event) => event.type === "turn.terminal").length, 1);
      }),
    ),
  );

  it.effect("enforces session rules and sends the actual approval decision", () =>
    provide(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.runtime.startTurn(h.input);
        const update = h.http.requests.find(
          (request) => request.path === "/api/session/ses_test" && "permissions" in request.body,
        );
        assert.isDefined(update);
        h.http.push("permission.asked", {
          id: "per_shell",
          sessionID: "ses_test",
          action: "shell",
          resources: ["printf audit"],
        });
        const event = yield* h.until(
          (event) =>
            event.type === "runtime_request.updated" && event.runtimeRequest.status === "pending",
        );
        assert.equal(event.type, "runtime_request.updated");
        if (event.type !== "runtime_request.updated") return;
        yield* h.runtime.respondToRuntimeRequest({
          requestId: event.runtimeRequest.id,
          decision: "accept",
        });
        const reply = h.http.requests.find((request) =>
          request.path.endsWith("/permission/per_shell/reply"),
        );
        assert.deepEqual(reply?.body, { decision: "once" });
        h.http.finish();
        yield* h.until((event) => event.type === "turn.terminal");
      }),
    ),
  );

  it.effect("restores build after plan and permits a new turn after Stop", () =>
    provide(
      Effect.gen(function* () {
        const h = yield* harness();
        yield* h.runtime.startTurn({
          ...h.input,
          runtimePolicy: { ...h.input.runtimePolicy, interactionMode: "plan" },
        });
        const turn = h.events.find((event) => event.type === "provider_turn.updated");
        const turnEvent =
          turn ?? (yield* h.until((event) => event.type === "provider_turn.updated"));
        if (turnEvent.type !== "provider_turn.updated") return;
        yield* h.runtime.interruptTurn({
          providerThread: h.input.providerThread,
          providerTurnId: turnEvent.providerTurn.id,
        });
        yield* h.until((event) => event.type === "turn.terminal");
        h.http.reset();
        yield* h.runtime.startTurn({
          ...h.input,
          runOrdinal: 2,
          providerTurnOrdinal: 2,
          attemptId: RunAttemptId.make("attempt-two"),
        });
        assert.deepEqual(
          h.http.requests
            .filter((request) => request.path.endsWith("/agent"))
            .map((request) => request.body.agent),
          ["plan", "build"],
        );
        h.http.finish();
        yield* h.until((event) => event.type === "turn.terminal" && event.runOrdinal === 2);
      }),
    ),
  );
});
