import { AuthEnvironmentMaintainScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "./auth/http.ts";
import { UpdatePause } from "./updatePause.ts";

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "server",
  Effect.fnUntraced(function* (handlers) {
    const updatePause = yield* UpdatePause;
    return handlers.handle(
      "pauseForUpdate",
      Effect.fn("environment.server.pauseForUpdate")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthEnvironmentMaintainScope);
        return yield* updatePause.pauseRunsForUpdate;
      }),
    );
  }),
);
