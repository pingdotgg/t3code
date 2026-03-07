import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { ORCHESTRATION_WS_METHODS } from "./orchestration";
import { WS_METHODS, WebSocketRequest } from "./ws";

const decodeWebSocketRequest = Schema.decodeUnknownEffect(WebSocketRequest);

it.effect("accepts getTurnDiff requests when fromTurnCount <= toTurnCount", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: "req-1",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: "thread-1",
        fromTurnCount: 1,
        toTurnCount: 2,
      },
    });
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
  }),
);

it.effect("rejects getTurnDiff requests when fromTurnCount > toTurnCount", () =>
  Effect.gen(function* () {
    const result = yield* Effect.exit(
      decodeWebSocketRequest({
        id: "req-1",
        body: {
          _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
          threadId: "thread-1",
          fromTurnCount: 3,
          toTurnCount: 2,
        },
      }),
    );
    assert.strictEqual(result._tag, "Failure");
  }),
);

it.effect("trims websocket request id and nested orchestration ids", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: " req-1 ",
      body: {
        _tag: ORCHESTRATION_WS_METHODS.getTurnDiff,
        threadId: " thread-1 ",
        fromTurnCount: 0,
        toTurnCount: 0,
      },
    });
    assert.strictEqual(parsed.id, "req-1");
    assert.strictEqual(parsed.body._tag, ORCHESTRATION_WS_METHODS.getTurnDiff);
    if (parsed.body._tag === ORCHESTRATION_WS_METHODS.getTurnDiff) {
      assert.strictEqual(parsed.body.threadId, "thread-1");
    }
  }),
);

it.effect("accepts server.getCodexRateLimits requests with optional overrides", () =>
  Effect.gen(function* () {
    const parsed = yield* decodeWebSocketRequest({
      id: "req-rate-limits",
      body: {
        _tag: WS_METHODS.serverGetCodexRateLimits,
        binaryPath: " /usr/local/bin/codex ",
        homePath: " /tmp/.codex ",
      },
    });
    assert.strictEqual(parsed.body._tag, WS_METHODS.serverGetCodexRateLimits);
    if (parsed.body._tag === WS_METHODS.serverGetCodexRateLimits) {
      assert.strictEqual(parsed.body.binaryPath, "/usr/local/bin/codex");
      assert.strictEqual(parsed.body.homePath, "/tmp/.codex");
    }
  }),
);
