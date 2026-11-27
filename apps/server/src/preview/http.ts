import { AuthPreviewOperateScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import {
  annotateEnvironmentRequest,
  failEnvironmentInternal,
  failEnvironmentNotFound,
  requireEnvironmentScope,
} from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as ThreadBrowser from "./ThreadBrowser.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "preview",
  Effect.fnUntraced(function* (handlers) {
    const threadBrowser = yield* ThreadBrowser.ThreadBrowser;
    return handlers.handle(
      "open",
      Effect.fn("environment.preview.open")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthPreviewOperateScope);
        return yield* threadBrowser.open(args.payload).pipe(
          traceLocalHandlerWork,
          Effect.catch(
            Effect.fnUntraced(function* (cause) {
              if (cause._tag === "ThreadBrowserThreadNotFoundError") {
                return yield* failEnvironmentNotFound("thread_not_found");
              }
              return yield* failEnvironmentInternal("preview_open_failed", cause);
            }),
          ),
        );
      }),
    );
  }),
);
