import {
  AuthOrchestrationOperateScope,
  SPEECH_STREAM_PATH,
  SPEECH_STREAM_MAX_CHUNK_BYTES,
  SpeechStreamCommand,
  type SpeechStreamEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as Socket from "effect/unstable/socket/Socket";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { SpeechService, type SpeechStream } from "./SpeechService.ts";

const decodeCommand = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechStreamCommand));

/** One socket owns one stream. Each audio frame is acknowledged after inference finishes. */
export const runSpeechSocket = Effect.fn("speech.runSocket")(function* (
  socket: Socket.Socket,
  speech: SpeechService["Service"],
) {
  const scope = yield* Scope.Scope;
  const write = yield* socket.writer;
  const send = (event: SpeechStreamEvent) => write(JSON.stringify(event));
  let stream: SpeechStream | undefined;
  let busy = true;
  let ended = false;
  const fail = (message: string) =>
    Effect.gen(function* () {
      if (ended) return;
      ended = true;
      yield* send({ type: "error", message });
      yield* write(new Socket.CloseEvent(1008, "Speech stream ended"));
    });
  const receive = (data: string | Uint8Array) => {
    if (ended) return;
    if (busy || !stream)
      return fail("Speech stream received audio before the previous operation finished.");
    busy = true;
    const current = stream;
    return Effect.gen(function* () {
      if (typeof data === "string") {
        if (data.length > 100) return yield* fail("Invalid speech stream command.");
        yield* Effect.try(() => decodeCommand(data));
        const text = yield* current.finish;
        ended = true;
        yield* send({ type: "finished", text });
        yield* write(new Socket.CloseEvent(1000));
      } else {
        if (data.byteLength > SPEECH_STREAM_MAX_CHUNK_BYTES)
          return yield* fail("Speech audio chunk is too large.");
        const update = yield* current.feed(data);
        busy = false;
        yield* send({ type: "update", ...update });
      }
    }).pipe(Effect.catch(() => fail("Live transcription failed. Please try recording again.")));
  };
  yield* socket
    .runRaw(receive, {
      onOpen: Effect.gen(function* () {
        stream = yield* speech.startStream.pipe(Scope.provide(scope));
        busy = false;
        yield* send({ type: "ready" });
      }).pipe(
        Effect.catch(() =>
          fail("Could not prepare live transcription. Check the selected model and try again."),
        ),
        Effect.ignore,
      ),
    })
    .pipe(
      Effect.timeoutOrElse({
        duration: "10 minutes",
        orElse: () => fail("Speech stream timed out."),
      }),
      Effect.catch(() => Effect.void),
    );
});

export const speechStreamRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const auth = yield* EnvironmentAuth.EnvironmentAuth;
    const speech = yield* SpeechService;
    return HttpRouter.add(
      "GET",
      SPEECH_STREAM_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* auth.authenticateWebSocketUpgrade(request).pipe(Effect.result);
        if (session._tag === "Failure") return HttpServerResponse.empty({ status: 401 });
        if (!session.success.scopes.includes(AuthOrchestrationOperateScope))
          return HttpServerResponse.empty({ status: 403 });
        const socket = yield* request.upgrade;
        yield* runSpeechSocket(socket, speech).pipe(Effect.scoped);
        return HttpServerResponse.empty();
      }),
    );
  }),
);
