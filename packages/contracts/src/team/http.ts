import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpServerRespondable from "effect/http/HttpServerRespondable";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as Schema from "effect/Schema";
import {
  TeamInvitePreviewRequest,
  TeamInvitePreviewResult,
  TeamOperationErrorCode,
  TeamRedeemInviteRequest,
  TeamRedeemInviteResponse,
} from "./schemas.ts";

const OptionalDpopHeaders = Schema.Struct({
  dpop: Schema.optionalKey(Schema.String),
});

export class TeamHttpBadRequestError extends Schema.TaggedError<TeamHttpBadRequestError>()(
  "TeamHttpBadRequestError",
  {
    code: TeamOperationErrorCode,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(TeamHttpBadRequestError)(this, { status: 400 });
  }
}

export class TeamHttpConflictError extends Schema.TaggedError<TeamHttpConflictError>()(
  "TeamHttpConflictError",
  {
    code: TeamOperationErrorCode,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(TeamHttpConflictError)(this, { status: 409 });
  }
}

export class TeamHttpNotFoundError extends Schema.TaggedError<TeamHttpNotFoundError>()(
  "TeamHttpNotFoundError",
  {
    code: TeamOperationErrorCode,
    message: Schema.String,
  },
  { httpApiStatus: 404 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(TeamHttpNotFoundError)(this, { status: 404 });
  }
}

export class TeamHttpInternalError extends Schema.TaggedError<TeamHttpInternalError>()(
  "TeamHttpInternalError",
  {
    code: TeamOperationErrorCode,
    message: Schema.String,
  },
  { httpApiStatus: 500 },
) {
  [HttpServerRespondable.symbol]() {
    return HttpServerResponse.schemaJson(TeamHttpInternalError)(this, { status: 500 });
  }
}

const TeamHttpErrors = [
  TeamHttpBadRequestError,
  TeamHttpConflictError,
  TeamHttpNotFoundError,
  TeamHttpInternalError,
] as const;

export class EnvironmentTeamHttpApi extends HttpApiGroup.make("team")
  .add(
    HttpApiEndpoint.post("previewInvite", "/api/team/invites/preview", {
      payload: TeamInvitePreviewRequest,
      success: TeamInvitePreviewResult,
      error: TeamHttpErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("redeemInvite", "/api/team/invites/redeem", {
      headers: OptionalDpopHeaders,
      payload: TeamRedeemInviteRequest,
      success: TeamRedeemInviteResponse,
      error: TeamHttpErrors,
    }),
  ) {}
