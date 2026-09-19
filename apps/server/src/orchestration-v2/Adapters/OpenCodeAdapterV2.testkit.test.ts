import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { OPENCODE_PROVIDER } from "./OpenCodeAdapterV2.ts";
import {
  OPENCODE_SDK_REPLAY_PROTOCOL,
  OpenCodeReplayController,
  OpenCodeReplayMismatchError,
} from "./OpenCodeAdapterV2.testkit.ts";

describe("OpenCodeAdapterV2 replay testkit", () => {
  const metadata = {
    provider: OPENCODE_PROVIDER,
    protocol: OPENCODE_SDK_REPLAY_PROTOCOL,
    version: "test",
  };
  const promptFrame = (messageID: string, text = "recorded-user") => ({
    type: "session.promptAsync",
    input: { sessionID: "native-session", messageID, parts: [{ type: "text", text }] },
  });

  it.effect("correlates a prompt ID without adopting unrelated messages or rewriting text", () =>
    Effect.gen(function* () {
      const userEvent = (id: string) => ({
        type: "message.updated",
        properties: { sessionID: "native-session", info: { id, role: "user" } },
      });
      const controller = new OpenCodeReplayController({
        ...metadata,
        scenario: "prompt-message-identity",
        entries: [
          { type: "expect_outbound", frame: promptFrame("recorded-user") },
          {
            type: "emit_inbound",
            frame: { type: "sdk.event", event: userEvent("unrelated-user") },
          },
          {
            type: "emit_inbound",
            frame: { type: "sdk.event", event: userEvent("recorded-user") },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.event",
              event: {
                type: "message.updated",
                properties: {
                  sessionID: "native-session",
                  info: { id: "assistant-message", role: "assistant", parentID: "recorded-user" },
                },
              },
            },
          },
          {
            type: "expect_outbound",
            frame: { type: "session.revert", input: { messageID: "recorded-user" } },
          },
          {
            type: "emit_inbound",
            frame: {
              type: "sdk.response",
              operation: "session.revert",
              data: { id: "native-session", revert: { messageID: "recorded-user" } },
            },
          },
          { type: "runtime_exit", status: "success" },
        ],
      });
      yield* Effect.promise(() => controller.expectOutbound(promptFrame("generated-user")));
      const iterator = controller.events()[Symbol.asyncIterator]();
      const unrelated = yield* Effect.promise(() => iterator.next());
      const admitted = yield* Effect.promise(() => iterator.next());
      const assistant = yield* Effect.promise(() => iterator.next());
      assert.deepEqual(unrelated.value, userEvent("unrelated-user"));
      assert.deepEqual(admitted.value, userEvent("generated-user"));
      assert.deepEqual(assistant.value, {
        type: "message.updated",
        properties: {
          sessionID: "native-session",
          info: { id: "assistant-message", role: "assistant", parentID: "generated-user" },
        },
      });
      yield* Effect.promise(() =>
        controller.expectOutbound({
          type: "session.revert",
          input: { messageID: "generated-user" },
        }),
      );
      assert.deepEqual(yield* Effect.promise(() => controller.response("session.revert")), {
        id: "native-session",
        revert: { messageID: "generated-user" },
      });
      assert.isTrue((yield* Effect.promise(() => iterator.next())).done);
      controller.assertComplete();
    }),
  );

  it.effect("still rejects changed prompt text when binding a generated message ID", () =>
    Effect.gen(function* () {
      const controller = new OpenCodeReplayController({
        ...metadata,
        scenario: "prompt-text-mismatch",
        entries: [{ type: "expect_outbound", frame: promptFrame("recorded-user") }],
      });
      const error = yield* Effect.tryPromise(() =>
        controller.expectOutbound(promptFrame("generated-user", "different prompt")),
      ).pipe(Effect.flip);
      assert.instanceOf(error.cause, OpenCodeReplayMismatchError);
    }),
  );

  for (const [name, recordedId, actualId] of [
    ["rebinding an existing recorded ID", "recorded-user", "another-generated-user"],
    [
      "reusing one generated ID for distinct recorded users",
      "another-recorded-user",
      "generated-user",
    ],
  ] as const) {
    it.effect(`rejects ${name}`, () =>
      Effect.gen(function* () {
        const controller = new OpenCodeReplayController({
          ...metadata,
          scenario: "conflicting-message-identity",
          entries: [
            { type: "expect_outbound", frame: promptFrame("recorded-user") },
            { type: "expect_outbound", frame: promptFrame(recordedId) },
          ],
        });
        yield* Effect.promise(() => controller.expectOutbound(promptFrame("generated-user")));
        const error = yield* Effect.tryPromise(() =>
          controller.expectOutbound(promptFrame(actualId)),
        ).pipe(Effect.flip);
        assert.instanceOf(error.cause, OpenCodeReplayMismatchError);
      }),
    );
  }

  it.effect("stops an event stream when abort races with listener registration", () =>
    Effect.gen(function* () {
      let aborted = false;
      const signal = {
        get aborted() {
          return aborted;
        },
        addEventListener: () => {
          aborted = true;
        },
        removeEventListener: () => {},
      } as unknown as AbortSignal;
      const controller = new OpenCodeReplayController({
        provider: OPENCODE_PROVIDER,
        protocol: OPENCODE_SDK_REPLAY_PROTOCOL,
        version: "test",
        scenario: "abort-during-listener-registration",
        entries: [],
      });
      const iterator = controller.events(signal)[Symbol.asyncIterator]();

      const result = yield* Effect.promise(() => iterator.next()).pipe(
        Effect.timeout("100 millis"),
      );

      assert.isTrue(result.done);
    }),
  );
});
