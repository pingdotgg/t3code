import * as NodeAssert from "node:assert/strict";

import type { ProviderVoiceSessionEvent } from "@t3tools/contracts";
import { describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as CodexClient from "effect-codex-app-server/client";

import {
  CodexVoiceSessionError,
  makeCodexVoice,
  readRealtimeDelegationInput,
  readSpeakableAnswer,
} from "./CodexVoice.ts";

const PROVIDER_THREAD = "provider-thread-1";

function delegation(input: string) {
  return `<realtime_delegation>\n  <input>${input}</input>\n</realtime_delegation>`;
}

const makeFakeClient = Effect.gen(function* () {
  const handlers = new Map<string, Array<(payload: unknown) => Effect.Effect<void, Error>>>();
  const requests: Array<{ readonly method: string; readonly params: unknown }> = [];
  const startRequested = yield* Deferred.make<void>();
  const speechRequested = yield* Deferred.make<void>();
  const stopRequested = yield* Deferred.make<void>();
  const client = {
    handleServerNotification: (
      method: string,
      handler: (payload: unknown) => Effect.Effect<void, Error>,
    ) =>
      Effect.sync(() => {
        handlers.set(method, [...(handlers.get(method) ?? []), handler]);
      }),
    raw: {
      request: (method: string, params: unknown) =>
        Effect.gen(function* () {
          requests.push({ method, params });
          if (method === "thread/realtime/start")
            yield* Deferred.succeed(startRequested, undefined);
          if (method === "thread/realtime/appendSpeech") {
            yield* Deferred.succeed(speechRequested, undefined);
          }
          if (method === "thread/realtime/stop") yield* Deferred.succeed(stopRequested, undefined);
          return {};
        }),
    },
  } as unknown as CodexClient.CodexAppServerClient["Service"];
  const emit = (method: string, payload: unknown) =>
    Effect.forEach(handlers.get(method) ?? [], (handler) => Effect.ignore(handler(payload)), {
      discard: true,
    });
  return { client, requests, emit, startRequested, speechRequested, stopRequested };
});

const startVoice = Effect.gen(function* () {
  const fake = yield* makeFakeClient;
  const scope = yield* Scope.make();
  const voice = yield* makeCodexVoice(fake.client, scope);
  const fiber = yield* voice
    .start({ providerThreadId: PROVIDER_THREAD, offerSdp: "v=offer\r\n", voice: "cove" })
    .pipe(Stream.runCollect, Effect.forkChild);
  yield* Deferred.await(fake.startRequested);
  return { ...fake, fiber };
});

describe("readRealtimeDelegationInput", () => {
  it("unwraps and unescapes the spoken request", () => {
    NodeAssert.equal(
      readRealtimeDelegationInput(delegation("run the tests &amp; fix &lt;Foo&gt;")),
      "run the tests & fix <Foo>",
    );
  });

  it("ignores ordinary user messages", () => {
    NodeAssert.equal(readRealtimeDelegationInput("please fix the build"), undefined);
  });
});

describe("readSpeakableAnswer", () => {
  it("speaks final answers without the channel marker", () => {
    NodeAssert.equal(
      readSpeakableAnswer({ type: "agentMessage", text: "[FINAL] All green.", phase: null }),
      "All green.",
    );
  });

  it("keeps commentary private", () => {
    NodeAssert.equal(
      readSpeakableAnswer({ type: "agentMessage", text: "Looking…", phase: "commentary" }),
      undefined,
    );
    NodeAssert.equal(
      readSpeakableAnswer({ type: "agentMessage", text: "[COMMENTARY] Looking…", phase: null }),
      undefined,
    );
  });

  it("leaves oversized answers on screen only", () => {
    NodeAssert.equal(
      readSpeakableAnswer({ type: "agentMessage", text: "x".repeat(5000), phase: "final_answer" }),
      undefined,
    );
  });
});

describe("makeCodexVoice", () => {
  it.effect("starts a WebRTC realtime session and relays signaling until Codex closes it", () =>
    Effect.gen(function* () {
      const voice = yield* startVoice;
      NodeAssert.deepEqual(voice.requests[0], {
        method: "thread/realtime/start",
        params: {
          threadId: PROVIDER_THREAD,
          outputModality: "audio",
          transport: { type: "webrtc", sdp: "v=offer\r\n" },
          version: "v3",
          clientManagedHandoffs: true,
          includeStartupContext: false,
          voice: "cove",
        },
      });

      yield* voice.emit("thread/realtime/started", { threadId: PROVIDER_THREAD, version: "v3" });
      yield* voice.emit("thread/realtime/sdp", { threadId: PROVIDER_THREAD, sdp: "v=answer\r\n" });
      yield* voice.emit("thread/realtime/transcript/delta", {
        threadId: "another-thread",
        role: "user",
        delta: "ignored",
      });
      yield* voice.emit("thread/realtime/transcript/delta", {
        threadId: PROVIDER_THREAD,
        role: "user",
        delta: "hello",
      });
      yield* voice.emit("thread/realtime/transcript/done", {
        threadId: PROVIDER_THREAD,
        role: "assistant",
        text: "Hi there",
      });
      yield* voice.emit("thread/realtime/closed", {
        threadId: PROVIDER_THREAD,
        reason: "transport_closed",
      });

      const events = yield* Fiber.join(voice.fiber);
      NodeAssert.deepEqual(events, [
        { type: "started" },
        { type: "answer", sdp: "v=answer\r\n" },
        { type: "transcript.delta", role: "user", delta: "hello" },
        { type: "transcript.done", role: "assistant", text: "Hi there" },
        { type: "closed", reason: "transport_closed" },
      ] satisfies ReadonlyArray<ProviderVoiceSessionEvent>);
      // Codex already closed the session, so there is nothing to stop.
      NodeAssert.ok(!voice.requests.some((request) => request.method === "thread/realtime/stop"));
    }),
  );

  it.effect("stops the realtime session when the client unsubscribes", () =>
    Effect.gen(function* () {
      const voice = yield* startVoice;
      yield* Fiber.interrupt(voice.fiber);
      yield* Deferred.await(voice.stopRequested);
      NodeAssert.deepEqual(voice.requests.at(-1), {
        method: "thread/realtime/stop",
        params: { threadId: PROVIDER_THREAD },
      });
    }),
  );

  it.effect("fails the stream with Codex's realtime error", () =>
    Effect.gen(function* () {
      const voice = yield* startVoice;
      yield* voice.emit("thread/realtime/error", {
        threadId: PROVIDER_THREAD,
        message: "realtime unavailable",
      });
      const exit = yield* Fiber.await(voice.fiber);
      NodeAssert.ok(Exit.isFailure(exit));
      const error = exit.cause.reasons[0];
      NodeAssert.ok(error?._tag === "Fail" && Schema.is(CodexVoiceSessionError)(error.error));
      NodeAssert.equal(error.error.detail, "realtime unavailable");
    }),
  );

  it.effect("speaks the answer of a handoff the host resubmitted as its own turn", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeClient;
      const scope = yield* Scope.make();
      const voice = yield* makeCodexVoice(fake.client, scope);
      const fiber = yield* voice
        .start({ providerThreadId: PROVIDER_THREAD, offerSdp: "v=offer\r\n" })
        .pipe(Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(fake.startRequested);

      yield* voice.expectSpokenTurn("run the tests");
      yield* fake.emit("item/started", {
        threadId: PROVIDER_THREAD,
        turnId: "resubmitted",
        item: {
          type: "userMessage",
          id: "user-resubmitted",
          content: [{ type: "text", text: "<context/>\nrun the tests" }],
        },
      });
      yield* fake.emit("item/completed", {
        threadId: PROVIDER_THREAD,
        turnId: "resubmitted",
        item: { type: "agentMessage", id: "answer", text: "All green.", phase: "final_answer" },
      });
      yield* fake.emit("turn/completed", {
        threadId: PROVIDER_THREAD,
        turn: { id: "resubmitted", status: "completed" },
      });

      yield* Deferred.await(fake.speechRequested);
      NodeAssert.deepEqual(fake.requests.at(-1), {
        method: "thread/realtime/appendSpeech",
        params: { threadId: PROVIDER_THREAD, text: "All green." },
      });
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("speaks the final answer of a voice-delegated turn, not typed turns", () =>
    Effect.gen(function* () {
      const voice = yield* startVoice;
      const userMessage = (turnId: string, text: string) =>
        voice.emit("item/started", {
          threadId: PROVIDER_THREAD,
          turnId,
          item: { type: "userMessage", id: `user-${turnId}`, content: [{ type: "text", text }] },
        });
      const agentMessage = (turnId: string, text: string, phase: string) =>
        voice.emit("item/completed", {
          threadId: PROVIDER_THREAD,
          turnId,
          item: { type: "agentMessage", id: `agent-${turnId}-${phase}`, text, phase },
        });
      const complete = (turnId: string) =>
        voice.emit("turn/completed", {
          threadId: PROVIDER_THREAD,
          turn: { id: turnId, status: "completed" },
        });

      yield* userMessage("typed", "fix the build");
      yield* agentMessage("typed", "Fixed it.", "final_answer");
      yield* complete("typed");

      yield* userMessage("voice", delegation("run the tests"));
      yield* agentMessage("voice", "Running them now.", "commentary");
      yield* agentMessage("voice", "All 42 tests pass.", "final_answer");
      yield* complete("voice");

      yield* Deferred.await(voice.speechRequested);
      NodeAssert.deepEqual(
        voice.requests.filter((request) => request.method === "thread/realtime/appendSpeech"),
        [
          {
            method: "thread/realtime/appendSpeech",
            params: { threadId: PROVIDER_THREAD, text: "All 42 tests pass." },
          },
        ],
      );
      yield* Fiber.interrupt(voice.fiber);
    }),
  );
});
