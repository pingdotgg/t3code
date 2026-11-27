import {
  EnvironmentHttpApi,
  TeamHttpBadRequestError,
  TeamHttpConflictError,
  TeamHttpInternalError,
  TeamHttpNotFoundError,
  type TeamOperationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpEffect from "effect/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

import { checkRequestDpopProof } from "../auth/dpop.ts";
import { annotateEnvironmentRequest } from "../auth/http.ts";
import { deriveAuthClientMetadata } from "../auth/utils.ts";
import * as TeamService from "./TeamService.ts";

const CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendCredentialResponseHeaders = HttpEffect.appendPreResponseHandler((_request, response) =>
  Effect.succeed(HttpServerResponse.setHeaders(response, CREDENTIAL_RESPONSE_HEADERS)),
);

const mapTeamHttpError = (error: TeamOperationError) => {
  switch (error.code) {
    case "pseudo_taken":
    case "already_configured":
    case "invite_exhausted":
    case "invite_revoked":
    case "invite_expired":
    case "last_owner":
    case "default_view_protected":
    case "view_name_taken":
    case "default_environment_protected":
    case "environment_already_attached":
    case "note_hash_mismatch":
    case "note_not_pending":
    case "note_already_consumed":
    case "skill_slug_taken":
      return new TeamHttpConflictError({ code: error.code, message: error.message });
    case "not_found":
    case "not_configured":
      return new TeamHttpNotFoundError({ code: error.code, message: error.message });
    case "invalid_pseudo":
    case "invite_invalid":
    case "invalid_input":
    case "forbidden":
    case "environment_unavailable":
    case "provider_not_allowed":
    case "team_access_revoked":
    case "remote_only_provider":
    case "github_verification_failed":
    case "github_oauth_not_configured":
    case "github_oauth_failed":
    case "github_oauth_state_invalid":
      return new TeamHttpBadRequestError({ code: error.code, message: error.message });
    case "internal":
      return new TeamHttpInternalError({ code: error.code, message: error.message });
  }
};

export const layer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "team",
  Effect.fnUntraced(function* (handlers) {
    const teamService = yield* TeamService.TeamService;

    return handlers
      .handle(
        "previewInvite",
        Effect.fn("environment.team.previewInvite")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          return yield* teamService
            .previewInvite(args.payload.token)
            .pipe(Effect.mapError(mapTeamHttpError));
        }),
      )
      .handle(
        "redeemInvite",
        Effect.fn("environment.team.redeemInvite")(function* (args) {
          yield* annotateEnvironmentRequest(args.endpoint.name);
          const request = yield* HttpServerRequest.HttpServerRequest;
          const proof = args.headers.dpop
            ? yield* checkRequestDpopProof({ request }).pipe(
                Effect.mapError(
                  () =>
                    new TeamHttpBadRequestError({
                      code: "invite_invalid",
                      message: "Invalid DPoP proof header.",
                    }),
                ),
              )
            : undefined;
          if (proof) {
            // Verify invite before consuming the DPoP proof so malformed tokens do not burn replay markers.
            yield* teamService
              .previewInvite(args.payload.token)
              .pipe(Effect.mapError(mapTeamHttpError));
            yield* proof.consume.pipe(
              Effect.mapError((error) =>
                error._tag === "ServerAuthInvalidCredentialError"
                  ? new TeamHttpBadRequestError({
                      code: "invite_invalid",
                      message: "DPoP proof has already been used.",
                    })
                  : new TeamHttpInternalError({
                      code: "internal",
                      message: "An internal team service error occurred.",
                    }),
              ),
            );
          }
          yield* appendCredentialResponseHeaders;
          return yield* teamService
            .redeemInvite({
              token: args.payload.token,
              pseudo: args.payload.pseudo,
              client: deriveAuthClientMetadata({
                request,
                presented: {
                  ...(args.payload.clientLabel ? { label: args.payload.clientLabel } : {}),
                  ...(args.payload.clientDeviceType
                    ? { deviceType: args.payload.clientDeviceType }
                    : {}),
                  ...(args.payload.clientOs ? { os: args.payload.clientOs } : {}),
                },
              }),
              ...(proof ? { proofKeyThumbprint: proof.thumbprint } : {}),
            })
            .pipe(Effect.mapError(mapTeamHttpError));
        }),
      );
  }),
);
