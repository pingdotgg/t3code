import {
  AuthOrchestrationOperateScope,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import * as LiveVoice from "./LiveVoice.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "liveVoice",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* LiveVoice.LiveVoice;
    const authorize = Effect.fnUntraced(function* (endpoint: string) {
      yield* annotateEnvironmentRequest(endpoint);
      yield* requireEnvironmentScope(AuthOrchestrationOperateScope);
      return (yield* EnvironmentAuthenticatedPrincipal).sessionId;
    });
    return handlers
      .handle(
        "options",
        Effect.fn("environment.liveVoice.options")(function* (args) {
          yield* authorize(args.endpoint.name);
          return yield* service.options(args.params.threadId);
        }),
      )
      .handle(
        "start",
        Effect.fn("environment.liveVoice.start")(function* (args) {
          return yield* service.start(args.payload, yield* authorize(args.endpoint.name));
        }),
      )
      .handle(
        "poll",
        Effect.fn("environment.liveVoice.poll")(function* (args) {
          return yield* service.poll(
            args.params.sessionId,
            yield* authorize(args.endpoint.name),
            args.query.revision,
          );
        }),
      )
      .handle(
        "stop",
        Effect.fn("environment.liveVoice.stop")(function* (args) {
          yield* service.stop(args.params.sessionId, yield* authorize(args.endpoint.name));
        }),
      );
  }),
);
