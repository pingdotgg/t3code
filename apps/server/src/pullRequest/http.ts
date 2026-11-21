import { builtinHttpApiGroup } from "../plugins/httpComposition.ts";
import { AuthOrchestrationReadScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { annotateEnvironmentRequest, requireEnvironmentScope } from "../auth/http.ts";
import { traceLocalHandlerWork } from "../cloud/traceRelayRequest.ts";
import * as PullRequestService from "./PullRequestService.ts";

// Large patches benefit from HTTP compression and flow control.
export const layer = builtinHttpApiGroup("t3.pull-requests")(
  EnvironmentHttpApi,
  "pullRequests",
  Effect.fnUntraced(function* (handlers) {
    const pullRequests = yield* PullRequestService.PullRequestService;
    return handlers.handle(
      "diff",
      Effect.fn("environment.pullRequests.diff")(function* (args) {
        yield* annotateEnvironmentRequest(args.endpoint.name);
        yield* requireEnvironmentScope(AuthOrchestrationReadScope);
        return yield* pullRequests.diff(args.payload).pipe(traceLocalHandlerWork);
      }),
    );
  }),
);
