import { gzip } from "node:zlib";

import {
  AuthOrchestrationReadScope,
  EnvironmentHttpApi,
  EnvironmentInternalError,
  PullRequestUnavailableError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { requireEnvironmentScope } from "../auth/http.ts";
import * as PullRequestService from "./PullRequestService.ts";

/** The patch is often the largest PR payload and benefits from HTTP compression and flow control. */
export const pullRequestHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "pullRequests",
  Effect.fnUntraced(function* (handlers) {
    const pullRequests = yield* Effect.serviceOption(PullRequestService.PullRequestService);
    return handlers.handle(
      "diff",
      Effect.fn("environment.pullRequests.diff")(function* (args) {
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        const pullRequestService = yield* Option.match(pullRequests, {
          onNone: () =>
            Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" })),
          onSome: Effect.succeed,
        });
        const diff = yield* pullRequestService.diff(args.payload);
        const acceptEncoding = args.request.headers["accept-encoding"];
        if (acceptEncoding?.toLowerCase().includes("gzip") !== true) {
          return diff;
        }
        const compressed = yield* Effect.tryPromise({
          try: () =>
            new Promise<Buffer>((resolve, reject) => {
              gzip(JSON.stringify(diff), (error, value) =>
                error ? reject(error) : resolve(value),
              );
            }),
          catch: (_cause) =>
            new EnvironmentInternalError({
              code: "internal_error",
              reason: "internal_error",
              traceId: crypto.randomUUID().replaceAll("-", ""),
            }),
        });
        return HttpServerResponse.uint8Array(compressed, {
          contentType: "application/json",
          headers: {
            "content-encoding": "gzip",
            vary: "Accept-Encoding",
          },
        });
      }),
    );
  }),
);
