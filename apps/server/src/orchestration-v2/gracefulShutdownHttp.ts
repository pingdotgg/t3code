import { AuthEnvironmentMaintainScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as GracefulShutdown from "./GracefulShutdown.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "maintain",
  Effect.fnUntraced(function* (handlers) {
    const gracefulShutdown = yield* GracefulShutdown.GracefulShutdown;

    return handlers
      .handle(
        "gracefulShutdown",
        Effect.fn("environment.maintain.gracefulShutdown")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthEnvironmentMaintainScope);
          return yield* gracefulShutdown.beginAndAwait(args.payload).pipe(
            traceLocalHandlerWork,
            Effect.catchTags({
              GracefulShutdownError: (error) => Effect.fail(error),
            }),
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
        }),
      )
      .handle(
        "gracefulShutdownStatus",
        Effect.fn("environment.maintain.gracefulShutdownStatus")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthEnvironmentMaintainScope);
          return yield* gracefulShutdown.status.pipe(traceLocalHandlerWork);
        }),
      )
      .handle(
        "gracefulShutdownComplete",
        Effect.fn("environment.maintain.gracefulShutdownComplete")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          yield* requireEnvironmentScope(AuthEnvironmentMaintainScope);
          yield* gracefulShutdown.complete(args.payload.shutdownId).pipe(
            traceLocalHandlerWork,
            Effect.catchTags({
              GracefulShutdownError: (error) => Effect.fail(error),
            }),
            Effect.catch((cause) => failEnvironmentInternal("internal_error", cause)),
          );
          return {};
        }),
      );
  }),
);
