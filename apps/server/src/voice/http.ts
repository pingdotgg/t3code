import {
  AuthOrchestrationOperateScope,
  EnvironmentHttpApi,
  EnvironmentAuthenticatedPrincipal,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { makeCodexVoiceSessions } from "./CodexVoice.ts";

export const voiceHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "voice",
  Effect.fnUntraced(function* (handlers) {
    const sessions = yield* makeCodexVoiceSessions();
    const authorize = Effect.fn("voice.authorize")(function* (endpoint: string) {
      yield* annotateEnvironmentRequest(endpoint);
      yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
      return (yield* EnvironmentAuthenticatedPrincipal).sessionId;
    });
    return handlers
      .handle(
        "polish",
        Effect.fn("environment.voice.polish")(function* (args) {
          yield* authorize(args.endpoint.name);
          return {
            text: yield* sessions.polish(
              args.payload.instanceId,
              args.payload.text,
              args.payload.style,
            ),
          };
        }),
      )
      .handle(
        "availability",
        Effect.fn("environment.voice.availability")(function* (args) {
          const owner = yield* authorize(args.endpoint.name);
          const available = yield* sessions.available(owner, args.payload.instanceId);
          return { codexVoiceAvailable: available };
        }),
      )
      .handle(
        "start",
        Effect.fn("environment.voice.start")(function* (args) {
          const owner = yield* authorize(args.endpoint.name);
          return yield* sessions.start(owner, args.payload.instanceId, args.payload.sdp);
        }),
      )
      .handle(
        "finish",
        Effect.fn("environment.voice.finish")(function* (args) {
          const owner = yield* authorize(args.endpoint.name);
          return { text: yield* sessions.finish(owner, args.payload.sessionId, args.payload.text) };
        }),
      )
      .handle(
        "stop",
        Effect.fn("environment.voice.stop")(function* (args) {
          const owner = yield* authorize(args.endpoint.name);
          yield* sessions.stop(owner, args.payload.sessionId);
        }),
      );
  }),
);
