import { it, assert } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

import { makeClaudeAdapterLive } from "./ClaudeAdapter.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { ThreadId } from "@t3tools/contracts";

const layer = it.layer(
  Layer.mergeAll(makeClaudeAdapterLive(), NodeServices.layer),
);

layer("ClaudeAdapterLive", (it) => {
  it.effect("startSession creates a session and emits session.started", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const threadId = ThreadId.makeUnsafe("test-thread-1");

      const session = yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        cwd: "/tmp/test",
        model: "claude-sonnet-4-6",
      });

      assert.equal(session.provider, "claude");
      assert.equal(session.threadId, threadId);
      assert.equal(session.model, "claude-sonnet-4-6");

      const has = yield* adapter.hasSession(threadId);
      assert.ok(has);

      // Clean up
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("stopSession cleans up the session", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const threadId = ThreadId.makeUnsafe("test-thread-2");

      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        cwd: "/tmp/test",
      });

      assert.ok(yield* adapter.hasSession(threadId));

      yield* adapter.stopSession(threadId);

      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  );

  it.effect("listSessions returns active sessions", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const threadId = ThreadId.makeUnsafe("test-thread-3");

      yield* adapter.startSession({
        threadId,
        runtimeMode: "approval-required",
        cwd: "/tmp/test",
        model: "claude-opus-4-6",
      });

      const sessionList = yield* adapter.listSessions();
      const found = sessionList.find((s) => s.threadId === threadId);
      assert.ok(found);
      assert.equal(found?.model, "claude-opus-4-6");
      assert.equal(found?.provider, "claude");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("readThread returns an empty snapshot for an active session", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const threadId = ThreadId.makeUnsafe("test-thread-4");

      yield* adapter.startSession({
        threadId,
        runtimeMode: "full-access",
        cwd: "/tmp/test",
      });

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.threadId, threadId);
      assert.deepEqual(snapshot.turns, []);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("capabilities reports in-session model switch support", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      assert.equal(adapter.capabilities.sessionModelSwitch, "in-session");
    }),
  );

  it.effect("stopAll stops all sessions", () =>
    Effect.gen(function* () {
      const adapter = yield* ClaudeAdapter;
      const threadId1 = ThreadId.makeUnsafe("test-thread-5a");
      const threadId2 = ThreadId.makeUnsafe("test-thread-5b");

      yield* adapter.startSession({
        threadId: threadId1,
        runtimeMode: "full-access",
        cwd: "/tmp/test",
      });
      yield* adapter.startSession({
        threadId: threadId2,
        runtimeMode: "full-access",
        cwd: "/tmp/test",
      });

      assert.ok(yield* adapter.hasSession(threadId1));
      assert.ok(yield* adapter.hasSession(threadId2));

      yield* adapter.stopAll();

      assert.equal(yield* adapter.hasSession(threadId1), false);
      assert.equal(yield* adapter.hasSession(threadId2), false);
    }),
  );
});
