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

  it.effect("keeps a request until it is forgotten, found by what it asks for", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const asked = yield* sessions.recordApprovalRequest(threadId, {
        message: "Merge #5?",
        state: "run-1 merge 5",
      });
      assert.deepInclude(yield* sessions.findApprovalRequest(threadId, "run-1 merge 5"), {
        id: asked,
        message: "Merge #5?",
      });
      // Another turn's state, another thread: not this request.
      assert.isUndefined(yield* sessions.findApprovalRequest(threadId, "run-2 merge 5"));
      assert.isUndefined(
        yield* sessions.findApprovalRequest(ThreadId.make("another-thread"), "run-1 merge 5"),
      );
      yield* sessions.forgetApprovalRequest(threadId, asked);
      assert.isUndefined(yield* sessions.findApprovalRequest(threadId, "run-1 merge 5"));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("a request is settled once, and everyone waiting on it hears the same answer", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const asked = yield* sessions.recordApprovalRequest(threadId, {
        message: "Merge #5?",
        state: "state",
      });
      const other = yield* sessions.recordApprovalRequest(threadId, {
        message: "Merge #5?",
        state: "state",
      });
      const gate = yield* Effect.forkChild(sessions.awaitApprovalAnswer(threadId, asked));
      const adapter = yield* Effect.forkChild(sessions.awaitApprovalAnswer(threadId, asked));
      yield* Effect.yieldNow;
      assert.isTrue(Option.isNone(yield* sessions.approvalAnswer(threadId, asked)));

      yield* sessions.settleApprovalRequest(threadId, asked, "accepted");
      // The first answer stands.
      yield* sessions.settleApprovalRequest(threadId, asked, "declined");
      assert.equal(yield* Fiber.join(gate), "accepted");
      assert.equal(yield* Fiber.join(adapter), "accepted");
      assert.deepEqual(yield* sessions.approvalAnswer(threadId, asked), Option.some("accepted"));
      // Two calls asking the same thing are answered one at a time.
      assert.isTrue(Option.isNone(yield* sessions.approvalAnswer(threadId, other)));
      // A request is settled in its own thread only.
      yield* sessions.settleApprovalRequest(ThreadId.make("another-thread"), other, "accepted");
      assert.isTrue(Option.isNone(yield* sessions.approvalAnswer(threadId, other)));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("a request that is gone was cancelled, to whoever still waits or asks", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set(makeSession("provider-session-1"));
      const forgotten = yield* sessions.recordApprovalRequest(threadId, {
        message: "Merge #5?",
        state: "a",
      });
      const replaced = yield* sessions.recordApprovalRequest(threadId, {
        message: "Merge #6?",
        state: "b",
      });
      const waitsOnForgotten = yield* Effect.forkChild(
        sessions.awaitApprovalAnswer(threadId, forgotten),
      );
      const waitsOnReplaced = yield* Effect.forkChild(
        sessions.awaitApprovalAnswer(threadId, replaced),
      );
      yield* Effect.yieldNow;
      yield* sessions.forgetApprovalRequest(threadId, forgotten);
      assert.equal(yield* Fiber.join(waitsOnForgotten), "cancelled");
      // A new provider session, or the thread's session ending, takes its requests with it.
      yield* sessions.set(makeSession("provider-session-2"));
      assert.equal(yield* Fiber.join(waitsOnReplaced), "cancelled");
      assert.equal(yield* sessions.awaitApprovalAnswer(threadId, replaced), "cancelled");
      assert.isUndefined(yield* sessions.findApprovalRequest(threadId, "b"));

      const cleared = yield* sessions.recordApprovalRequest(threadId, {
        message: "Merge #7?",
        state: "c",
      });
      yield* sessions.clear(threadId);
      assert.equal(yield* sessions.awaitApprovalAnswer(threadId, cleared), "cancelled");
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

      const asked = yield* sessions.recordApprovalRequest(threadId, {
        message: "Merge #5?",
        state: "state",
      });
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
