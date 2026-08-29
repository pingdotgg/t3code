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
import * as ServerSettings from "../serverSettings.ts";
import { copilotReviewRuntimeHandler } from "./CopilotReviewRuntime.ts";

class CopilotRuntimeRequestError extends Data.TaggedError("CopilotRuntimeRequestError")<{
  readonly cause: unknown;
}> {}

const handleCopilotRuntimeRequest = Effect.gen(function* () {
  yield* authenticateRawRouteWithScope(AuthOrchestrationOperateScope);
  const reviewRuntimeSettings = yield* ServerSettings.getCopilotKitReviewRuntimeSettings;
  const request = yield* HttpServerRequest.HttpServerRequest;
  const webRequestResult = HttpServerRequest.toWebResult(request);
  if (Result.isFailure(webRequestResult)) {
    return HttpServerResponse.text("Invalid request URL", { status: 400 });
  }

  const openRouterBaseUrl = globalThis.process.env.OPENROUTER_BASE_URL?.trim();
  const response = yield* Effect.tryPromise({
    try: () =>
      copilotReviewRuntimeHandler(webRequestResult.success, {
        ...reviewRuntimeSettings,
        ...(openRouterBaseUrl ? { openRouterBaseUrl } : {}),
      }),
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
    ServerSettingsError: () =>
      Effect.succeed(
        HttpServerResponse.text("Could not read CopilotKit settings", { status: 500 }),
      ),
  }),
);

export const copilotReviewRouteLayer = HttpRouter.add(
  "*",
  "/api/copilotkit/*",
  handleCopilotRuntimeRequest,
);
