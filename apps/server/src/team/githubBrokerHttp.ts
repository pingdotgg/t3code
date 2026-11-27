// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous SHA-256 hashing for local sync token lookup.
import * as NodeCrypto from "node:crypto";

import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  canMemberAccessTeamEnvironment,
  isTeamAdminRole,
  TeamGitHubRemoteLeaseIssueRequest,
  TeamGitHubRemoteLeaseResolveRequest,
  TeamGitHubRemoteLeaseRevokeRequest,
  type TeamMember,
  type TeamWorkspace,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as TeamAssetsRepository from "./TeamAssetsRepository.ts";
import * as TeamGitHubBroker from "./TeamGitHubBroker.ts";
import * as TeamGitHubOAuth from "./TeamGitHubOAuth.ts";
import * as TeamRepository from "./TeamRepository.ts";
import * as TeamService from "./TeamService.ts";

const GITHUB_LEASE_ISSUE_PATH = "/api/team/github-lease/issue";
const GITHUB_LEASE_RESOLVE_PATH = "/api/team/github-lease/resolve";
const GITHUB_LEASE_RENEW_PATH = "/api/team/github-lease/renew";
const GITHUB_LEASE_REVOKE_PATH = "/api/team/github-lease/revoke";
const GITHUB_OAUTH_CALLBACK_PATH = TeamGitHubOAuth.TEAM_GITHUB_OAUTH_CALLBACK_PATH;

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const OAUTH_HTML_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
  "referrer-policy": "no-referrer",
  "x-frame-options": "DENY",
  "content-security-policy":
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
} as const;

const decodeIssueRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(TeamGitHubRemoteLeaseIssueRequest),
);
const decodeResolveRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(TeamGitHubRemoteLeaseResolveRequest),
);
const decodeRevokeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(TeamGitHubRemoteLeaseRevokeRequest),
);
const encodeJsonUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function hashToken(raw: string): string {
  return NodeCrypto.createHash("sha256").update(raw.trim(), "utf8").digest("hex");
}

function extractBearerToken(request: HttpServerRequest.HttpServerRequest): string | null {
  const auth = request.headers.authorization;
  if (typeof auth !== "string") return null;
  const match = /^(?:Bearer|DPoP)\s+(.+)$/i.exec(auth.trim());
  return match?.[1]?.trim() || null;
}

function jsonResponse(status: number, body: unknown) {
  return HttpServerResponse.text(encodeJsonUnknown(body), {
    status,
    contentType: "application/json",
    headers: NO_STORE_HEADERS,
  });
}

type LeaseAuthOutcome =
  | {
      readonly ok: true;
      readonly team: TeamWorkspace;
      readonly member: TeamMember;
      readonly scopes: ReadonlyArray<string>;
    }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 404;
      readonly code: string;
      readonly message: string;
    };

const authenticateLeaseCaller = Effect.fn("TeamGitHubHttp.authenticateCaller")(function* (
  request: HttpServerRequest.HttpServerRequest,
): Effect.fn.Return<
  LeaseAuthOutcome,
  never,
  TeamRepository.TeamRepository | EnvironmentAuth.EnvironmentAuth
> {
  const teamRepo = yield* TeamRepository.TeamRepository;
  const envAuth = yield* EnvironmentAuth.EnvironmentAuth;
  const assetsRepoOpt = yield* Effect.serviceOption(TeamAssetsRepository.TeamAssetsRepository);
  const authSessionsOpt = yield* Effect.serviceOption(AuthSessions.AuthSessionRepository);

  const workspaceOpt = yield* teamRepo
    .getWorkspace()
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(workspaceOpt)) {
    return {
      ok: false,
      status: 404,
      code: "not_configured",
      message: "No team workspace is configured on this server.",
    };
  }
  const team = workspaceOpt.value;

  const presentedToken = extractBearerToken(request);
  if (presentedToken !== null && Option.isSome(assetsRepoOpt)) {
    const syncTokenOpt = yield* assetsRepoOpt.value
      .findLocalSyncTokenByHash(hashToken(presentedToken))
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(syncTokenOpt)) {
      const tokenRecord = syncTokenOpt.value;
      if (tokenRecord.revokedAt !== null || tokenRecord.teamId !== team.id) {
        return {
          ok: false,
          status: 403,
          code: "team_access_revoked",
          message: "Your team access has been revoked.",
        };
      }
      if (Option.isNone(authSessionsOpt)) {
        return {
          ok: false,
          status: 403,
          code: "team_access_revoked",
          message: "Session verification service is unavailable.",
        };
      }
      const sessionOpt = yield* authSessionsOpt.value
        .getById({ sessionId: tokenRecord.sessionId })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
      if (
        Option.isNone(sessionOpt) ||
        sessionOpt.value.revokedAt !== null ||
        DateTime.toEpochMillis(sessionOpt.value.expiresAt) <= nowMs
      ) {
        return {
          ok: false,
          status: 403,
          code: "team_access_revoked",
          message: "Your team session has expired or been revoked.",
        };
      }
      const memberOpt = yield* teamRepo
        .getMemberById(tokenRecord.memberId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(memberOpt) || memberOpt.value.status !== "active") {
        return {
          ok: false,
          status: 403,
          code: "team_access_revoked",
          message: "Your team membership is no longer active.",
        };
      }
      return { ok: true, team, member: memberOpt.value, scopes: sessionOpt.value.scopes };
    }
  }

  const sessionResult = yield* Effect.result(envAuth.authenticateHttpRequest(request));
  if (sessionResult._tag === "Failure") {
    return {
      ok: false,
      status: 401,
      code: "auth_invalid",
      message: "Authentication required for team GitHub credential leases.",
    };
  }
  const bindingOpt = yield* teamRepo
    .getSessionBinding(sessionResult.success.sessionId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(bindingOpt) || bindingOpt.value.teamId !== team.id) {
    return {
      ok: false,
      status: 403,
      code: "team_access_revoked",
      message: "Session is not bound to an active team member.",
    };
  }
  const memberOpt = yield* teamRepo
    .getMemberById(bindingOpt.value.memberId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(memberOpt) || memberOpt.value.status !== "active") {
    return {
      ok: false,
      status: 403,
      code: "team_access_revoked",
      message: "Your team membership is no longer active.",
    };
  }
  return { ok: true, team, member: memberOpt.value, scopes: sessionResult.success.scopes };
});

const handleIssueRemoteLease = Effect.fn("TeamGitHubHttp.issue")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* authenticateLeaseCaller(request);
  if (!auth.ok) {
    return jsonResponse(auth.status, { code: auth.code, message: auth.message });
  }
  if (!auth.scopes.includes(AuthOrchestrationOperateScope)) {
    return jsonResponse(403, {
      code: "forbidden",
      message: "Session lacks orchestration:operate scope required to issue GitHub turn leases.",
    });
  }
  const rawBody = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
  const parsed = decodeIssueRequest(rawBody);
  if (Option.isNone(parsed)) {
    return jsonResponse(400, {
      code: "invalid_input",
      message: "Invalid GitHub turn lease issue request.",
    });
  }
  const payload = parsed.value;
  const teamRepo = yield* TeamRepository.TeamRepository;
  const broker = yield* TeamGitHubBroker.TeamGitHubBroker;

  const envOpt = yield* teamRepo
    .getEnvironmentByEnvironmentId({
      teamId: auth.team.id,
      environmentId: payload.environmentId,
    })
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(envOpt)) {
    return jsonResponse(404, {
      code: "not_found",
      message: "Target environment is not attached to this team.",
    });
  }
  if (!canMemberAccessTeamEnvironment(auth.member, envOpt.value)) {
    return jsonResponse(403, {
      code: "forbidden",
      message: "You do not have access to this team environment.",
    });
  }

  const authorKind = payload.authorKind ?? "member";
  if (authorKind === "team_automation") {
    if (!isTeamAdminRole(auth.member.role) || !auth.scopes.includes(AuthAccessWriteScope)) {
      return jsonResponse(403, {
        code: "forbidden",
        message:
          "Only owner and admin sessions with access:write may issue team automation GitHub leases.",
      });
    }
    const issued = yield* broker.issueRemoteTurnLease({
      teamId: auth.team.id,
      environmentId: payload.environmentId,
      threadId: payload.threadId,
      turnId: payload.turnId,
      authorKind: "team_automation",
      authorMemberId: null,
    });
    return jsonResponse(200, issued);
  }

  // Strictly bind human remote turn leases to the authenticated member — never allow spoofing another memberId.
  if (
    payload.authorMemberId !== undefined &&
    payload.authorMemberId !== null &&
    payload.authorMemberId !== auth.member.id
  ) {
    return jsonResponse(403, {
      code: "forbidden",
      message: "Cannot request a GitHub turn lease for another team member.",
    });
  }

  const issued = yield* broker.issueRemoteTurnLease({
    teamId: auth.team.id,
    environmentId: payload.environmentId,
    threadId: payload.threadId,
    turnId: payload.turnId,
    authorKind: "member",
    authorMemberId: auth.member.id,
  });
  return jsonResponse(200, issued);
});

const handleResolveRemoteLease = Effect.fn("TeamGitHubHttp.resolve")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const rawBody = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
  const parsed = decodeResolveRequest(rawBody);
  if (Option.isNone(parsed)) {
    return jsonResponse(400, {
      code: "invalid_input",
      message: "Invalid GitHub turn lease resolve request.",
    });
  }
  const broker = yield* TeamGitHubBroker.TeamGitHubBroker;
  const resolved = yield* broker.resolveRemoteTurnLease(parsed.value);
  if (resolved === null) {
    return jsonResponse(403, {
      code: "lease_revoked",
      message: "GitHub turn credential lease is invalid, expired, or has been revoked.",
    });
  }
  return jsonResponse(200, resolved);
});

const handleRenewRemoteLease = Effect.fn("TeamGitHubHttp.renew")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const rawBody = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
  const parsed = decodeResolveRequest(rawBody);
  if (Option.isNone(parsed)) {
    return jsonResponse(400, {
      code: "invalid_input",
      message: "Invalid GitHub turn lease renew request.",
    });
  }
  const broker = yield* TeamGitHubBroker.TeamGitHubBroker;
  const renewed = yield* broker.renewRemoteTurnLease(parsed.value);
  if (renewed === null) {
    return jsonResponse(403, {
      code: "lease_revoked",
      message: "GitHub turn credential lease is invalid, expired, or has been revoked.",
    });
  }
  return jsonResponse(200, renewed);
});

const handleRevokeRemoteLease = Effect.fn("TeamGitHubHttp.revoke")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const rawBody = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
  const parsed = decodeRevokeRequest(rawBody);
  if (Option.isNone(parsed)) {
    return jsonResponse(400, {
      code: "invalid_input",
      message: "Invalid GitHub turn lease revoke request.",
    });
  }
  const broker = yield* TeamGitHubBroker.TeamGitHubBroker;
  const payload = parsed.value;

  // Remote execution environments can revoke their own single-turn lease directly using the lease token.
  if (payload.leaseId !== undefined && payload.leaseToken !== undefined) {
    const revoked = yield* broker.revokeRemoteTurnLease({
      leaseId: payload.leaseId,
      leaseToken: payload.leaseToken,
      ...(payload.environmentId !== undefined ? { environmentId: payload.environmentId } : {}),
      ...(payload.threadId !== undefined ? { threadId: payload.threadId } : {}),
      ...(payload.turnId !== undefined ? { turnId: payload.turnId } : {}),
    });
    return jsonResponse(200, { revoked });
  }

  const auth = yield* authenticateLeaseCaller(request);
  if (!auth.ok) {
    return jsonResponse(auth.status, { code: auth.code, message: auth.message });
  }
  if (!auth.scopes.includes(AuthOrchestrationOperateScope)) {
    return jsonResponse(403, {
      code: "forbidden",
      message: "Session lacks orchestration:operate scope required to revoke GitHub turn leases.",
    });
  }
  const revoked = yield* broker.revokeRemoteTurnLease({
    ...(payload.leaseId !== undefined ? { leaseId: payload.leaseId } : {}),
    ...(payload.environmentId !== undefined ? { environmentId: payload.environmentId } : {}),
    ...(payload.threadId !== undefined ? { threadId: payload.threadId } : {}),
    ...(payload.turnId !== undefined ? { turnId: payload.turnId } : {}),
    // Non-admin members may only revoke their own remote leases; owner/admin may revoke any team turn lease.
    ...(!isTeamAdminRole(auth.member.role) ? { authorizedMemberId: auth.member.id } : {}),
  });
  return jsonResponse(200, { revoked });
});

const handleGitHubOAuthCallback = Effect.fn("TeamGitHubHttp.oauthCallback")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const teamService = yield* TeamService.TeamService;
  const parsedUrl = new URL(request.url, "http://localhost");
  const code = parsedUrl.searchParams.get("code");
  const state = parsedUrl.searchParams.get("state");
  const error = parsedUrl.searchParams.get("error");
  const errorDescription = parsedUrl.searchParams.get("error_description");

  const result = yield* Effect.result(
    teamService.completeGitHubOAuthCallback({
      code,
      state,
      error,
      errorDescription,
    }),
  );

  if (result._tag === "Success") {
    const html = TeamGitHubOAuth.renderGitHubOAuthCallbackHtml({
      ok: true,
      githubLogin: result.success.identity.githubLogin,
      mode: result.success.mode,
    });
    return HttpServerResponse.text(html, {
      status: 200,
      contentType: "text/html; charset=utf-8",
      headers: OAUTH_HTML_HEADERS,
    });
  }

  const err = result.failure;
  const status =
    err.code === "forbidden"
      ? 403
      : err.code === "github_oauth_state_invalid" ||
          err.code === "invalid_input" ||
          err.code === "github_oauth_not_configured"
        ? 400
        : err.code === "github_oauth_failed" || err.code === "github_verification_failed"
          ? 502
          : 500;
  const html = TeamGitHubOAuth.renderGitHubOAuthCallbackHtml({
    ok: false,
    message: err.message,
  });
  return HttpServerResponse.text(html, {
    status,
    contentType: "text/html; charset=utf-8",
    headers: OAUTH_HTML_HEADERS,
  });
});

export const layer = Layer.mergeAll(
  HttpRouter.add("POST", GITHUB_LEASE_ISSUE_PATH, handleIssueRemoteLease()),
  HttpRouter.add("POST", GITHUB_LEASE_RESOLVE_PATH, handleResolveRemoteLease()),
  HttpRouter.add("POST", GITHUB_LEASE_RENEW_PATH, handleRenewRemoteLease()),
  HttpRouter.add("POST", GITHUB_LEASE_REVOKE_PATH, handleRevokeRemoteLease()),
  HttpRouter.add("GET", GITHUB_OAUTH_CALLBACK_PATH, handleGitHubOAuthCallback()),
);
