import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { MAX_SPEECH_BYTES, SpeechService } from "./SpeechService.ts";

export const speechHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const speech = yield* SpeechService;
    return handlers
      .handle(
        "status",
        Effect.fn("environment.voice.status")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* speech.status.pipe(
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
        }),
      )
      .handle(
        "transcribe",
        Effect.fn("environment.voice.transcribe")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          if (args.payload.byteLength > MAX_SPEECH_BYTES) {
            return yield* failEnvironmentInternal(
              "internal_error",
              new Error("voice recording is too large"),
            );
          }
          const text = yield* speech
            .transcribe(args.payload)
            .pipe(Effect.catch((error) => failEnvironmentInternal("internal_error", error)));
          return { text };
        }),
      )
      .handle(
        "removeModel",
        Effect.fn("environment.voice.removeModel")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
          return yield* speech.removeModel.pipe(
            Effect.catch((error) => failEnvironmentInternal("internal_error", error)),
          );
        }),
      );
  }),
);
