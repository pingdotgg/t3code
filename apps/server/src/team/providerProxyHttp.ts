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
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import { requestUrl } from "../requestUrl.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TeamAssetsRepository from "./TeamAssetsRepository.ts";
import {
  issueEphemeralTeamProviderLease,
  readLinkedServerInstanceIdFromConfig,
  readTeamProviderSecret,
  resolveLinkedServerProviderProfileDir,
  teamProviderSecretKey,
} from "./TeamProviderLeaseService.ts";
import * as TeamProviderManager from "./TeamProviderManager.ts";
import * as TeamRepository from "./TeamRepository.ts";

const TEAM_PROVIDER_PROXY_PREFIX = "/api/team/provider-proxy/";
const TEAM_PROVIDER_LEASE_PREFIX = "/api/team/provider-lease/";
const TEAM_ASSETS_ROUTE_PATH = "/api/team/assets";

const NO_STORE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const HOP_BY_HOP_AND_AUTH_HEADERS = new Set([
  "accept-encoding",
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

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

function resolveSafeUpstreamUrl(
  upstreamBaseUrl: string,
  subpath: string,
  search: string,
): string | null {
  let base: URL;
  try {
    base = new URL(upstreamBaseUrl);
  } catch {
    return null;
  }
  if (base.protocol !== "http:" && base.protocol !== "https:") {
    return null;
  }
  if (subpath.includes("\\") || subpath.includes("\0")) {
    return null;
  }
  const segments = subpath.split("/");
  for (const segment of segments) {
    if (segment.length === 0) continue;
    const decoded = safeDecodeURIComponent(segment);
    if (
      decoded === null ||
      decoded === "." ||
      decoded === ".." ||
      decoded.includes("/") ||
      decoded.includes("\\") ||
      decoded.includes("\0")
    ) {
      return null;
    }
  }
  const normalizedBase = upstreamBaseUrl.replace(/\/+$/, "");
  let resolved: URL;
  try {
    resolved = new URL(`${normalizedBase}${subpath}${search}`);
  } catch {
    return null;
  }
  if (resolved.origin !== base.origin) {
    return null;
  }
  const basePath = base.pathname.replace(/\/+$/, "");
  if (
    basePath.length > 0 &&
    resolved.pathname !== basePath &&
    !resolved.pathname.startsWith(`${basePath}/`)
  ) {
    return null;
  }
  return resolved.toString();
}

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

function normalizeSocketIp(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return null;
  const withoutBrackets =
    trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
  const withoutZone = withoutBrackets.split("%")[0] ?? withoutBrackets;
  return withoutZone.startsWith("::ffff:") ? withoutZone.slice("::ffff:".length) : withoutZone;
}

function isLoopbackIp(ip: string): boolean {
  return ip === "127.0.0.1" || ip === "::1" || ip === "localhost" || ip.startsWith("127.");
}

/** Fails closed for missing peer sockets or forwarded headers; allows loopback or same-host binds. */
export function isLocalInternalProxyRequest(request: HttpServerRequest.HttpServerRequest): boolean {
  if (
    request.headers["x-forwarded-for"] !== undefined ||
    request.headers.forwarded !== undefined ||
    request.headers["x-real-ip"] !== undefined
  ) {
    return false;
  }
  const source = request.source as
    | {
        readonly remoteAddress?: string | null;
        readonly localAddress?: string | null;
        readonly socket?: {
          readonly remoteAddress?: string | null;
          readonly localAddress?: string | null;
        };
      }
    | undefined;
  const remote = normalizeSocketIp(
    source?.socket?.remoteAddress ??
      source?.remoteAddress ??
      Option.getOrUndefined(request.remoteAddress),
  );
  if (remote === null) {
    return false;
  }
  if (isLoopbackIp(remote)) {
    return true;
  }
  const local = normalizeSocketIp(source?.socket?.localAddress ?? source?.localAddress);
  return local !== null && remote === local;
}

const authenticateTeamMemberHttpRequest = Effect.fn("TeamProviderProxyHttp.authenticateTeamMember")(
  function* (
    request: HttpServerRequest.HttpServerRequest,
    options?: {
      readonly allowInternalProxyToken?: boolean;
      readonly providerInstanceId?: ProviderInstanceId;
    },
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
    const authSessionsOpt = yield* Effect.serviceOption(AuthSessions.AuthSessionRepository);
    const teamProviderManagerOpt = yield* Effect.serviceOption(
      TeamProviderManager.TeamProviderManager,
    );

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
      if (
        options?.allowInternalProxyToken === true &&
        options.providerInstanceId !== undefined &&
        Option.isSome(teamProviderManagerOpt)
      ) {
        const localOriginAllowed = isLocalInternalProxyRequest(request);
        const internalMatch = yield* teamProviderManagerOpt.value
          .verifyInternalProxyToken(presentedToken, options.providerInstanceId)
          .pipe(Effect.orElseSucceed(() => null));
        if (internalMatch !== null) {
          if (!localOriginAllowed || internalMatch.teamId !== team.id) {
            return {
              ok: false,
              status: 403,
              code: "team_access_revoked",
              message: "Internal team proxy credentials are only valid from local loopback.",
            };
          }
          if (internalMatch.memberId !== null) {
            const memberOpt = yield* teamRepo
              .getMemberById(internalMatch.memberId)
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
          if (internalMatch.isAutomation) {
            const members = yield* teamRepo
              .listMembers(team.id)
              .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<TeamMember>));
            const fallbackOwner =
              members.find((m) => m.status === "active" && m.role === "owner") ??
              members.find((m) => m.status === "active");
            if (fallbackOwner !== undefined) {
              return { ok: true, team, member: fallbackOwner };
            }
          }
          return {
            ok: false,
            status: 403,
            code: "team_access_revoked",
            message: "Internal team proxy credential has no active member binding.",
          };
        }
      }

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

  const remainder = urlOpt.value.pathname.slice(TEAM_PROVIDER_PROXY_PREFIX.length);
  const slashIndex = remainder.indexOf("/");
  const rawInstanceId = safeDecodeURIComponent(
    slashIndex === -1 ? remainder : remainder.slice(0, slashIndex),
  );
  const subpath = slashIndex === -1 ? "" : remainder.slice(slashIndex);

  const auth = yield* authenticateTeamMemberHttpRequest(request, {
    allowInternalProxyToken: true,
    ...(rawInstanceId ? { providerInstanceId: ProviderInstanceId.make(rawInstanceId) } : {}),
  });
  if (!auth.ok) {
    return jsonErrorResponse(auth.status, auth.code, auth.message);
  }

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

  const targetUrl = resolveSafeUpstreamUrl(provider.upstreamBaseUrl, subpath, urlOpt.value.search);
  if (targetUrl === null) {
    return jsonErrorResponse(400, "invalid_input", "Invalid proxy subpath for upstream provider.");
  }

  const storedSecret = provider.secretKey
    ? yield* readTeamProviderSecret(secrets, provider.secretKey).pipe(
        Effect.orElseSucceed(() => null),
      )
    : null;

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && method !== "OPTIONS";
  const bodyBytes = hasBody
    ? yield* request.arrayBuffer.pipe(
        Effect.map((buf) => new Uint8Array(buf)),
        Effect.orElseSucceed(() => new Uint8Array()),
      )
    : undefined;

  const injectedHeaderLower = (provider.apiKeyHeader ?? "authorization").trim().toLowerCase();
  let outbound = HttpClientRequest.make(
    method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS" | "HEAD",
  )(targetUrl);
  for (const [key, value] of Object.entries(request.headers)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (HOP_BY_HOP_AND_AUTH_HEADERS.has(lower) || lower === injectedHeaderLower) continue;
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
    httpClient
      .execute(outbound)
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeout("120 seconds"),
      ),
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

  const rawInstanceId = safeDecodeURIComponent(
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
  const linkedServerInstanceId = readLinkedServerInstanceIdFromConfig(provider.config);
  const serverConfigOpt = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const serverSettingsOpt = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const resolvedServerSettings = Option.isSome(serverSettingsOpt)
    ? yield* serverSettingsOpt.value.getSettings.pipe(Effect.orElseSucceed(() => null))
    : null;
  const fallbackProfileDir =
    linkedServerInstanceId !== null && Option.isSome(serverConfigOpt)
      ? resolveLinkedServerProviderProfileDir({
          stateDir: serverConfigOpt.value.stateDir,
          driver: provider.driver,
          linkedServerInstanceId,
          ...(Option.isSome(serverSettingsOpt) ? { serverSettings: resolvedServerSettings } : {}),
        })
      : null;
  if (
    provider.deliveryStrategy !== "token-lease" ||
    (!provider.secretKey && fallbackProfileDir === null)
  ) {
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
      secretKey: provider.secretKey ?? teamProviderSecretKey(auth.team.id, providerInstanceId),
      providerInstanceId,
      driver: provider.driver,
      forceRefresh,
      ...(fallbackProfileDir !== null ? { fallbackProfileDir } : {}),
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
