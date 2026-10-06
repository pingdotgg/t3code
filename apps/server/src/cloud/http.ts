import { AuthRelayReadScope, AuthRelayWriteScope, EnvironmentHttpApi } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { requireEnvironmentScope } from "../auth/http.ts";
import * as CloudLink from "./CloudLink.ts";
import { traceRelayRequest } from "./traceRelayRequest.ts";

const CLOUD_CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendCloudCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, CLOUD_CREDENTIAL_RESPONSE_HEADERS)),
);

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connect",
  Effect.fnUntraced(function* (handlers) {
    const cloudLink = yield* CloudLink.CloudLink;
    return handlers
      .handle("linkProof", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const proof = yield* cloudLink.linkProof(payload, request);
          yield* appendCloudCredentialResponseHeaders;
          return proof;
        }),
      )
      .handle("relayConfig", ({ payload }) =>
        requireEnvironmentScope(AuthRelayWriteScope).pipe(
          Effect.andThen(cloudLink.applyRelayConfig(payload)),
        ),
      )
      .handle("linkState", () =>
        requireEnvironmentScope(AuthRelayReadScope).pipe(Effect.andThen(cloudLink.linkState())),
      )
      .handle("unlink", () =>
        requireEnvironmentScope(AuthRelayWriteScope).pipe(Effect.andThen(cloudLink.unlink())),
      )
      .handle("preferences", ({ payload }) =>
        requireEnvironmentScope(AuthRelayWriteScope).pipe(
          Effect.andThen(cloudLink.updatePreferences(payload)),
        ),
      )
      .handle("health", ({ payload }) =>
        cloudLink
          .answerHealthRequest(payload)
          .pipe(Effect.tap(() => appendCloudCredentialResponseHeaders)),
      )
      .handle("mintCredential", ({ payload }) =>
        cloudLink
          .mintCredential(payload)
          .pipe(Effect.tap(() => appendCloudCredentialResponseHeaders)),
      )
      .handle("t3MintCredential", ({ payload }) =>
        traceRelayRequest(
          cloudLink
            .mintCredential(payload)
            .pipe(Effect.tap(() => appendCloudCredentialResponseHeaders)),
        ),
      );
  }),
);
