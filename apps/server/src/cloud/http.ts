import * as BrowserAuth from "./BrowserAuth.ts";
import {
  AuthRelayReadScope,
  AuthRelayWriteScope,
  EnvironmentCloudEndpointUnavailableError,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";

import { requireEnvironmentScope } from "../auth/http.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ManagedLimits from "../policy/managedLimits.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import type { RelayRequestError } from "./relayResponse.ts";
import { traceRelayRequest } from "./traceRelayRequest.ts";

const CLOUD_CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendCloudCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, CLOUD_CREDENTIAL_RESPONSE_HEADERS)),
);

const internalServerError = (error: { readonly message: string }, cause: unknown) =>
  Effect.logError(error.message, { cause }).pipe(
    Effect.andThen(Effect.fail(new EnvironmentHttpInternalServerError({ message: error.message }))),
  );

const relayFailure = (error: RelayRequestError) => {
  const message = error.message;
  switch (error.rejection) {
    case "unauthorized":
      return Effect.fail(new EnvironmentHttpUnauthorizedError({ message }));
    case "forbidden":
      return Effect.fail(new EnvironmentHttpForbiddenError({ message }));
    case "rejected":
      return Effect.fail(new EnvironmentHttpBadRequestError({ message }));
    case "unavailable":
      return Effect.fail(new EnvironmentHttpInternalServerError({ message }));
  }
};

const badRequest = (error: { readonly message: string }) =>
  Effect.fail(new EnvironmentHttpBadRequestError({ message: error.message }));
const unauthorized = (error: { readonly message: string }) =>
  Effect.fail(new EnvironmentHttpUnauthorizedError({ message: error.message }));
const conflict = (error: { readonly message: string }) =>
  Effect.fail(new EnvironmentHttpConflictError({ message: error.message }));

const connectErrorCases = {
  CloudLinkRelayConfigInvalidError: badRequest,
  CloudLinkOriginInvalidError: badRequest,
  CloudLinkNotLinkedError: badRequest,
  CloudLinkAccountMismatchError: conflict,
  CloudLinkAuthorizationMissingError: unauthorized,
  CloudLinkProofRejectedError: unauthorized,
  CloudLinkProofReplayedError: conflict,
  CloudLinkTunnelSupersededError: conflict,
  ManagedPolicyRefusedError: (error: ManagedLimits.ManagedPolicyRefusedError) =>
    Effect.fail(new EnvironmentHttpForbiddenError({ message: error.message })),
  CloudLinkInternalError: (error: CloudLink.CloudLinkInternalError) =>
    internalServerError(error, error.cause),
  RelayRequestError: relayFailure,
} as const;

type ConnectFailure =
  | Exclude<CloudLink.CloudLinkError, CloudLink.CloudLinkEndpointUnavailableError>
  | EnvironmentAuth.ServerAuthInternalError
  | ManagedLimits.ManagedPolicyRefusedError
  | RelayRequestError;

const toHttpError = <A, R>(effect: Effect.Effect<A, ConnectFailure, R>) =>
  effect.pipe(
    Effect.catchTags(connectErrorCases),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      internalServerError(error, error),
    ),
  );

const toHttpErrorOrUnavailable = <A, R>(
  effect: Effect.Effect<A, ConnectFailure | CloudLink.CloudLinkEndpointUnavailableError, R>,
) =>
  effect.pipe(
    Effect.catchTags({
      ...connectErrorCases,
      CloudLinkEndpointUnavailableError: (error) =>
        Effect.fail(
          new EnvironmentCloudEndpointUnavailableError({
            message: error.message,
            endpointRuntimeStatus: error.endpointRuntimeStatus,
          }),
        ),
    }),
    Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
      internalServerError(error, error),
    ),
  );

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connect",
  Effect.fnUntraced(function* (handlers) {
    const cloudLink = yield* CloudLink.CloudLink;
    const reachability = yield* ConnectReachability.ConnectReachability;
    const browserAuth = yield* BrowserAuth.BrowserAuth;
    const nativeAuth = Effect.fn("nativeAuth")(function* (query: {
      readonly path: string;
      readonly search: string;
    }) {
      yield* requireEnvironmentScope(AuthRelayWriteScope);
      const request = yield* HttpServerRequest.HttpServerRequest;
      const response = yield* browserAuth
        .forward({
          ...query,
          method: request.method === "GET" ? "GET" : "POST",
          ...(request.method === "POST"
            ? {
                body: new Uint8Array(
                  yield* request.arrayBuffer.pipe(
                    Effect.mapError(
                      () =>
                        new EnvironmentHttpBadRequestError({
                          message: "Invalid sign-in request body.",
                        }),
                    ),
                  ),
                ),
              }
            : {}),
          ...(request.headers["x-t3-clerk-client"]
            ? { clientToken: request.headers["x-t3-clerk-client"] }
            : {}),
          ...(request.headers["content-type"]
            ? { contentType: request.headers["content-type"] }
            : {}),
        })
        .pipe(
          Effect.mapError(
            (error) => new EnvironmentHttpInternalServerError({ message: error.message }),
          ),
        );
      return HttpServerResponse.text(response.body, {
        status: response.status,
        headers: {
          ...CLOUD_CREDENTIAL_RESPONSE_HEADERS,
          "content-type": "application/json",
          ...(response.clientToken ? { "x-t3-clerk-client": response.clientToken } : {}),
        },
      });
    });
    return handlers
      .handle("nativeAuthGet", ({ query }) => nativeAuth(query))
      .handle("nativeAuthPost", ({ query }) => nativeAuth(query))
      .handle("linkProof", ({ payload }) =>
        Effect.gen(function* () {
          yield* requireEnvironmentScope(AuthRelayWriteScope);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const proof = yield* toHttpError(cloudLink.linkProof(payload, request));
          yield* appendCloudCredentialResponseHeaders;
          return proof;
        }),
      )
      .handle("relayConfig", ({ payload }) =>
        requireEnvironmentScope(AuthRelayWriteScope).pipe(
          Effect.andThen(toHttpErrorOrUnavailable(cloudLink.applyRelayConfig(payload))),
        ),
      )
      .handle("linkState", () =>
        requireEnvironmentScope(AuthRelayReadScope).pipe(
          Effect.andThen(toHttpError(cloudLink.linkState())),
        ),
      )
      .handle("checkReachability", () =>
        requireEnvironmentScope(AuthRelayReadScope).pipe(Effect.andThen(reachability.check)),
      )
      .handle("unlink", () =>
        requireEnvironmentScope(AuthRelayWriteScope).pipe(
          Effect.andThen(toHttpError(cloudLink.unlink())),
        ),
      )
      .handle("preferences", ({ payload }) =>
        requireEnvironmentScope(AuthRelayWriteScope).pipe(
          Effect.andThen(toHttpError(cloudLink.updatePreferences(payload))),
        ),
      )
      .handle("health", ({ payload }) =>
        toHttpError(cloudLink.answerHealthRequest(payload)).pipe(
          Effect.tap(() => appendCloudCredentialResponseHeaders),
        ),
      )
      .handle("t3MintCredential", ({ payload }) =>
        traceRelayRequest(
          toHttpError(cloudLink.mintCredential(payload)).pipe(
            Effect.tap(() => appendCloudCredentialResponseHeaders),
          ),
        ),
      );
  }),
);
