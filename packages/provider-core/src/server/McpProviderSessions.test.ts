import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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
  const pushHooks = { branch: "tools", files: [".husky/pre-push"], commands: [] };
  const makeSession = (providerSessionId: string) => ({
    environmentId: EnvironmentId.make("env-approval-requests"),
    threadId,
    providerSessionId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1/mcp",
    authorizationHeader: "Bearer token",
    browserToolsAvailable: false,
  });

  it.effect("keeps what a thread was asked until it is answered, per thread and message", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const asked = yield* sessions.recordApprovalRequest(threadId, {
        message: "Push tools?",
        pushHooks,
      });

      assert.deepInclude(yield* sessions.findApprovalRequest(threadId, "Push tools?"), {
        message: "Push tools?",
        pushHooks,
      });
      // Showing the request does not end it.
      assert.isDefined(yield* sessions.findApprovalRequest(threadId, "Push tools?"));
      assert.isUndefined(yield* sessions.findApprovalRequest(threadId, "Push tools!"));
      assert.isUndefined(
        yield* sessions.findApprovalRequest(ThreadId.make("another-thread"), "Push tools?"),
      );

      yield* sessions.forgetApprovalRequest(threadId, asked);
      assert.isUndefined(yield* sessions.findApprovalRequest(threadId, "Push tools?"));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("an answer forgets only the request it answers", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      // Two calls asking the same thing are answered one at a time, each once.
      const first = yield* sessions.recordApprovalRequest(threadId, {
        message: "Push tools?",
        pushHooks,
      });
      const second = yield* sessions.recordApprovalRequest(threadId, {
        message: "Push tools?",
        pushHooks,
      });
      yield* sessions.forgetApprovalRequest(threadId, first);
      yield* sessions.forgetApprovalRequest(threadId, first);
      assert.deepInclude(yield* sessions.findApprovalRequest(threadId, "Push tools?"), {
        message: "Push tools?",
        pushHooks,
      });
      yield* sessions.forgetApprovalRequest(threadId, second);
      assert.isUndefined(yield* sessions.findApprovalRequest(threadId, "Push tools?"));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("a request that ends after its session was replaced leaves the new session's", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set(makeSession("provider-session-1"));
      const earlier = yield* sessions.recordApprovalRequest(threadId, {
        message: "Push tools?",
        pushHooks,
      });
      yield* sessions.set(makeSession("provider-session-2"));
      yield* sessions.recordApprovalRequest(threadId, { message: "Push tools?", pushHooks });

      yield* sessions.forgetApprovalRequest(threadId, earlier);
      assert.deepInclude(yield* sessions.findApprovalRequest(threadId, "Push tools?"), {
        message: "Push tools?",
        pushHooks,
      });
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("keeps the person's answer with the requests that ask that message, once", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const tools = yield* sessions.recordApprovalRequest(threadId, {
        message: "Push tools?",
        pushHooks,
        state: "digest-1 1",
      });
      const docs = yield* sessions.recordApprovalRequest(threadId, { message: "Push docs?" });
      const elsewhere = yield* sessions.recordApprovalRequest(ThreadId.make("another-thread"), {
        message: "Push tools?",
      });

      yield* sessions.answerApprovalRequests(threadId, "Push tools?", true);
      // The first answer stands.
      yield* sessions.answerApprovalRequests(threadId, "Push tools?", false);
      // Asked after the answer: not answered by it.
      const later = yield* sessions.recordApprovalRequest(threadId, { message: "Push tools?" });

      assert.deepInclude(yield* sessions.takeApprovalRequest(threadId, tools), {
        approved: true,
        state: "digest-1 1",
      });
      assert.isUndefined(yield* sessions.takeApprovalRequest(threadId, tools));
      assert.notProperty(yield* sessions.takeApprovalRequest(threadId, docs), "approved");
      assert.notProperty(yield* sessions.takeApprovalRequest(threadId, later), "approved");
      assert.notProperty(
        yield* sessions.takeApprovalRequest(ThreadId.make("another-thread"), elsewhere),
        "approved",
      );
      // A request is taken from its own thread only.
      assert.isUndefined(yield* sessions.takeApprovalRequest(threadId, elsewhere));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("an answer does not outlive the thread's session", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.set(makeSession("provider-session-1"));
      const asked = yield* sessions.recordApprovalRequest(threadId, { message: "Push tools?" });
      yield* sessions.answerApprovalRequests(threadId, "Push tools?", true);
      yield* sessions.set(makeSession("provider-session-2"));
      assert.isUndefined(yield* sessions.takeApprovalRequest(threadId, asked));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("knows which provider instances show T3 Code's own requests", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      const codex = ProviderInstanceId.make("codex");
      assert.isFalse(yield* sessions.areApprovalRequestsShown(codex));
      yield* sessions.showsApprovalRequests(codex);
      assert.isTrue(yield* sessions.areApprovalRequestsShown(codex));
      assert.isFalse(yield* sessions.areApprovalRequestsShown(ProviderInstanceId.make("other")));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect("drops what was asked when the thread's session ends", () =>
    Effect.gen(function* () {
      const sessions = yield* McpProviderSessions.McpProviderSessions;
      yield* sessions.recordApprovalRequest(threadId, { message: "Push tools?", pushHooks });
      yield* sessions.clear(threadId);
      assert.isUndefined(yield* sessions.findApprovalRequest(threadId, "Push tools?"));
    }).pipe(Effect.provide(McpProviderSessions.layer)),
  );
});
