import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CONTROL_SEND_TEXT_MAX_CHARS,
  ControlPingInput,
  ControlRequestStatusResult,
  ControlSendTextInput,
} from "./control.ts";

const decodePing = Schema.decodeUnknownEffect(ControlPingInput);
const decodeStatus = Schema.decodeUnknownEffect(ControlRequestStatusResult);
const decodeSendText = Schema.decodeUnknownEffect(ControlSendTextInput);

it.effect("decodes control ping and bounded nonces", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* decodePing({ nonce: "mobile-check" }), { nonce: "mobile-check" });
    assert.strictEqual(
      (yield* Effect.exit(decodePing({ nonce: "x".repeat(257) })))._tag,
      "Failure",
    );
  }),
);

it.effect("applies safe send-text defaults without trimming the message", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeSendText({ threadId: "thread-1", text: "  keep spacing  " });

    assert.strictEqual(decoded.text, "  keep spacing  ");
    assert.strictEqual(decoded.runtimeMode, "full-access");
    assert.strictEqual(decoded.interactionMode, "default");
  }),
);

it.effect("rejects blank and oversized control messages", () =>
  Effect.gen(function* () {
    assert.strictEqual(
      (yield* Effect.exit(decodeSendText({ threadId: "thread-1", text: " \n\t " })))._tag,
      "Failure",
    );
    assert.strictEqual(
      (yield* Effect.exit(
        decodeSendText({ threadId: "thread-1", text: "x".repeat(CONTROL_SEND_TEXT_MAX_CHARS + 1) }),
      ))._tag,
      "Failure",
    );
  }),
);

it.effect("decodes a lightweight control status snapshot", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeStatus({
      serverTime: "2026-08-10T00:00:00.000Z",
      environmentId: "environment-1",
      runtimeMode: "web",
      session: { sessionId: "session-1", subject: "selfhost:demo" },
      onlineClients: 1,
      projects: 2,
      threads: 3,
    });

    assert.strictEqual(decoded.session.subject, "selfhost:demo");
    assert.strictEqual(decoded.threads, 3);
  }),
);
