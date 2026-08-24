import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/unstable/http";

import { authenticateRawRouteWithScope } from "../http.ts";
import { copilotReviewRuntimeHandler } from "./CopilotReviewRuntime.ts";

class CopilotRuntimeRequestError extends Data.TaggedError("CopilotRuntimeRequestError")<{
  readonly cause: unknown;
}> {}

const handleCopilotRuntimeRequest = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequestResult = HttpServerRequest.toWebResult(request);
  if (Result.isFailure(webRequestResult)) {
    return HttpServerResponse.text("Invalid request URL", { status: 400 });
  }

  const response = yield* Effect.tryPromise({
    try: () => copilotReviewRuntimeHandler(webRequestResult.success),
    catch: (cause) => new CopilotRuntimeRequestError({ cause }),
  }).pipe(
    Effect.tapError((error) => Effect.logError("CopilotKit runtime request failed", error)),
    Effect.orElseSucceed(() => new Response("CopilotKit runtime request failed", { status: 500 })),
  );
  return HttpServerResponse.fromWeb(response);
}).pipe(
  Effect.catchTags({
    EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
    EnvironmentInternalError: HttpServerRespondable.toResponse,
    EnvironmentScopeRequiredError: HttpServerRespondable.toResponse,
  }),
);

export const copilotReviewRouteLayer = HttpRouter.add(
  "*",
  "/api/copilotkit/*",
  handleCopilotRuntimeRequest,
);
