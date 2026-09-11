import {
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  VOICE_TRANSCRIBE_MIME_TYPE_HEADER,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpServerRequest } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { checkCodexVoiceAvailability, transcribeCodexVoice } from "./VoiceTranscription.ts";

/** Voice routes: availability plus binary one-shot transcription, both operate-scoped. */
export const voiceHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    return handlers
      .handle(
        "availability",
        Effect.fn("environment.voice.availability")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const codexVoiceAvailable = yield* checkCodexVoiceAvailability;
          return { codexVoiceAvailable };
        }),
      )
      .handle(
        "transcribe",
        Effect.fn("environment.voice.transcribe")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const declaredLength = request.headers["content-length"];
          if (declaredLength !== undefined && Number(declaredLength) !== args.payload.byteLength) {
            return yield* new EnvironmentHttpBadRequestError({
              message: "Content-Length must match the audio size.",
            });
          }
          return yield* transcribeCodexVoice(
            args.payload,
            args.headers[VOICE_TRANSCRIBE_MIME_TYPE_HEADER],
          );
        }),
      );
  }),
);
