// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous SHA-256 hashing for local sync token lookup.
import * as NodeCrypto from "node:crypto";

import {
  NonNegativeInt,
  ProviderInstanceId,
  type TeamAssetsDeltaResponse,
  type TeamMember,
  type TeamWorkspace,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { requestUrl } from "../requestUrl.ts";
import * as TeamAssetsRepository from "./TeamAssetsRepository.ts";
import {
  issueEphemeralTeamProviderLease,
  readTeamProviderSecret,
} from "./TeamProviderLeaseService.ts";
import * as TeamRepository from "./TeamRepository.ts";

const TEAM_PROVIDER_PROXY_PREFIX = "/api/team/provider-proxy/";
const TEAM_PROVIDER_LEASE_PREFIX = "/api/team/provider-lease/";
const TEAM_ASSETS_ROUTE_PATH = "/api/team/assets";

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const HOP_BY_HOP_AND_AUTH_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "cookie",
]);

const LeaseBodySchema = Schema.fromJsonString(
  Schema.Struct({
    forceRefresh: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeLeaseBody = Schema.decodeUnknownOption(LeaseBodySchema);

function hashToken(raw: string): string {
  return NodeCrypto.createHash("sha256").update(raw.trim(), "utf8").digest("hex");
}

function extractPresentedBearerLikeToken(
  request: HttpServerRequest.HttpServerRequest,
): string | null {
  const auth = request.headers.authorization;
  if (typeof auth === "string") {
    const match = /^(?:Bearer|DPoP)\s+(.+)$/i.exec(auth.trim());
    if (match?.[1]?.trim()) return match[1].trim();
  }
  const xApiKey = request.headers["x-api-key"];
  if (typeof xApiKey === "string" && xApiKey.trim().length > 0) {
    return xApiKey.trim();
  }
  const xGoogKey = request.headers["x-goog-api-key"];
  if (typeof xGoogKey === "string" && xGoogKey.trim().length > 0) {
    return xGoogKey.trim();
  }
  return null;
}

type TeamHttpAuthOutcome =
  | {
      readonly ok: true;
      readonly team: TeamWorkspace;
      readonly member: TeamMember;
    }
  | {
      readonly ok: false;
      readonly status: 401 | 403 | 404;
      readonly code: "auth_invalid" | "team_access_revoked" | "not_configured";
      readonly message: string;
    };

/**
 * Authenticates a Team Provider Proxy / OAuth Token Lease / Delta Assets HTTP request.
 * - Valid active member session or local-sync token -> `{ ok: true, team, member }`
 * - Previously issued member token whose member was suspended/removed or token revoked -> `403 team_access_revoked`
 * - Missing or unknown credential -> `401 auth_invalid`
 */
const encodeJsonUnknown = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const authenticateTeamMemberHttpRequest = Effect.fn("TeamProviderProxyHttp.authenticateTeamMember")(
  function* (
    request: HttpServerRequest.HttpServerRequest,
  ): Effect.fn.Return<
    TeamHttpAuthOutcome,
    never,
    | TeamRepository.TeamRepository
    | TeamAssetsRepository.TeamAssetsRepository
    | EnvironmentAuth.EnvironmentAuth
  > {
    const teamRepo = yield* TeamRepository.TeamRepository;
    const assetsRepo = yield* TeamAssetsRepository.TeamAssetsRepository;
    const envAuth = yield* EnvironmentAuth.EnvironmentAuth;

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

    const presentedToken = extractPresentedBearerLikeToken(request);
    if (presentedToken !== null) {
      const tokenRecordOpt = yield* assetsRepo
        .findLocalSyncTokenByHash(hashToken(presentedToken))
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(tokenRecordOpt)) {
        const tokenRecord = tokenRecordOpt.value;
        if (tokenRecord.revokedAt !== null || tokenRecord.teamId !== team.id) {
          return {
            ok: false,
            status: 403,
            code: "team_access_revoked",
            message: "Your team access has been revoked.",
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
        return { ok: true, team, member: memberOpt.value };
      }
    }

    // Fallback: authenticate via standard EnvironmentAuth (Bearer/DPoP/cookie session) and check team_session_meta.
    const sessionResult = yield* Effect.result(envAuth.authenticateHttpRequest(request));
    if (sessionResult._tag === "Failure") {
      return {
        ok: false,
        status: 401,
        code: "auth_invalid",
        message: "Authentication required for team provider endpoints.",
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
        message: "Your team membership has been suspended or removed.",
      };
    }
    return { ok: true, team, member: memberOpt.value };
  },
);

function jsonErrorResponse(status: number, code: string, message: string) {
  return HttpServerResponse.text(JSON.stringify({ code, message }), {
    status,
    contentType: "application/json",
    headers: NO_STORE_HEADERS,
  });
}

const handleProviderProxy = Effect.fn("TeamProviderProxyHttp.proxy")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const urlOpt = requestUrl(request);
  if (Option.isNone(urlOpt)) {
    return jsonErrorResponse(400, "invalid_input", "Malformed request URL.");
  }

  const auth = yield* authenticateTeamMemberHttpRequest(request);
  if (!auth.ok) {
    return jsonErrorResponse(auth.status, auth.code, auth.message);
  }

  const remainder = urlOpt.value.pathname.slice(TEAM_PROVIDER_PROXY_PREFIX.length);
  const slashIndex = remainder.indexOf("/");
  const rawInstanceId = decodeURIComponent(
    slashIndex === -1 ? remainder : remainder.slice(0, slashIndex),
  );
  const subpath = slashIndex === -1 ? "" : remainder.slice(slashIndex);
  if (!rawInstanceId) {
    return jsonErrorResponse(400, "invalid_input", "Missing providerInstanceId in proxy path.");
  }

  const assetsRepo = yield* TeamAssetsRepository.TeamAssetsRepository;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;

  const providerInstanceId = ProviderInstanceId.make(rawInstanceId);
  const providerOpt = yield* assetsRepo
    .getProviderByInstanceId(auth.team.id, providerInstanceId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(providerOpt) || !providerOpt.value.enabled) {
    return jsonErrorResponse(
      404,
      "not_found",
      `Team provider "${rawInstanceId}" is not available.`,
    );
  }
  const provider = providerOpt.value;
  if (provider.deliveryStrategy !== "proxy" || !provider.upstreamBaseUrl) {
    return jsonErrorResponse(
      400,
      "invalid_input",
      `Team provider "${rawInstanceId}" is not configured for proxy delivery.`,
    );
  }

  const storedSecret = provider.secretKey
    ? yield* readTeamProviderSecret(secrets, provider.secretKey).pipe(
        Effect.orElseSucceed(() => null),
      )
    : null;

  const targetUrl = `${provider.upstreamBaseUrl.replace(/\/+$/, "")}${subpath}${urlOpt.value.search}`;
  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const bodyBytes = hasBody
    ? yield* request.arrayBuffer.pipe(
        Effect.map((buf) => new Uint8Array(buf)),
        Effect.orElseSucceed(() => new Uint8Array()),
      )
    : undefined;

  let outbound = HttpClientRequest.make(
    method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD",
  )(targetUrl);
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    if (HOP_BY_HOP_AND_AUTH_HEADERS.has(key.toLowerCase())) continue;
    outbound = HttpClientRequest.setHeader(outbound, key, value);
  }
  if (storedSecret?.apiKey) {
    const headerName = provider.apiKeyHeader ?? "authorization";
    const headerPrefix = provider.apiKeyPrefix ?? "Bearer ";
    outbound = HttpClientRequest.setHeader(
      outbound,
      headerName,
      `${headerPrefix}${storedSecret.apiKey}`,
    );
  }
  if (bodyBytes !== undefined && bodyBytes.byteLength > 0) {
    const contentType = request.headers["content-type"] ?? "application/json";
    outbound = HttpClientRequest.bodyUint8Array(outbound, bodyBytes, contentType);
  }

  const upstreamResult = yield* Effect.result(
    httpClient.execute(outbound).pipe(Effect.timeout("120 seconds")),
  );
  const nowIso = DateTime.formatIso(yield* DateTime.now);
  const usageId = yield* random.uuidV4();

  if (upstreamResult._tag === "Failure") {
    yield* assetsRepo
      .recordProviderUsage({
        id: usageId,
        teamId: auth.team.id,
        providerInstanceId,
        memberId: auth.member.id,
        strategy: "proxy",
        requestPath: subpath || "/",
        statusCode: 502,
        createdAt: nowIso,
      })
      .pipe(Effect.ignore);
    return jsonErrorResponse(502, "internal", "Upstream team model provider could not be reached.");
  }

  const upstream = upstreamResult.success;
  yield* assetsRepo
    .recordProviderUsage({
      id: usageId,
      teamId: auth.team.id,
      providerInstanceId,
      memberId: auth.member.id,
      strategy: "proxy",
      requestPath: subpath || "/",
      statusCode: upstream.status,
      createdAt: nowIso,
    })
    .pipe(Effect.ignore);

  const responseHeaders: Record<string, string> = { ...NO_STORE_HEADERS };
  const upstreamContentType = upstream.headers["content-type"];
  if (typeof upstreamContentType === "string") {
    responseHeaders["content-type"] = upstreamContentType;
  }
  return HttpServerResponse.stream(upstream.stream, {
    status: upstream.status,
    headers: responseHeaders,
  });
});

const handleProviderLease = Effect.fn("TeamProviderProxyHttp.lease")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const urlOpt = requestUrl(request);
  if (Option.isNone(urlOpt)) {
    return jsonErrorResponse(400, "invalid_input", "Malformed request URL.");
  }

  const auth = yield* authenticateTeamMemberHttpRequest(request);
  if (!auth.ok) {
    return jsonErrorResponse(auth.status, auth.code, auth.message);
  }

  const rawInstanceId = decodeURIComponent(
    urlOpt.value.pathname.slice(TEAM_PROVIDER_LEASE_PREFIX.length).replace(/\/+$/, ""),
  );
  if (!rawInstanceId || rawInstanceId.includes("/")) {
    return jsonErrorResponse(400, "invalid_input", "Invalid providerInstanceId in lease path.");
  }

  const assetsRepo = yield* TeamAssetsRepository.TeamAssetsRepository;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const httpClient = yield* HttpClient.HttpClient;
  const random = yield* SecureRandom.SecureRandom;

  const providerInstanceId = ProviderInstanceId.make(rawInstanceId);
  const providerOpt = yield* assetsRepo
    .getProviderByInstanceId(auth.team.id, providerInstanceId)
    .pipe(Effect.orElseSucceed(() => Option.none()));
  if (Option.isNone(providerOpt) || !providerOpt.value.enabled) {
    return jsonErrorResponse(
      404,
      "not_found",
      `Team provider "${rawInstanceId}" is not available.`,
    );
  }
  const provider = providerOpt.value;
  if (provider.deliveryStrategy !== "token-lease" || !provider.secretKey) {
    return jsonErrorResponse(
      400,
      "invalid_input",
      `Team provider "${rawInstanceId}" is not configured for OAuth token leasing.`,
    );
  }

  const rawBody = yield* request.text.pipe(Effect.orElseSucceed(() => ""));
  const parsedBody = rawBody.trim().length > 0 ? decodeLeaseBody(rawBody) : Option.none();
  const forceRefresh = Option.isSome(parsedBody) && parsedBody.value.forceRefresh === true;

  const leaseResult = yield* Effect.result(
    issueEphemeralTeamProviderLease({
      secrets,
      httpClient,
      secretKey: provider.secretKey,
      providerInstanceId,
      driver: provider.driver,
      forceRefresh,
    }),
  );

  const nowIso = DateTime.formatIso(yield* DateTime.now);
  const usageId = yield* random.uuidV4();
  if (leaseResult._tag === "Failure") {
    const status = leaseResult.failure.code === "not_found" ? 404 : 502;
    yield* assetsRepo
      .recordProviderUsage({
        id: usageId,
        teamId: auth.team.id,
        providerInstanceId,
        memberId: auth.member.id,
        strategy: "token-lease",
        requestPath: "/lease",
        statusCode: status,
        createdAt: nowIso,
      })
      .pipe(Effect.ignore);
    return jsonErrorResponse(status, leaseResult.failure.code, leaseResult.failure.message);
  }

  yield* assetsRepo
    .recordProviderUsage({
      id: usageId,
      teamId: auth.team.id,
      providerInstanceId,
      memberId: auth.member.id,
      strategy: "token-lease",
      requestPath: "/lease",
      statusCode: 200,
      createdAt: nowIso,
    })
    .pipe(Effect.ignore);

  return HttpServerResponse.text(encodeJsonUnknown(leaseResult.success), {
    status: 200,
    contentType: "application/json",
    headers: NO_STORE_HEADERS,
  });
});

const handleAssetsDelta = Effect.fn("TeamProviderProxyHttp.assetsDelta")(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const urlOpt = requestUrl(request);
  if (Option.isNone(urlOpt)) {
    return jsonErrorResponse(400, "invalid_input", "Malformed request URL.");
  }

  const auth = yield* authenticateTeamMemberHttpRequest(request);
  if (!auth.ok) {
    return jsonErrorResponse(auth.status, auth.code, auth.message);
  }

  const assetsRepo = yield* TeamAssetsRepository.TeamAssetsRepository;
  const rawSince = urlOpt.value.searchParams.get("since");
  const parsedSince = rawSince !== null ? Number.parseInt(rawSince, 10) : 0;
  const sinceRevision = Number.isFinite(parsedSince) && parsedSince > 0 ? parsedSince : 0;
  const fullSync = sinceRevision === 0;

  const [revision, skills, preprompts, tombstones] = yield* Effect.all([
    assetsRepo.getAssetsRevision(auth.team.id).pipe(Effect.orElseSucceed(() => 0)),
    assetsRepo
      .listSkills(auth.team.id, fullSync ? undefined : { sinceRevision })
      .pipe(Effect.orElseSucceed(() => [])),
    assetsRepo
      .listPreprompts(auth.team.id, fullSync ? undefined : { sinceRevision })
      .pipe(Effect.orElseSucceed(() => [])),
    fullSync
      ? Effect.succeed({ deletedSkillIds: [], deletedPrepromptIds: [] })
      : assetsRepo
          .listAssetTombstonesSince(auth.team.id, sinceRevision)
          .pipe(Effect.orElseSucceed(() => ({ deletedSkillIds: [], deletedPrepromptIds: [] }))),
  ]);

  const payload: TeamAssetsDeltaResponse = {
    teamId: auth.team.id,
    revision: NonNegativeInt.make(revision),
    fullSync,
    skills,
    preprompts,
    deletedSkillIds: tombstones.deletedSkillIds,
    deletedPrepromptIds: tombstones.deletedPrepromptIds,
  };
  return HttpServerResponse.text(encodeJsonUnknown(payload), {
    status: 200,
    contentType: "application/json",
    headers: NO_STORE_HEADERS,
  });
});

export const layer = Layer.mergeAll(
  HttpRouter.add("*", `${TEAM_PROVIDER_PROXY_PREFIX}*`, handleProviderProxy()),
  HttpRouter.add("POST", `${TEAM_PROVIDER_LEASE_PREFIX}*`, handleProviderLease()),
  HttpRouter.add("GET", TEAM_ASSETS_ROUTE_PATH, handleAssetsDelta()),
);
