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

  it.effect(
    "evicts oldest heavy image results under byte budgets without dropping small metadata",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const otherThread = ThreadId.make("thread-tool-results-other");
        const bigPayload = (tag: string) => ({
          content: [{ type: "image", mimeType: "image/png", data: tag.repeat(4_000_000) }],
        });

        yield* sessions.recordToolResult(
          threadId,
          "send_to_user",
          { message: "Keep me" },
          { sentMessage: "Keep me" },
        );
        for (const tag of ["A", "B", "C", "D", "E"]) {
          yield* sessions.recordToolResult(
            threadId,
            "preview_snapshot",
            { tabId: tag, includeImage: true },
            bigPayload(tag),
          );
        }

        // Small metadata survived heavy image evictions; oldest heavy entries were evicted to stay <= 16 MiB/thread.
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "send_to_user", { message: "Keep me" }),
          { sentMessage: "Keep me" },
        );
        assert.strictEqual(
          yield* sessions.takeToolResult(threadId, "preview_snapshot", {
            tabId: "A",
            includeImage: true,
          }),
          undefined,
        );
        assert.isDefined(
          yield* sessions.takeToolResult(threadId, "preview_snapshot", {
            tabId: "E",
            includeImage: true,
          }),
        );

        // Global byte budget evicts oldest heavy entries across threads without dropping small metadata.
        yield* sessions.recordToolResult(
          otherThread,
          "send_to_user",
          { message: "Other keep" },
          { sentMessage: "Other keep" },
        );
        for (let i = 0; i < 6; i += 1) {
          const t = ThreadId.make(`thread-global-${i}`);
          for (const k of ["1", "2"]) {
            yield* sessions.recordToolResult(
              t,
              "device_screenshot",
              { deviceId: `${i}-${k}` },
              { content: [{ type: "image", mimeType: "image/png", data: k.repeat(3_500_000) }] },
            );
          }
        }
        assert.deepEqual(
          yield* sessions.takeToolResult(otherThread, "send_to_user", { message: "Other keep" }),
          { sentMessage: "Other keep" },
        );
        assert.strictEqual(
          yield* sessions.takeToolResult(ThreadId.make("thread-global-0"), "device_screenshot", {
            deviceId: "0-1",
          }),
          undefined,
        );
        assert.isDefined(
          yield* sessions.takeToolResult(ThreadId.make("thread-global-5"), "device_screenshot", {
            deviceId: "5-2",
          }),
        );
      }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect(
    "refuses input-only recovery after evicting a sibling with identical input and enforces global cap on small entries",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const ambigThread = ThreadId.make("thread-evict-ambiguous");
        const first = {
          content: [{ type: "image", mimeType: "image/png", data: "A".repeat(9_000_000) }],
        };
        const second = {
          content: [{ type: "image", mimeType: "image/png", data: "B".repeat(9_000_000) }],
        };
        yield* sessions.recordToolResult(
          ambigThread,
          "preview_snapshot",
          { tabId: "tab-1", includeImage: true },
          first,
        );
        yield* sessions.recordToolResult(
          ambigThread,
          "preview_snapshot",
          { tabId: "tab-1", includeImage: true },
          second,
        );
        // First was evicted under the 16 MiB per-thread limit; input-only lookup must refuse the surviving sibling.
        assert.strictEqual(
          yield* sessions.takeToolResult(ambigThread, "preview_snapshot", {
            tabId: "tab-1",
            includeImage: true,
          }),
          undefined,
        );
        // Exact reported lookup can still drain the surviving second entry.
        assert.deepEqual(
          yield* sessions.takeToolResult(
            ambigThread,
            "preview_snapshot",
            { tabId: "tab-1", includeImage: true },
            second,
          ),
          second,
        );
        // Clearing at turn end resets evicted-key guards for the next turn.
        yield* sessions.clearToolResults(ambigThread);
        const nextTurn = { url: "https://example.test/" };
        yield* sessions.recordToolResult(
          ambigThread,
          "preview_snapshot",
          { tabId: "tab-1", includeImage: true },
          nextTurn,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(ambigThread, "preview_snapshot", {
            tabId: "tab-1",
            includeImage: true,
          }),
          nextTurn,
        );

        // Non-visual tools (e.g. send_to_user on OpenCode Code Mode) stay unaffected by visual eviction guards
        // even after older identical records age out of the 64-entry per-thread window.
        const nonVisualThread = ThreadId.make("thread-non-visual-age-out");
        yield* sessions.recordToolResult(
          nonVisualThread,
          "send_to_user",
          { message: "Done." },
          { sentMessage: "Done." },
        );
        for (let i = 0; i < 64; i += 1) {
          yield* sessions.recordToolResult(
            nonVisualThread,
            "send_to_user",
            { message: `Step ${i}` },
            { sentMessage: `Step ${i}` },
          );
        }
        yield* sessions.recordToolResult(
          nonVisualThread,
          "send_to_user",
          { message: "Done." },
          { sentMessage: "Done." },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(nonVisualThread, "send_to_user", { message: "Done." }),
          { sentMessage: "Done." },
        );

        // A skipped oversized visual capture blocks input-only recovery of a smaller identical-input sibling.
        const skippedThread = ThreadId.make("thread-skipped-oversized");
        const smallDevice = {
          content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
          structuredContent: { deviceId: "phone" },
        };
        yield* sessions.recordToolResult(
          skippedThread,
          "device_screenshot",
          { deviceId: "phone" },
          smallDevice,
        );
        yield* sessions.recordSkippedToolResult(skippedThread, "device_screenshot", {
          deviceId: "phone",
        });
        assert.strictEqual(
          yield* sessions.takeToolResult(skippedThread, "device_screenshot", { deviceId: "phone" }),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            skippedThread,
            "device_screenshot",
            { deviceId: "phone" },
            smallDevice,
          ),
          smallDevice,
        );

        // Global byte budget falls back to evicting oldest small entries (<= 16 KiB) past 32 MiB.
        const smallText = "x".repeat(15_000);
        for (let t = 0; t < 36; t += 1) {
          const smallThread = ThreadId.make(`thread-small-${t}`);
          for (let k = 0; k < 64; k += 1) {
            yield* sessions.recordToolResult(
              smallThread,
              "preview_snapshot",
              { tabId: `tab-${k}` },
              { url: "https://example.test/", visibleText: smallText },
            );
          }
        }
        assert.strictEqual(
          yield* sessions.takeToolResult(ThreadId.make("thread-small-0"), "preview_snapshot", {
            tabId: "tab-0",
          }),
          undefined,
        );
        assert.isDefined(
          yield* sessions.takeToolResult(ThreadId.make("thread-small-35"), "preview_snapshot", {
            tabId: "tab-63",
          }),
        );
      }).pipe(Effect.provide(McpProviderSessions.layer)),
  );

  it.effect(
    "matches truncated long inline html_preview inputs by tail and scopes eviction guards to the evicted suffix",
    () =>
      Effect.gen(function* () {
        const sessions = yield* McpProviderSessions.McpProviderSessions;
        const longHtmlA = `<html><body>${"a".repeat(9_000)}UNIQUE_TAIL_A</body></html>`;
        const longHtmlB = `<html><body>${"b".repeat(9_000)}UNIQUE_TAIL_B</body></html>`;
        const truncatedHtmlA = `[Earlier output truncated]\n\n${longHtmlA.slice(-8_000)}`;
        const truncatedHtmlB = `[Earlier output truncated]\n\n${longHtmlB.slice(-8_000)}`;
        const previewResultA = {
          content: [{ type: "image", mimeType: "image/png", data: "A".repeat(9_000_000) }],
          structuredContent: { width: 800, height: 600 },
        };
        const previewResultB = {
          content: [{ type: "image", mimeType: "image/png", data: "B".repeat(9_000_000) }],
          structuredContent: { width: 800, height: 600 },
        };

        // Recording B (9 MiB) evicts A (9 MiB) under the 16 MiB per-thread cap.
        yield* sessions.recordToolResult(
          threadId,
          "html_preview",
          { html: longHtmlA, appearance: "dark" },
          previewResultA,
        );
        yield* sessions.recordToolResult(
          threadId,
          "html_preview",
          { html: longHtmlB, appearance: "dark" },
          previewResultB,
        );
        // Distinct suffix B still recovers via truncated lookup even though A with the same options was evicted.
        assert.deepEqual(
          yield* sessions.takeToolResult(threadId, "html_preview", {
            html: truncatedHtmlB,
            appearance: "dark",
          }),
          previewResultB,
        );
        assert.strictEqual(
          yield* sessions.takeToolResult(threadId, "html_preview", {
            html: truncatedHtmlB,
            appearance: "dark",
          }),
          undefined,
        );

        // Recording another page with evicted suffix A still refuses truncated input-only recovery,
        // while exact reported lookup drains cleanly.
        const previewResultA2 = {
          content: [{ type: "image", mimeType: "image/png", data: "CCCC" }],
          structuredContent: { width: 800, height: 600 },
        };
        yield* sessions.recordToolResult(
          threadId,
          "html_preview",
          { html: longHtmlA, appearance: "dark" },
          previewResultA2,
        );
        assert.strictEqual(
          yield* sessions.takeToolResult(threadId, "html_preview", {
            html: truncatedHtmlA,
            appearance: "dark",
          }),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            threadId,
            "html_preview",
            { html: truncatedHtmlA, appearance: "dark" },
            previewResultA2,
          ),
          previewResultA2,
        );

        // Pathological turns evicting > 64 distinct visual keys bound tracking while staying safe
        // for visual tools and leaving non-visual tools (send_to_user) unaffected.
        const boundedThread = ThreadId.make("thread-bounded-evictions");
        for (let i = 0; i < 66; i += 1) {
          yield* sessions.recordSkippedToolResult(boundedThread, "device_screenshot", {
            deviceId: `dev-${i}`,
          });
        }
        yield* sessions.recordToolResult(
          boundedThread,
          "device_screenshot",
          { deviceId: "fresh-dev" },
          previewResultA2,
        );
        yield* sessions.recordToolResult(
          boundedThread,
          "send_to_user",
          { message: "Done." },
          { sentMessage: "Done." },
        );
        assert.strictEqual(
          yield* sessions.takeToolResult(boundedThread, "device_screenshot", {
            deviceId: "fresh-dev",
          }),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(boundedThread, "send_to_user", { message: "Done." }),
          { sentMessage: "Done." },
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            boundedThread,
            "device_screenshot",
            { deviceId: "fresh-dev" },
            previewResultA2,
          ),
          previewResultA2,
        );

        // An evicted visual error still guards against stealing a same-input retry's screenshot.
        const evictedErrorThread = ThreadId.make("thread-evicted-visual-error");
        yield* sessions.recordToolResult(
          evictedErrorThread,
          "preview_snapshot",
          { tabId: "tab-retry", includeImage: true },
          { isError: true },
        );
        for (let i = 0; i < 64; i += 1) {
          yield* sessions.recordToolResult(
            evictedErrorThread,
            "send_to_user",
            { message: `Filler ${i}` },
            { sentMessage: `Filler ${i}` },
          );
        }
        const retryImage = {
          content: [{ type: "image", mimeType: "image/png", data: "EEEE" }],
          structuredContent: { url: "https://retry.test/" },
        };
        yield* sessions.recordToolResult(
          evictedErrorThread,
          "preview_snapshot",
          { tabId: "tab-retry", includeImage: true },
          retryImage,
        );
        assert.strictEqual(
          yield* sessions.takeToolResult(evictedErrorThread, "preview_snapshot", {
            tabId: "tab-retry",
            includeImage: true,
          }),
          undefined,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            evictedErrorThread,
            "preview_snapshot",
            { tabId: "tab-retry", includeImage: true },
            retryImage,
          ),
          retryImage,
        );

        // Two pending preview_snapshots of the same page with differing visibleText disambiguate cleanly.
        const samePageThread = ThreadId.make("thread-same-page-visible-text");
        const beforeSnap = {
          content: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
          structuredContent: {
            url: "https://example.test/",
            title: "Example",
            visibleText: "Before",
            screenshot: { mimeType: "image/png", width: 800, height: 600 },
          },
        };
        const afterSnap = {
          content: [{ type: "image", mimeType: "image/png", data: "BBBB" }],
          structuredContent: {
            url: "https://example.test/",
            title: "Example",
            visibleText: "After",
            screenshot: { mimeType: "image/png", width: 800, height: 600 },
          },
        };
        yield* sessions.recordToolResult(
          samePageThread,
          "preview_snapshot",
          { tabId: "tab-1", includeImage: true },
          beforeSnap,
        );
        yield* sessions.recordToolResult(
          samePageThread,
          "preview_snapshot",
          { tabId: "tab-1", includeImage: true },
          afterSnap,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            samePageThread,
            "preview_snapshot",
            { tabId: "tab-1", includeImage: true },
            {
              url: "https://example.test/",
              title: "Example",
              visibleText: "Before",
              screenshot: { mimeType: "image/png", width: 800, height: 600 },
            },
          ),
          beforeSnap,
        );
        assert.deepEqual(
          yield* sessions.takeToolResult(
            samePageThread,
            "preview_snapshot",
            { tabId: "tab-1", includeImage: true },
            {
              url: "https://example.test/",
              title: "Example",
              visibleText: "After",
              screenshot: { mimeType: "image/png", width: 800, height: 600 },
            },
          ),
          afterSnap,
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
