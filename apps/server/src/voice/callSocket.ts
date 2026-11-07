import {
  AuthOrchestrationOperateScope,
  encodeSpeechAudioFrame,
  SPEECH_MAX_OPTIONS_BYTES,
  SPEECH_STREAM_MAX_CHUNK_BYTES,
  VOICE_CONVERSATION_PATH,
  VoiceConversationCommand,
  type VoiceConversationEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Socket from "effect/socket/Socket";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as VoiceConversationService from "./VoiceConversationService.ts";

const decodeCommand = Schema.decodeUnknownEffect(Schema.fromJsonString(VoiceConversationCommand));

/** Decodes the call socket's frames into one call; the call itself is the service's. */
export const runVoiceCallSocket = Effect.fn("voice.runCallSocket")(function* (
  socket: Socket.Socket,
  calls: VoiceConversationService.VoiceConversationService["Service"],
) {
  const scope = yield* Scope.Scope;
  const writer = yield* socket.writer;
  let ended = false;
  // A closed socket ends the call through the reader; a failed write has nothing to tell.
  const send = (output: VoiceConversationService.VoiceCallOutput) =>
    ended
      ? Effect.void
      : writer
          .write(
            output.type === "audio"
              ? encodeSpeechAudioFrame(output.seq, output.pcm)
              : JSON.stringify(output),
          )
          .pipe(Effect.ignore);
  let call: VoiceConversationService.VoiceCall | undefined;
  const close = Effect.fn("voice.closeCall")(function* (
    event: VoiceConversationEvent | undefined,
    code: number,
  ) {
    if (ended) return;
    if (event) yield* send(event);
    ended = true;
    yield* writer.write(new Socket.CloseEvent(code, "Voice call ended")).pipe(Effect.ignore);
  });
  const fail = (message: string) => close({ type: "error", message }, 1008);
  const receive = (data: string | Uint8Array) => {
    if (ended) return Effect.void;
    return Effect.gen(function* () {
      if (typeof data === "string") {
        if (new TextEncoder().encode(data).byteLength > SPEECH_MAX_OPTIONS_BYTES)
          return yield* fail("Invalid voice call command.");
        const command = yield* decodeCommand(data);
        if (command.type === "stop") return yield* close(undefined, 1000);
        if (command.type === "start") {
          if (call) return yield* fail("The voice call already started.");
          call = yield* calls.start({ ...command, send }).pipe(Scope.provide(scope));
          yield* call.ended.pipe(Effect.andThen(close(undefined, 1000)), Effect.forkIn(scope));
          return;
        }
        if (!call) return yield* fail("Start the voice call first.");
        if (command.type === "played") return yield* call.played(command.seq, command.sample);
        return yield* command.type === "mute" ? call.mute : call.unmute;
      }
      if (data.byteLength > SPEECH_STREAM_MAX_CHUNK_BYTES || data.byteLength % 4 !== 0)
        return yield* fail("Invalid voice call audio.");
      if (!call) return yield* fail("Start the voice call before sending audio.");
      yield* call.hear(data);
    }).pipe(
      Effect.catchTags({
        VoiceCallError: (error) =>
          Effect.logError("voice call failed", { cause: error }).pipe(
            Effect.andThen(fail(error.message)),
          ),
      }),
      Effect.catch((cause) =>
        Effect.logError("voice call command failed", { cause }).pipe(
          Effect.andThen(fail("The voice call failed. Please start it again.")),
        ),
      ),
    );
  };
  const reader = yield* socket.reader;
  yield* Effect.gen(function* () {
    // Mic frames wait here while the server catches up, which backs up the client's socket.
    const pending = yield* Queue.bounded<string | Uint8Array>(2);
    yield* Effect.forever(Queue.take(pending).pipe(Effect.flatMap(receive))).pipe(
      Effect.forkScoped,
    );
    while (true) {
      const frames = yield* reader.pull;
      yield* Effect.forEach(frames, (frame) => Queue.offer(pending, frame), { discard: true });
    }
  }).pipe(Effect.ignore);
});

export const voiceCallRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const sessions = yield* SessionStore.SessionStore;
    const calls = yield* VoiceConversationService.VoiceConversationService;
    return HttpRouter.add(
      "GET",
      VOICE_CONVERSATION_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth
          .authenticateWebSocketUpgrade(request, "media")
          .pipe(Effect.result);
        if (session._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
        const { scopes, sessionId, proofKeyThumbprint } = session.success;
        if (!scopes.includes(AuthOrchestrationOperateScope))
          return HttpServerResponse.empty({ status: 403 });
        const socket = yield* request.upgrade;
        // Revoking the session ends the call and frees what it holds.
        yield* Effect.raceFirst(
          runVoiceCallSocket(socket, calls).pipe(Effect.scoped),
          sessions
            .awaitInvalidation(sessionId, proofKeyThumbprint)
            .pipe(
              Effect.catch((cause) =>
                Effect.logError("voice call lost its session check", { cause }).pipe(
                  Effect.andThen(Effect.never),
                ),
              ),
            ),
        );
        return HttpServerResponse.empty();
      }),
    );
  }),
);
