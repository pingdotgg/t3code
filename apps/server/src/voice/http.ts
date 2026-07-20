import { AuthOrchestrationOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { transcribeVoice } from "./VoiceTranscription.ts";

export const voiceHttpApiLayer = HttpApiBuilder.group(EnvironmentHttpApi, "voice", (handlers) =>
  handlers.handle(
    "transcribe",
    Effect.fn("environment.voice.transcribe")(function* (args) {
      yield* annotateEnvironmentRequest(args.endpoint.name);
      yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
      return yield* transcribeVoice(args.payload);
    }),
  ),
);
