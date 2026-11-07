import {
  AuthOrchestrationOperateScope,
  SPEECH_CONVERSATION_PATH,
  SPEECH_MAX_OPTIONS_BYTES,
  SPEECH_STREAM_MAX_CHUNK_BYTES,
  SpeechConversationCommand,
  type SpeechConversationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SpeechService from "./SpeechService.ts";
import { DEFAULT_TURN_SETTINGS, makeTurnDetector } from "./turns.ts";

const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(SpeechConversationCommand));

/** Ten minutes of 16 kHz audio without speech. Measured in audio, not wall time. */
const CONVERSATION_IDLE_SAMPLES = 16_000 * 60 * 10;

/**
 * A long-lived stream split into utterances. Each utterance ends on a pause the
 * turn detector judges final, and the model starts the next one without reloading.
 */
export const runConversationSocket = Effect.fn("speech.runConversationSocket")(function* (
  socket: Socket.Socket,
  speech: Pick<SpeechService.SpeechService["Service"], "startStream">,
  idleSamples = CONVERSATION_IDLE_SAMPLES,
) {
  const scope = yield* Scope.Scope;
  const writer = yield* socket.writer;
  const send = (event: SpeechConversationEvent) => writer.write(JSON.stringify(event));
  let stream: SpeechService.SpeechStream | undefined;
  let detector = makeTurnDetector();
  let silentSamples = 0;
  // Updates carry text only when it changed, so the utterance's latest text is kept here.
  let text = "";
  let ended = false;
  const close = Effect.fn("speech.closeConversation")(function* (
    event: SpeechConversationEvent | undefined,
    code: number,
  ) {
    if (ended) return;
    ended = true;
    if (event) yield* send(event);
    yield* writer.write(new Socket.CloseEvent(code, "Voice conversation ended"));
  });
  const fail = (message: string) => close({ type: "error", message }, 1008);
  const receive = (data: string | Uint8Array) => {
    if (ended) return Effect.void;
    return Effect.gen(function* () {
      if (typeof data === "string") {
        if (new TextEncoder().encode(data).byteLength > SPEECH_MAX_OPTIONS_BYTES)
          return yield* fail("Invalid voice conversation command.");
        const command = yield* decodeCommand(data);
        if (command.type === "stop") return yield* close(undefined, 1000);
        if (stream) return yield* fail("Voice conversation already started.");
        detector = makeTurnDetector({
          ...DEFAULT_TURN_SETTINGS,
          ...(command.endSilenceMs === undefined ? {} : { endSilenceMs: command.endSilenceMs }),
          ...(command.endSilenceLongMs === undefined
            ? {}
            : { endSilenceLongMs: command.endSilenceLongMs }),
        });
        stream = yield* speech
          .startStream(command.options, "conversation")
          .pipe(Scope.provide(scope));
        yield* send({ type: "ready" });
        return;
      }
      if (data.byteLength > SPEECH_STREAM_MAX_CHUNK_BYTES)
        return yield* fail("Speech audio chunk is too large.");
      if (!stream) return yield* fail("Start the voice conversation before sending audio.");
      const update = yield* stream.feed(data);
      yield* send({ type: "update", revision: update.revision, text: update.text });
      if (update.text) text = `${update.text.committed}${update.text.tentative}`;
      const turn = detector.observe({
        samples: update.samples,
        voicedUntil: update.voicedUntil,
        text,
      });
      silentSamples = turn.heard ? 0 : silentSamples + data.byteLength / 4;
      if (turn.speechStarted) yield* send({ type: "speech-start" });
      if (turn.ended) {
        const utterance = yield* stream.next;
        detector.reset();
        text = "";
        if (utterance.trim()) yield* send({ type: "utterance", text: utterance });
      }
      if (silentSamples >= idleSamples) yield* close({ type: "idle" }, 1000);
    }).pipe(
      Effect.catch((cause) =>
        Effect.logError("voice conversation operation failed", { cause }).pipe(
          Effect.andThen(fail("Voice conversation failed. Please start it again.")),
        ),
      ),
    );
  };
  const reader = yield* socket.reader;
  yield* Effect.gen(function* () {
    const pending = yield* Queue.bounded<string | Uint8Array>(2);
    yield* Effect.forever(Queue.take(pending).pipe(Effect.flatMap(receive))).pipe(
      Effect.forkScoped,
    );
    while (true) {
      const frames = yield* reader.pull;
      yield* Effect.forEach(frames, (frame) => Queue.offer(pending, frame), {
        discard: true,
      });
    }
  }).pipe(Effect.ignore);
});

export const speechConversationRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const speech = yield* SpeechService.SpeechService;
    return HttpRouter.add(
      "GET",
      SPEECH_CONVERSATION_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth
          .authenticateWebSocketUpgrade(request, "media")
          .pipe(Effect.result);
        if (session._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
        if (!session.success.scopes.includes(AuthOrchestrationOperateScope))
          return HttpServerResponse.empty({ status: 403 });
        const socket = yield* request.upgrade;
        yield* runConversationSocket(socket, speech).pipe(Effect.scoped);
        return HttpServerResponse.empty();
      }),
    );
  }),
);
