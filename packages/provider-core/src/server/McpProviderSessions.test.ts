import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";

import * as McpProviderSessions from "./McpProviderSessions.ts";

describe("McpProviderSessions tool results", () => {
  const threadId = ThreadId.make("thread-tool-results");

  it.effect(
    "requires exact (tool, input, output) match when reported and refuses ambiguous differing outputs",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "A" },
          { isError: true },
        );
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "B" },
          { sentMessage: "B" },
        );

        // A reported error for input B must not drain A's error or B's success.
        assert.strictEqual(
          yield* sessions.takeToolResult(
            threadId,
            "send_to_user",
            { message: "B" },
            { isError: true },
          ),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "send_to_user",
            { message: "A" },
            { isError: true },
          ),
          { isError: true },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "B" }),
          { sentMessage: "B" },
        );

        // Identical inputs with identical outputs are interchangeable.
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Same" },
          { sentMessage: "Same" },
        );
        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Same" },
          { sentMessage: "Same" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Same" }),
          { sentMessage: "Same" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Same" }),
          { sentMessage: "Same" },
        );

        // Identical inputs with differing outputs stay unclaimed on input-only lookup.
        yield* sessions.recordToolResult(
          threadId,
          "delegate_task",
          { task: "Audit" },
          { taskId: "task-1" },
        );
        yield* sessions.recordToolResult(
          threadId,
          "delegate_task",
          { task: "Audit" },
          { taskId: "task-2" },
        );
        assert.strictEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", { task: "Audit" }),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "delegate_task",
            { task: "Audit" },
            { taskId: "task-2" },
          ),
          { taskId: "task-2" },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "delegate_task", { task: "Audit" }),
          { taskId: "task-1" },
        );
      }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("drops stale-session writes and clears unconsumed results on clearToolResults", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set({
        environmentId: EnvironmentId.make("env-tool-results"),
        threadId,
        providerSessionId: "session-2",
        providerInstanceId: ProviderInstanceId.make("codex"),
        endpoint: "http://127.0.0.1/mcp",
        authorizationHeader: "Bearer token",
        browserToolsAvailable: false,
      });
      // A handler finishing for replaced session-1 must not populate session-2.
      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Old" },
        { sentMessage: "Old" },
        { providerSessionId: "session-1" },
      );
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Old" }),
        undefined,
      );

      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Current" },
        { sentMessage: "Current" },
        { providerSessionId: "session-2" },
      );
      const turn1Epoch = yield* sessions.toolResultEpoch(threadId);
      yield* sessions.clearToolResults(threadId);
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Current" }),
        undefined,
      );

      // A handler started in turn 1 that finishes after turn cleanup must not populate turn 2,
      // even when the same provider session is reused.
      yield* sessions.recordToolResult(
        threadId,
        "send_to_user",
        { message: "Late from turn 1" },
        { sentMessage: "Late from turn 1" },
        { providerSessionId: "session-2", epoch: turn1Epoch },
      );
      assert.strictEqual(
        yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Late from turn 1" }),
        undefined,
      );
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});

describe("McpProviderSessions approval requests", () => {
  const threadId = ThreadId.make("thread-approval-requests");
  const makeSession = (providerSessionId: string) => ({
    environmentId: EnvironmentId.make("env-approval-requests"),
    threadId,
    providerSessionId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1/mcp",
    authorizationHeader: "Bearer token",
    browserToolsAvailable: false,
  });

  it.effect("keeps a request until it is forgotten, joined by what it asks for", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const request = { message: "Merge #5?", state: "run-1 merge 5" };
      const asked = yield* sessions.joinApprovalRequest(threadId, request);
      assert.isTrue(asked?.opened);
      // The same state again is the same request, whoever asks.
      assert.deepInclude(yield* sessions.joinApprovalRequest(threadId, request), {
        id: asked!.id,
        opened: false,
      });
      // Another turn's state, another thread: not this request.
      for (const other of [
        yield* sessions.joinApprovalRequest(threadId, { ...request, state: "run-2 merge 5" }),
        yield* sessions.joinApprovalRequest(ThreadId.make("another-thread"), request),
      ]) {
        assert.isTrue(other?.opened);
        assert.notEqual(other?.id, asked!.id);
      }
      assert.isTrue(yield* sessions.forgetApprovalRequest(threadId, asked!.id));
      assert.isTrue((yield* sessions.joinApprovalRequest(threadId, request))?.opened);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("a request is settled once, and everyone waiting on it hears the same answer", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const request = { message: "Merge #5?", state: "state" };
      const asked = (yield* sessions.joinApprovalRequest(threadId, request))!;
      const joined = (yield* sessions.joinApprovalRequest(threadId, request))!;
      const other = (yield* sessions.joinApprovalRequest(threadId, {
        ...request,
        state: "another",
      }))!;
      const gate = yield* Effect.forkChild(joined.answer);
      const adapter = yield* Effect.forkChild(sessions.awaitApprovalAnswer(threadId, asked.id));
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* asked.answered));

      yield* sessions.settleApprovalRequest(threadId, asked.id, "accepted");
      // The first answer stands.
      yield* sessions.settleApprovalRequest(threadId, asked.id, "declined");
      assert.equal(yield* Fiber.join(gate), "accepted");
      assert.equal(yield* Fiber.join(adapter), "accepted");
      assert.deepEqual(yield* joined.answered, Option.some("accepted"));
      // A request is settled by its own id, in its own thread only.
      yield* sessions.settleApprovalRequest(ThreadId.make("another-thread"), other.id, "accepted");
      assert.isTrue(Option.isNone(yield* other.answered));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("of the calls waiting on one request, one takes it away", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const request = { message: "Merge #5?", state: "state" };
      const { id } = (yield* sessions.joinApprovalRequest(threadId, request))!;
      yield* sessions.settleApprovalRequest(threadId, id, "accepted");
      const took = yield* Effect.all(
        Array.from({ length: 5 }, () => sessions.forgetApprovalRequest(threadId, id)),
        { concurrency: "unbounded" },
      );
      assert.deepEqual(took.toSorted(), [false, false, false, false, true]);
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("a request that is gone was cancelled, to whoever still waits or asks", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set(makeSession("provider-session-1"));
      const forgotten = (yield* sessions.joinApprovalRequest(threadId, {
        message: "Merge #5?",
        state: "a",
      }))!;
      const replaced = (yield* sessions.joinApprovalRequest(threadId, {
        message: "Merge #6?",
        state: "b",
      }))!;
      const waitsOnForgotten = yield* Effect.forkChild(forgotten.answer);
      const waitsOnReplaced = yield* Effect.forkChild(
        sessions.awaitApprovalAnswer(threadId, replaced.id),
      );
      yield* Effect.yieldNow;
      yield* sessions.forgetApprovalRequest(threadId, forgotten.id);
      assert.equal(yield* Fiber.join(waitsOnForgotten), "cancelled");
      // A new provider session, or the thread's session ending, takes its requests with it.
      yield* sessions.set(makeSession("provider-session-2"));
      assert.equal(yield* Fiber.join(waitsOnReplaced), "cancelled");
      assert.equal(yield* sessions.awaitApprovalAnswer(threadId, replaced.id), "cancelled");
      assert.equal(yield* replaced.answer, "cancelled");
      assert.isFalse(yield* sessions.forgetApprovalRequest(threadId, replaced.id));

      const cleared = (yield* sessions.joinApprovalRequest(threadId, {
        message: "Merge #7?",
        state: "c",
      }))!;
      yield* sessions.clear(threadId);
      assert.equal(yield* sessions.awaitApprovalAnswer(threadId, cleared.id), "cancelled");
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("a request still waiting for the person is never dropped to make room", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const ask = (n: number) =>
        sessions.joinApprovalRequest(threadId, { message: `Merge #${n}?`, state: `merge ${n}` });
      const kept = yield* Effect.forEach(
        Array.from({ length: McpProviderSessions.MAX_KEPT_APPROVAL_REQUESTS }, (_, n) => n),
        ask,
      );
      // One more is refused, and every request already open still takes its answer.
      assert.isUndefined(yield* ask(100));
      for (const request of kept) assert.isTrue(Option.isNone(yield* request!.answered));
      yield* sessions.settleApprovalRequest(threadId, kept[0]!.id, "accepted");
      assert.equal(yield* kept[0]!.answer, "accepted");
      // An answered one whose call has not come back for it makes room, oldest first.
      yield* sessions.settleApprovalRequest(threadId, kept[3]!.id, "declined");
      assert.isTrue((yield* ask(100))?.opened);
      assert.deepInclude(yield* ask(3), { id: kept[3]!.id, opened: false });
      assert.isTrue((yield* ask(101))?.opened);
      // With every request left waiting on the person, there is no room again.
      assert.isUndefined(yield* ask(3));
      assert.deepInclude(yield* ask(1), { id: kept[1]!.id, opened: false });
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("an adapter is told a request is T3 Code's own by its id, or else by its words", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const instance = ProviderInstanceId.make("codex");
      assert.isFalse(yield* sessions.areApprovalRequestsHeld(instance));
      yield* sessions.holdsApprovalRequests(instance);
      assert.isTrue(yield* sessions.areApprovalRequestsHeld(instance));
      assert.isFalse(yield* sessions.areApprovalRequestsHeld(ProviderInstanceId.make("cursor")));

      const { id: asked } = (yield* sessions.joinApprovalRequest(threadId, {
        message: "Merge #5?",
        state: "state",
      }))!;
      const own = { id: asked, message: "Merge #5?", state: "state" };
      assert.deepEqual(
        yield* sessions.ownApprovalRequest(threadId, { id: asked, message: "anything" }),
        own,
      );
      assert.deepEqual(
        yield* sessions.ownApprovalRequest(threadId, { id: undefined, message: "Merge #5?" }),
        own,
      );
      // An id that is not this thread's request is no request of T3 Code's, whatever its words.
      for (const elicited of [
        { id: "00000000-0000-4000-8000-000000000000", message: "Merge #5?" },
        { id: undefined, message: "Merge #6?" },
      ]) {
        assert.isUndefined(yield* sessions.ownApprovalRequest(threadId, elicited));
      }
      assert.isUndefined(
        yield* sessions.ownApprovalRequest(ThreadId.make("another-thread"), {
          id: asked,
          message: "Merge #5?",
        }),
      );
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});
