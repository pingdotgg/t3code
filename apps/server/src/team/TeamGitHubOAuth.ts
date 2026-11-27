// @effect-diagnostics nodeBuiltinImport:off -- Server-side PKCE S256 hashing and random state generation.
import * as NodeCrypto from "node:crypto";

import {
  IsoDateTime,
  PositiveInt,
  TeamOperationError,
  type AuthSessionId,
  type TeamGitHubAuthMethod,
  type TeamGitHubIdentity,
  type TeamGitHubOAuthMode,
  type TeamId,
  type TeamMemberId,
  type TeamPollGitHubDeviceFlowResult,
  type TeamStartGitHubDeviceFlowResult,
  type TeamStartGitHubOAuthResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as TeamGitHubRepository from "./TeamGitHubRepository.ts";

export const TEAM_GITHUB_OAUTH_CALLBACK_PATH = "/api/team/github/oauth/callback";

const GITHUB_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const OAUTH_CONFIRMATION_TTL_MS = 2 * 60 * 1000;
const MAX_PENDING_OAUTH_STATES = 1_000;
const MAX_PENDING_OAUTH_CONFIRMATIONS = 500;
const MAX_PENDING_DEVICE_FLOWS = 500;
const MAX_PENDING_FLOWS_PER_MEMBER = 10;
const DEFAULT_DEVICE_POLL_INTERVAL_SECONDS = 5;
const MIN_DEVICE_POLL_INTERVAL_SECONDS = 1;
const MAX_DEVICE_POLL_INTERVAL_SECONDS = 60;
const MAX_DEVICE_FLOW_TTL_SECONDS = 30 * 60;
const CONFIRMATION_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generateConfirmationCode(): string {
  const bytes = NodeCrypto.randomBytes(8);
  let raw = "";
  for (const byte of bytes) {
    raw += CONFIRMATION_CODE_ALPHABET[byte % CONFIRMATION_CODE_ALPHABET.length]!;
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

function normalizeConfirmationCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function validateDeviceVerificationUri(raw: string, expectedWebBaseUrl: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  let parsed: URL;
  let expected: URL;
  try {
    parsed = new URL(trimmed);
    expected = new URL(expectedWebBaseUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.username.length > 0 || parsed.password.length > 0) return null;
  if (parsed.origin.toLowerCase() !== expected.origin.toLowerCase()) return null;
  return parsed.toString();
}

function generatePkceCodeVerifier(): string {
  return NodeCrypto.randomBytes(32).toString("base64url");
}

function computePkceCodeChallengeS256(codeVerifier: string): string {
  return NodeCrypto.createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}

const normalizeGitHubOAuthCallbackUrl = Effect.fn("TeamGitHubOAuth.normalizeCallbackUrl")(
  function* (redirectBaseUrl: string): Effect.fn.Return<string, TeamOperationError> {
    const trimmed = redirectBaseUrl.trim();
    if (trimmed.length === 0) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Team server callback base URL cannot be empty.",
      });
    }
    const parsed = yield* Effect.try({
      try: () => new URL(trimmed),
      catch: () =>
        new TeamOperationError({
          code: "invalid_input",
          message: "Team server callback base URL must be a valid http(s) URL.",
        }),
    });
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Team server callback base URL must use http:// or https://.",
      });
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Team server callback base URL must not contain embedded credentials.",
      });
    }
    if (parsed.search.length > 0 || parsed.hash.length > 0) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: "Team server callback base URL must not contain query parameters or fragments.",
      });
    }
    const basePath = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.origin}${basePath}${TEAM_GITHUB_OAUTH_CALLBACK_PATH}`;
  },
);

const GitHubTokenExchangeResponseSchema = Schema.Struct({
  access_token: Schema.optionalKey(Schema.String),
  token_type: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.String),
  refresh_token: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Finite),
  refresh_token_expires_in: Schema.optionalKey(Schema.Finite),
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Schema.Finite),
});
const decodeGitHubTokenResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(GitHubTokenExchangeResponseSchema),
);

const GitHubDeviceCodeResponseSchema = Schema.Struct({
  device_code: Schema.optionalKey(Schema.String),
  user_code: Schema.optionalKey(Schema.String),
  verification_uri: Schema.optionalKey(Schema.String),
  verification_uri_complete: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Finite),
  interval: Schema.optionalKey(Schema.Finite),
  error: Schema.optionalKey(Schema.String),
  error_description: Schema.optionalKey(Schema.String),
});
const decodeGitHubDeviceCodeResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(GitHubDeviceCodeResponseSchema),
);

export interface ExchangedGitHubTokenSet {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresAt: IsoDateTime | null;
  readonly refreshTokenExpiresAt: IsoDateTime | null;
}

export interface PendingBrowserOAuthState {
  readonly state: string;
  readonly teamId: TeamId;
  readonly memberId: TeamMemberId;
  readonly sessionId: AuthSessionId;
  readonly mode: TeamGitHubOAuthMode;
  readonly clientId: string;
  readonly webBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly redirectUri: string;
  readonly codeVerifier: string;
  readonly githubNameOverride: string | null;
  readonly githubEmailOverride: string | null;
  readonly memberGeneration: number;
  readonly teamGeneration: number;
  readonly createdAtMs: number;
  readonly expiresAtMs: number;
}

export interface PendingBrowserOAuthConfirmation {
  readonly state: string;
  readonly confirmationCodeNormalized: string;
  readonly authorizationCode: string;
  readonly pending: PendingBrowserOAuthState;
  readonly expiresAtMs: number;
}

export interface PendingDeviceFlow {
  readonly deviceFlowId: string;
  readonly teamId: TeamId;
  readonly memberId: TeamMemberId;
  readonly sessionId: AuthSessionId;
  readonly mode: TeamGitHubOAuthMode;
  readonly clientId: string;
  readonly webBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly deviceCode: string;
  readonly userCode: string;
  readonly verificationUri: string;
  readonly verificationUriComplete: string | null;
  readonly githubNameOverride: string | null;
  readonly githubEmailOverride: string | null;
  readonly memberGeneration: number;
  readonly teamGeneration: number;
  cancelled: boolean;
  completing: boolean;
  intervalSeconds: number;
  nextPollAllowedAtMs: number;
  readonly expiresAtMs: number;
  readonly lock: Semaphore.Semaphore;
}

export interface GitHubOAuthFlowStore {
  readonly browserStates: Map<string, PendingBrowserOAuthState>;
  readonly browserConfirmations: Map<string, PendingBrowserOAuthConfirmation>;
  readonly deviceFlows: Map<string, PendingDeviceFlow>;
  readonly memberGenerations: Map<TeamMemberId, number>;
  readonly teamGenerations: Map<TeamId, number>;
}

export function createGitHubOAuthFlowStore(): GitHubOAuthFlowStore {
  return {
    browserStates: new Map(),
    browserConfirmations: new Map(),
    deviceFlows: new Map(),
    memberGenerations: new Map(),
    teamGenerations: new Map(),
  };
}

export function getMemberOAuthGeneration(
  store: GitHubOAuthFlowStore,
  memberId: TeamMemberId,
): number {
  return store.memberGenerations.get(memberId) ?? 0;
}

export function getTeamOAuthGeneration(store: GitHubOAuthFlowStore, teamId: TeamId): number {
  return store.teamGenerations.get(teamId) ?? 0;
}

function pruneExpiredMap<T extends { readonly expiresAtMs: number }>(
  map: Map<string, T>,
  nowMs: number,
  maxEntries: number,
  onEvict?: (entry: T) => void,
): void {
  for (const [key, entry] of map) {
    if (entry.expiresAtMs <= nowMs) {
      onEvict?.(entry);
      map.delete(key);
    }
  }
  while (map.size >= maxEntries) {
    const oldest = map.entries().next().value;
    if (oldest === undefined) break;
    const [oldestKey, oldestEntry] = oldest;
    onEvict?.(oldestEntry);
    map.delete(oldestKey);
  }
}

function enforcePerMemberCap<T>(
  map: Map<string, T>,
  memberId: TeamMemberId,
  maxPerMember: number,
  getMemberId: (entry: T) => TeamMemberId,
  onEvict?: (entry: T) => void,
): void {
  const memberEntries: Array<readonly [string, T]> = [];
  for (const [key, entry] of map) {
    if (getMemberId(entry) === memberId) {
      memberEntries.push([key, entry]);
    }
  }
  while (memberEntries.length >= maxPerMember) {
    const oldest = memberEntries.shift();
    if (oldest !== undefined) {
      const [oldestKey, oldestEntry] = oldest;
      onEvict?.(oldestEntry);
      map.delete(oldestKey);
    }
  }
}

export function purgeMemberPendingGitHubOAuthFlows(
  store: GitHubOAuthFlowStore,
  memberId: TeamMemberId,
): void {
  store.memberGenerations.set(memberId, getMemberOAuthGeneration(store, memberId) + 1);
  for (const [state, entry] of store.browserStates) {
    if (entry.memberId === memberId) {
      store.browserStates.delete(state);
    }
  }
  for (const [state, entry] of store.browserConfirmations) {
    if (entry.pending.memberId === memberId) {
      store.browserConfirmations.delete(state);
    }
  }
  for (const [flowId, entry] of store.deviceFlows) {
    if (entry.memberId === memberId) {
      entry.cancelled = true;
      store.deviceFlows.delete(flowId);
    }
  }
}

export function purgeTeamPendingGitHubOAuthFlows(
  store: GitHubOAuthFlowStore,
  teamId: TeamId,
): void {
  store.teamGenerations.set(teamId, getTeamOAuthGeneration(store, teamId) + 1);
  for (const [state, entry] of store.browserStates) {
    if (entry.teamId === teamId) {
      store.browserStates.delete(state);
    }
  }
  for (const [state, entry] of store.browserConfirmations) {
    if (entry.pending.teamId === teamId) {
      store.browserConfirmations.delete(state);
    }
  }
  for (const [flowId, entry] of store.deviceFlows) {
    if (entry.teamId === teamId) {
      entry.cancelled = true;
      store.deviceFlows.delete(flowId);
    }
  }
}

export const startBrowserOAuthFlow = Effect.fn("TeamGitHubOAuth.startBrowserFlow")(
  function* (input: {
    readonly store: GitHubOAuthFlowStore;
    readonly teamId: TeamId;
    readonly memberId: TeamMemberId;
    readonly sessionId: AuthSessionId;
    readonly config: TeamGitHubRepository.StoredGitHubAppConfigRecord;
    readonly redirectBaseUrl: string;
    readonly githubNameOverride: string | null;
    readonly githubEmailOverride: string | null;
  }): Effect.fn.Return<TeamStartGitHubOAuthResult, TeamOperationError> {
    const callbackUrl = yield* normalizeGitHubOAuthCallbackUrl(input.redirectBaseUrl);
    const nowMs = yield* Clock.currentTimeMillis;
    pruneExpiredMap(input.store.browserStates, nowMs, MAX_PENDING_OAUTH_STATES);
    enforcePerMemberCap(
      input.store.browserStates,
      input.memberId,
      MAX_PENDING_FLOWS_PER_MEMBER,
      (entry) => entry.memberId,
    );

    const state = NodeCrypto.randomBytes(32).toString("base64url");
    const codeVerifier = generatePkceCodeVerifier();
    const codeChallenge = computePkceCodeChallengeS256(codeVerifier);
    const expiresAtMs = nowMs + OAUTH_STATE_TTL_MS;
    const expiresAt = IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(expiresAtMs)));

    const authorizeUrl = new URL(`${input.config.webBaseUrl}/login/oauth/authorize`);
    authorizeUrl.searchParams.set("client_id", input.config.clientId);
    authorizeUrl.searchParams.set("redirect_uri", callbackUrl);
    authorizeUrl.searchParams.set("state", state);
    authorizeUrl.searchParams.set("code_challenge", codeChallenge);
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    if (input.config.mode === "oauth") {
      const trimmedScopes = input.config.scopes.trim();
      if (trimmedScopes.length > 0) {
        authorizeUrl.searchParams.set("scope", trimmedScopes);
      }
    }

    input.store.browserStates.set(state, {
      state,
      teamId: input.teamId,
      memberId: input.memberId,
      sessionId: input.sessionId,
      mode: input.config.mode,
      clientId: input.config.clientId,
      webBaseUrl: input.config.webBaseUrl,
      apiBaseUrl: input.config.apiBaseUrl,
      redirectUri: callbackUrl,
      codeVerifier,
      githubNameOverride: input.githubNameOverride,
      githubEmailOverride: input.githubEmailOverride,
      memberGeneration: getMemberOAuthGeneration(input.store, input.memberId),
      teamGeneration: getTeamOAuthGeneration(input.store, input.teamId),
      createdAtMs: nowMs,
      expiresAtMs,
    });

    return {
      authorizeUrl: authorizeUrl.toString(),
      state,
      expiresAt,
      callbackUrl,
    };
  },
);

export const createPendingBrowserOAuthConfirmation = Effect.fn(
  "TeamGitHubOAuth.createPendingConfirmation",
)(function* (input: {
  readonly store: GitHubOAuthFlowStore;
  readonly pending: PendingBrowserOAuthState;
  readonly authorizationCode: string;
}): Effect.fn.Return<{ readonly confirmationCode: string }> {
  const nowMs = yield* Clock.currentTimeMillis;
  pruneExpiredMap(input.store.browserConfirmations, nowMs, MAX_PENDING_OAUTH_CONFIRMATIONS);
  enforcePerMemberCap(
    input.store.browserConfirmations,
    input.pending.memberId,
    MAX_PENDING_FLOWS_PER_MEMBER,
    (entry) => entry.pending.memberId,
  );
  const confirmationCode = generateConfirmationCode();
  input.store.browserConfirmations.set(input.pending.state, {
    state: input.pending.state,
    confirmationCodeNormalized: normalizeConfirmationCode(confirmationCode),
    authorizationCode: input.authorizationCode,
    pending: input.pending,
    expiresAtMs: nowMs + OAUTH_CONFIRMATION_TTL_MS,
  });
  return { confirmationCode };
});

export const consumePendingBrowserOAuthConfirmation = Effect.fn(
  "TeamGitHubOAuth.consumePendingConfirmation",
)(function* (input: {
  readonly store: GitHubOAuthFlowStore;
  readonly state: string;
  readonly confirmationCode: string;
  readonly teamId: TeamId;
  readonly memberId: TeamMemberId;
  readonly sessionId: AuthSessionId;
}): Effect.fn.Return<PendingBrowserOAuthConfirmation, TeamOperationError> {
  const trimmedState = input.state.trim();
  const entry = input.store.browserConfirmations.get(trimmedState);
  if (entry === undefined) {
    return yield* new TeamOperationError({
      code: "github_oauth_state_invalid",
      message: "GitHub OAuth confirmation session is invalid, expired, or has already been used.",
    });
  }
  if (
    entry.pending.teamId !== input.teamId ||
    entry.pending.memberId !== input.memberId ||
    entry.pending.sessionId !== input.sessionId
  ) {
    return yield* new TeamOperationError({
      code: "forbidden",
      message: "This GitHub OAuth sign-in belongs to a different member session.",
    });
  }
  // Single-attempt consumption prevents online guessing of the confirmation code.
  input.store.browserConfirmations.delete(trimmedState);
  const nowMs = yield* Clock.currentTimeMillis;
  if (entry.expiresAtMs <= nowMs) {
    return yield* new TeamOperationError({
      code: "github_oauth_state_invalid",
      message: "GitHub OAuth confirmation code expired. Please start sign-in again.",
    });
  }
  const presented = Buffer.from(normalizeConfirmationCode(input.confirmationCode), "utf8");
  const expected = Buffer.from(entry.confirmationCodeNormalized, "utf8");
  if (
    presented.byteLength === 0 ||
    presented.byteLength !== expected.byteLength ||
    !NodeCrypto.timingSafeEqual(presented, expected)
  ) {
    return yield* new TeamOperationError({
      code: "github_oauth_state_invalid",
      message: "Invalid GitHub OAuth confirmation code. Please start sign-in again.",
    });
  }
  return entry;
});

/**
 * Atomically consumes a pending single-use browser OAuth state before any network call.
 * Rejects unknown, replayed, or expired states.
 */
export const consumePendingBrowserOAuthState = Effect.fn("TeamGitHubOAuth.consumePendingState")(
  function* (
    store: GitHubOAuthFlowStore,
    rawState: string | null | undefined,
  ): Effect.fn.Return<PendingBrowserOAuthState, TeamOperationError> {
    const state = rawState?.trim() ?? "";
    if (state.length === 0) {
      return yield* new TeamOperationError({
        code: "github_oauth_state_invalid",
        message: "Missing GitHub OAuth state parameter.",
      });
    }
    const pending = store.browserStates.get(state);
    if (pending === undefined) {
      return yield* new TeamOperationError({
        code: "github_oauth_state_invalid",
        message: "GitHub OAuth state is invalid, expired, or has already been used.",
      });
    }
    // Single-use: delete immediately before any validation or outbound exchange.
    store.browserStates.delete(state);
    const nowMs = yield* Clock.currentTimeMillis;
    if (pending.expiresAtMs <= nowMs) {
      return yield* new TeamOperationError({
        code: "github_oauth_state_invalid",
        message: "GitHub OAuth sign-in session expired. Please start again from Settings.",
      });
    }
    return pending;
  },
);

const postGitHubOAuthForm = Effect.fn("TeamGitHubOAuth.postOAuthForm")(function* (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly webBaseUrl: string;
  readonly path: string;
  readonly params: Record<string, string>;
  readonly allowedApiOrigins?: ReadonlyArray<string>;
  readonly resolveHostAddresses?: (hostname: string) => Promise<ReadonlyArray<string>>;
}): Effect.fn.Return<{ readonly status: number; readonly bodyText: string }, TeamOperationError> {
  yield* TeamGitHubRepository.assertGitHubHostAllowed({
    baseUrl: input.webBaseUrl,
    label: "GitHub web base URL",
    ...(input.allowedApiOrigins === undefined
      ? {}
      : { allowedApiOrigins: input.allowedApiOrigins }),
    ...(input.resolveHostAddresses === undefined
      ? {}
      : { resolveHostAddresses: input.resolveHostAddresses }),
  });
  const form = new URLSearchParams(input.params);
  const req = HttpClientRequest.post(`${input.webBaseUrl}${input.path}`).pipe(
    HttpClientRequest.setHeaders({
      accept: "application/json",
      "user-agent": "t3code-teams",
    }),
    HttpClientRequest.bodyText(form.toString(), "application/x-www-form-urlencoded"),
  );
  const res = yield* input.httpClient.execute(req).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.timeout("15 seconds"),
    Effect.mapError(
      () =>
        new TeamOperationError({
          code: "github_oauth_failed",
          message: `Could not reach GitHub OAuth endpoint at ${input.webBaseUrl}.`,
        }),
    ),
  );
  if (res.status >= 300 && res.status < 400) {
    return yield* new TeamOperationError({
      code: "github_oauth_failed",
      message: "GitHub OAuth endpoint redirected the token request; check the GitHub web base URL.",
    });
  }
  const bodyText = yield* res.text.pipe(
    Effect.mapError(
      () =>
        new TeamOperationError({
          code: "github_oauth_failed",
          message: "Could not read GitHub OAuth response body.",
        }),
    ),
  );
  return { status: res.status, bodyText };
});

function parseTokenSetFromJson(
  nowMs: number,
  parsed: typeof GitHubTokenExchangeResponseSchema.Type,
): ExchangedGitHubTokenSet | null {
  const accessToken = parsed.access_token?.trim() ?? "";
  if (accessToken.length === 0) return null;
  const refreshToken = parsed.refresh_token?.trim() || null;
  const expiresAt =
    parsed.expires_in !== undefined && parsed.expires_in > 0
      ? IsoDateTime.make(
          DateTime.formatIso(DateTime.makeUnsafe(nowMs + Math.floor(parsed.expires_in) * 1_000)),
        )
      : null;
  const refreshTokenExpiresAt =
    parsed.refresh_token_expires_in !== undefined && parsed.refresh_token_expires_in > 0
      ? IsoDateTime.make(
          DateTime.formatIso(
            DateTime.makeUnsafe(nowMs + Math.floor(parsed.refresh_token_expires_in) * 1_000),
          ),
        )
      : null;
  return { accessToken, refreshToken, expiresAt, refreshTokenExpiresAt };
}

export const exchangeGitHubAuthorizationCode = Effect.fn("TeamGitHubOAuth.exchangeAuthCode")(
  function* (input: {
    readonly httpClient: HttpClient.HttpClient;
    readonly webBaseUrl: string;
    readonly clientId: string;
    readonly clientSecret: string | null;
    readonly code: string;
    readonly redirectUri: string;
    readonly codeVerifier: string;
    readonly allowedApiOrigins?: ReadonlyArray<string>;
    readonly resolveHostAddresses?: (hostname: string) => Promise<ReadonlyArray<string>>;
  }): Effect.fn.Return<ExchangedGitHubTokenSet, TeamOperationError> {
    const params: Record<string, string> = {
      client_id: input.clientId,
      code: input.code,
      redirect_uri: input.redirectUri,
      code_verifier: input.codeVerifier,
    };
    if (input.clientSecret && input.clientSecret.trim().length > 0) {
      params.client_secret = input.clientSecret.trim();
    }
    const { status, bodyText } = yield* postGitHubOAuthForm({
      httpClient: input.httpClient,
      webBaseUrl: input.webBaseUrl,
      path: "/login/oauth/access_token",
      params,
      ...(input.allowedApiOrigins === undefined
        ? {}
        : { allowedApiOrigins: input.allowedApiOrigins }),
      ...(input.resolveHostAddresses === undefined
        ? {}
        : { resolveHostAddresses: input.resolveHostAddresses }),
    });
    const decodedOpt = decodeGitHubTokenResponse(bodyText);
    if (Option.isNone(decodedOpt)) {
      return yield* new TeamOperationError({
        code: "github_oauth_failed",
        message: `GitHub OAuth token exchange failed with HTTP ${status}.`,
      });
    }
    const parsed = decodedOpt.value;
    if (parsed.error) {
      return yield* new TeamOperationError({
        code: "github_oauth_failed",
        message:
          parsed.error_description?.trim() ||
          `GitHub OAuth token exchange failed (${parsed.error}).`,
      });
    }
    if (status < 200 || status >= 300) {
      return yield* new TeamOperationError({
        code: "github_oauth_failed",
        message: `GitHub OAuth token exchange failed with HTTP ${status}.`,
      });
    }
    const nowMs = yield* Clock.currentTimeMillis;
    const tokenSet = parseTokenSetFromJson(nowMs, parsed);
    if (tokenSet === null) {
      return yield* new TeamOperationError({
        code: "github_oauth_failed",
        message: "GitHub OAuth token exchange returned an empty access token.",
      });
    }
    return tokenSet;
  },
);

export const startDeviceAuthorizationFlow = Effect.fn("TeamGitHubOAuth.startDeviceFlow")(
  function* (input: {
    readonly store: GitHubOAuthFlowStore;
    readonly httpClient: HttpClient.HttpClient;
    readonly teamId: TeamId;
    readonly memberId: TeamMemberId;
    readonly sessionId: AuthSessionId;
    readonly config: TeamGitHubRepository.StoredGitHubAppConfigRecord;
    readonly githubNameOverride: string | null;
    readonly githubEmailOverride: string | null;
    readonly allowedApiOrigins?: ReadonlyArray<string>;
    readonly resolveHostAddresses?: (hostname: string) => Promise<ReadonlyArray<string>>;
  }): Effect.fn.Return<TeamStartGitHubDeviceFlowResult, TeamOperationError> {
    const params: Record<string, string> = {
      client_id: input.config.clientId,
    };
    if (input.config.mode === "oauth") {
      const trimmedScopes = input.config.scopes.trim();
      if (trimmedScopes.length > 0) {
        params.scope = trimmedScopes;
      }
    }
    const { status, bodyText } = yield* postGitHubOAuthForm({
      httpClient: input.httpClient,
      webBaseUrl: input.config.webBaseUrl,
      path: "/login/device/code",
      params,
      ...(input.allowedApiOrigins === undefined
        ? {}
        : { allowedApiOrigins: input.allowedApiOrigins }),
      ...(input.resolveHostAddresses === undefined
        ? {}
        : { resolveHostAddresses: input.resolveHostAddresses }),
    });
    const decodedOpt = decodeGitHubDeviceCodeResponse(bodyText);
    if (Option.isNone(decodedOpt)) {
      return yield* new TeamOperationError({
        code: "github_oauth_failed",
        message: `GitHub device authorization request failed with HTTP ${status}.`,
      });
    }
    const parsed = decodedOpt.value;
    if (parsed.error) {
      return yield* new TeamOperationError({
        code: "github_oauth_failed",
        message:
          parsed.error_description?.trim() ||
          `GitHub device authorization failed (${parsed.error}). Make sure Device Flow is enabled in your GitHub App / OAuth App settings.`,
      });
    }
    if (status < 200 || status >= 300) {
      return yield* new TeamOperationError({
        code: "github_oauth_failed",
        message: `GitHub device authorization failed with HTTP ${status}.`,
      });
    }
    const deviceCode = parsed.device_code?.trim() ?? "";
    const userCode = parsed.user_code?.trim() ?? "";
    const rawVerificationUri = parsed.verification_uri?.trim() ?? "";
    if (deviceCode.length === 0 || userCode.length === 0 || rawVerificationUri.length === 0) {
      return yield* new TeamOperationError({
        code: "github_oauth_failed",
        message: "GitHub device authorization returned an incomplete response.",
      });
    }
    const verificationUri = validateDeviceVerificationUri(
      rawVerificationUri,
      input.config.webBaseUrl,
    );
    if (verificationUri === null) {
      return yield* new TeamOperationError({
        code: "github_oauth_failed",
        message:
          "GitHub device authorization returned a verification URL outside the configured GitHub origin.",
      });
    }
    const rawVerificationUriComplete = parsed.verification_uri_complete?.trim() ?? "";
    let verificationUriComplete: string | null = null;
    if (rawVerificationUriComplete.length > 0) {
      verificationUriComplete = validateDeviceVerificationUri(
        rawVerificationUriComplete,
        input.config.webBaseUrl,
      );
      if (verificationUriComplete === null) {
        return yield* new TeamOperationError({
          code: "github_oauth_failed",
          message:
            "GitHub device authorization returned a complete verification URL outside the configured GitHub origin.",
        });
      }
    }

    const nowMs = yield* Clock.currentTimeMillis;
    const markEvictedCancelled = (entry: PendingDeviceFlow) => {
      entry.cancelled = true;
    };
    pruneExpiredMap(input.store.deviceFlows, nowMs, MAX_PENDING_DEVICE_FLOWS, markEvictedCancelled);
    enforcePerMemberCap(
      input.store.deviceFlows,
      input.memberId,
      MAX_PENDING_FLOWS_PER_MEMBER,
      (entry) => entry.memberId,
      markEvictedCancelled,
    );
    const expiresInSeconds = Math.max(
      30,
      Math.min(Math.floor(parsed.expires_in ?? 900), MAX_DEVICE_FLOW_TTL_SECONDS),
    );
    const intervalSeconds = Math.max(
      MIN_DEVICE_POLL_INTERVAL_SECONDS,
      Math.min(
        Math.floor(parsed.interval ?? DEFAULT_DEVICE_POLL_INTERVAL_SECONDS),
        MAX_DEVICE_POLL_INTERVAL_SECONDS,
      ),
    );
    const expiresAtMs = nowMs + expiresInSeconds * 1_000;
    const expiresAt = IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(expiresAtMs)));
    const deviceFlowId = `ghdev_${NodeCrypto.randomUUID()}`;

    input.store.deviceFlows.set(deviceFlowId, {
      deviceFlowId,
      teamId: input.teamId,
      memberId: input.memberId,
      sessionId: input.sessionId,
      mode: input.config.mode,
      clientId: input.config.clientId,
      webBaseUrl: input.config.webBaseUrl,
      apiBaseUrl: input.config.apiBaseUrl,
      deviceCode,
      userCode,
      verificationUri,
      verificationUriComplete,
      githubNameOverride: input.githubNameOverride,
      githubEmailOverride: input.githubEmailOverride,
      memberGeneration: getMemberOAuthGeneration(input.store, input.memberId),
      teamGeneration: getTeamOAuthGeneration(input.store, input.teamId),
      cancelled: false,
      completing: false,
      intervalSeconds,
      // Allow the first poll immediately after the user authorizes on GitHub.
      nextPollAllowedAtMs: nowMs,
      expiresAtMs,
      lock: Semaphore.makeUnsafe(1),
    });

    return {
      deviceFlowId,
      userCode,
      verificationUri,
      ...(verificationUriComplete !== null ? { verificationUriComplete } : {}),
      expiresAt,
      intervalSeconds: PositiveInt.make(intervalSeconds),
    };
  },
);

export type DeviceFlowPollOutcome =
  | { readonly kind: "result"; readonly result: TeamPollGitHubDeviceFlowResult }
  | {
      readonly kind: "authorized";
      readonly flow: PendingDeviceFlow;
      readonly tokenSet: ExchangedGitHubTokenSet;
    };

export const pollDeviceAuthorizationFlow = Effect.fn("TeamGitHubOAuth.pollDeviceFlow")(
  function* (input: {
    readonly store: GitHubOAuthFlowStore;
    readonly httpClient: HttpClient.HttpClient;
    readonly teamId: TeamId;
    readonly memberId: TeamMemberId;
    readonly sessionId: AuthSessionId;
    readonly deviceFlowId: string;
    readonly currentConfig: TeamGitHubRepository.StoredGitHubAppConfigRecord | null;
    readonly allowedApiOrigins?: ReadonlyArray<string>;
    readonly resolveHostAddresses?: (hostname: string) => Promise<ReadonlyArray<string>>;
  }): Effect.fn.Return<DeviceFlowPollOutcome, TeamOperationError> {
    const flow = input.store.deviceFlows.get(input.deviceFlowId);
    if (
      flow === undefined ||
      flow.teamId !== input.teamId ||
      flow.memberId !== input.memberId ||
      flow.sessionId !== input.sessionId
    ) {
      return yield* new TeamOperationError({
        code: "not_found",
        message: "GitHub device sign-in session was not found or has expired.",
      });
    }
    return yield* flow.lock.withPermits(1)(
      Effect.gen(function* () {
        if (
          flow.cancelled ||
          flow.completing ||
          !input.store.deviceFlows.has(input.deviceFlowId) ||
          getMemberOAuthGeneration(input.store, flow.memberId) !== flow.memberGeneration ||
          getTeamOAuthGeneration(input.store, flow.teamId) !== flow.teamGeneration
        ) {
          if (!flow.completing) {
            input.store.deviceFlows.delete(input.deviceFlowId);
          }
          return yield* new TeamOperationError({
            code: "not_found",
            message: "GitHub device sign-in session has been cancelled, completed, or expired.",
          });
        }
        const nowMs = yield* Clock.currentTimeMillis;
        if (flow.expiresAtMs <= nowMs) {
          input.store.deviceFlows.delete(input.deviceFlowId);
          return {
            kind: "result",
            result: {
              status: "expired",
              intervalSeconds: PositiveInt.make(flow.intervalSeconds),
              errorMessage: "Device authorization code expired. Please start again.",
            },
          } as const;
        }
        if (
          input.currentConfig === null ||
          !input.currentConfig.enabled ||
          input.currentConfig.clientId !== flow.clientId ||
          input.currentConfig.mode !== flow.mode ||
          input.currentConfig.webBaseUrl !== flow.webBaseUrl ||
          input.currentConfig.apiBaseUrl !== flow.apiBaseUrl
        ) {
          input.store.deviceFlows.delete(input.deviceFlowId);
          return {
            kind: "result",
            result: {
              status: "failed",
              intervalSeconds: PositiveInt.make(flow.intervalSeconds),
              errorMessage: "Team GitHub OAuth / GitHub App configuration was changed or disabled.",
            },
          } as const;
        }
        if (nowMs < flow.nextPollAllowedAtMs) {
          return {
            kind: "result",
            result: {
              status: "pending",
              intervalSeconds: PositiveInt.make(flow.intervalSeconds),
            },
          } as const;
        }

        const postResult = yield* Effect.result(
          postGitHubOAuthForm({
            httpClient: input.httpClient,
            webBaseUrl: flow.webBaseUrl,
            path: "/login/oauth/access_token",
            params: {
              client_id: flow.clientId,
              device_code: flow.deviceCode,
              grant_type: "urn:ietf:params:oauth:grant-type:device_code",
            },
            ...(input.allowedApiOrigins === undefined
              ? {}
              : { allowedApiOrigins: input.allowedApiOrigins }),
            ...(input.resolveHostAddresses === undefined
              ? {}
              : { resolveHostAddresses: input.resolveHostAddresses }),
          }),
        );

        // Re-check cancellation / member or team purge after outbound network I/O.
        if (
          flow.cancelled ||
          !input.store.deviceFlows.has(input.deviceFlowId) ||
          getMemberOAuthGeneration(input.store, flow.memberId) !== flow.memberGeneration ||
          getTeamOAuthGeneration(input.store, flow.teamId) !== flow.teamGeneration
        ) {
          input.store.deviceFlows.delete(input.deviceFlowId);
          return yield* new TeamOperationError({
            code: "not_found",
            message: "GitHub device sign-in session was cancelled before completion.",
          });
        }

        if (postResult._tag === "Failure") {
          // Transient transport/timeout error: keep flow alive and retry on the next poll interval.
          flow.nextPollAllowedAtMs = nowMs + flow.intervalSeconds * 1_000;
          return {
            kind: "result",
            result: {
              status: "pending",
              intervalSeconds: PositiveInt.make(flow.intervalSeconds),
            },
          } as const;
        }

        const { status, bodyText } = postResult.success;
        const decodedOpt = decodeGitHubTokenResponse(bodyText);
        if (Option.isNone(decodedOpt)) {
          if (status >= 500 || status === 429 || status === 408) {
            flow.nextPollAllowedAtMs = nowMs + flow.intervalSeconds * 1_000;
            return {
              kind: "result",
              result: {
                status: "pending",
                intervalSeconds: PositiveInt.make(flow.intervalSeconds),
              },
            } as const;
          }
          return yield* new TeamOperationError({
            code: "github_oauth_failed",
            message: `GitHub device token polling failed with HTTP ${status}.`,
          });
        }
        const parsed = decodedOpt.value;
        if (parsed.error) {
          switch (parsed.error) {
            case "authorization_pending":
            case "temporarily_unavailable":
            case "server_error": {
              flow.nextPollAllowedAtMs = nowMs + flow.intervalSeconds * 1_000;
              return {
                kind: "result",
                result: {
                  status: "pending",
                  intervalSeconds: PositiveInt.make(flow.intervalSeconds),
                },
              } as const;
            }
            case "slow_down": {
              const nextInterval = Math.max(
                MIN_DEVICE_POLL_INTERVAL_SECONDS,
                Math.min(
                  Math.max(
                    flow.intervalSeconds + 5,
                    parsed.interval !== undefined ? Math.floor(parsed.interval) : 0,
                  ),
                  MAX_DEVICE_POLL_INTERVAL_SECONDS,
                ),
              );
              flow.intervalSeconds = nextInterval;
              flow.nextPollAllowedAtMs = nowMs + nextInterval * 1_000;
              return {
                kind: "result",
                result: {
                  status: "pending",
                  intervalSeconds: PositiveInt.make(nextInterval),
                },
              } as const;
            }
            case "expired_token": {
              input.store.deviceFlows.delete(input.deviceFlowId);
              return {
                kind: "result",
                result: {
                  status: "expired",
                  intervalSeconds: PositiveInt.make(flow.intervalSeconds),
                  errorMessage:
                    parsed.error_description?.trim() ||
                    "Device authorization code expired. Please start again.",
                },
              } as const;
            }
            case "access_denied": {
              input.store.deviceFlows.delete(input.deviceFlowId);
              return {
                kind: "result",
                result: {
                  status: "denied",
                  intervalSeconds: PositiveInt.make(flow.intervalSeconds),
                  errorMessage:
                    parsed.error_description?.trim() || "GitHub authorization was denied.",
                },
              } as const;
            }
            default: {
              input.store.deviceFlows.delete(input.deviceFlowId);
              return {
                kind: "result",
                result: {
                  status: "failed",
                  intervalSeconds: PositiveInt.make(flow.intervalSeconds),
                  errorMessage:
                    parsed.error_description?.trim() ||
                    `GitHub device authorization failed (${parsed.error}).`,
                },
              } as const;
            }
          }
        }

        if (status >= 500 || status === 429 || status === 408) {
          flow.nextPollAllowedAtMs = nowMs + flow.intervalSeconds * 1_000;
          return {
            kind: "result",
            result: {
              status: "pending",
              intervalSeconds: PositiveInt.make(flow.intervalSeconds),
            },
          } as const;
        }
        if (status < 200 || status >= 300) {
          return yield* new TeamOperationError({
            code: "github_oauth_failed",
            message: `GitHub device token polling failed with HTTP ${status}.`,
          });
        }
        const tokenSet = parseTokenSetFromJson(nowMs, parsed);
        if (tokenSet === null) {
          input.store.deviceFlows.delete(input.deviceFlowId);
          return {
            kind: "result",
            result: {
              status: "failed",
              intervalSeconds: PositiveInt.make(flow.intervalSeconds),
              errorMessage: "GitHub returned an empty access token.",
            },
          } as const;
        }
        // Keep the flow in `store.deviceFlows` while `/user` verification runs so `cancelGitHubDeviceFlow`
        // can still cancel it; `completing = true` prevents a duplicate poll from re-exchanging `device_code`.
        flow.completing = true;
        return {
          kind: "authorized",
          flow,
          tokenSet,
        } as const;
      }),
    );
  },
);

// Per-(teamId, memberId) refresh locks serialize concurrent token refreshes so GitHub's single-use
// rotated refresh_token is never clobbered by parallel turns or broker requests.
const memberRefreshLocks = new Map<string, Semaphore.Semaphore>();
// Separate fast local commit lock serializes secret/DB/lease/publish critical sections across
// connect, disconnect, OAuth persist, and refresh commits without blocking on outbound network I/O.
const memberCredentialMutationLocks = new Map<string, Semaphore.Semaphore>();

function memberRefreshLockKey(teamId: TeamId, memberId: TeamMemberId): string {
  return `${teamId}::${memberId}`;
}

function getMemberGitHubRefreshLock(teamId: TeamId, memberId: TeamMemberId): Semaphore.Semaphore {
  const key = memberRefreshLockKey(teamId, memberId);
  let lock = memberRefreshLocks.get(key);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    memberRefreshLocks.set(key, lock);
  }
  return lock;
}

export function withMemberGitHubCredentialMutationLock<A, E, R>(
  teamId: TeamId,
  memberId: TeamMemberId,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> {
  const key = memberRefreshLockKey(teamId, memberId);
  let lock = memberCredentialMutationLocks.get(key);
  if (!lock) {
    lock = Semaphore.makeUnsafe(1);
    memberCredentialMutationLocks.set(key, lock);
  }
  return lock.withPermits(1)(effect);
}

export interface ResolvedFreshMemberGitHubCredential {
  readonly token: string;
  readonly authMethod: TeamGitHubAuthMethod;
  readonly githubLogin: string;
  readonly githubName: string | null;
  readonly githubEmail: string | null;
  readonly apiBaseUrl: string;
  readonly refreshed: boolean;
}

const PERMANENT_REFRESH_ERROR_CODES: ReadonlySet<string> = new Set([
  "bad_refresh_token",
  "invalid_grant",
  "incorrect_client_credentials",
  "access_denied",
  "expired_token",
  "invalid_client",
  "unauthorized_client",
]);

// Serializes token refresh per (teamId, memberId) so rotated refresh_tokens never race,
// keeps refresh_token/client_secret server-only, and fails closed with needsReconnect on revocation.
export const resolveFreshMemberGitHubCredential = Effect.fn(
  "TeamGitHubOAuth.resolveFreshMemberCredential",
)(function* (input: {
  readonly teamId: TeamId;
  readonly memberId: TeamMemberId;
  readonly githubRepo: TeamGitHubRepository.TeamGitHubRepository["Service"];
  readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
  readonly httpClient?: HttpClient.HttpClient;
  readonly expectedUpdatedAt?: string | null;
  readonly refreshMarginMs?: number;
  readonly allowedApiOrigins?: ReadonlyArray<string>;
  readonly resolveHostAddresses?: (hostname: string) => Promise<ReadonlyArray<string>>;
  readonly onIdentityUpdated?: (identity: TeamGitHubIdentity) => Effect.Effect<void>;
  readonly onRefreshRevoked?: (memberId: TeamMemberId) => Effect.Effect<void>;
}): Effect.fn.Return<ResolvedFreshMemberGitHubCredential | null> {
  const marginMs = input.refreshMarginMs ?? GITHUB_TOKEN_REFRESH_MARGIN_MS;

  const loadSnapshot = Effect.gen(function* () {
    const recordOpt = yield* input.githubRepo
      .getMemberCredential(input.memberId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(recordOpt) || recordOpt.value.teamId !== input.teamId) {
      return null;
    }
    const record = recordOpt.value;
    if (record.needsReconnect === true) {
      return null;
    }
    if (
      input.expectedUpdatedAt !== undefined &&
      input.expectedUpdatedAt !== null &&
      record.updatedAt !== input.expectedUpdatedAt
    ) {
      return null;
    }
    const secret = yield* TeamGitHubRepository.readTeamGitHubSecret(
      input.secrets,
      record.secretKey,
    ).pipe(Effect.orElseSucceed(() => null));
    if (secret === null) {
      return null;
    }
    return { record, secret };
  });

  const verifyRecordUnchanged = Effect.fn("TeamGitHubOAuth.verifyRecordUnchanged")(function* (
    record: TeamGitHubRepository.StoredMemberGitHubRecord,
  ): Effect.fn.Return<boolean> {
    const latestOpt = yield* input.githubRepo
      .getMemberCredential(input.memberId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(latestOpt)) return false;
    const latest = latestOpt.value;
    if (
      latest.teamId !== input.teamId ||
      latest.secretKey !== record.secretKey ||
      latest.updatedAt !== record.updatedAt ||
      latest.needsReconnect === true
    ) {
      return false;
    }
    if (
      input.expectedUpdatedAt !== undefined &&
      input.expectedUpdatedAt !== null &&
      latest.updatedAt !== input.expectedUpdatedAt
    ) {
      return false;
    }
    return true;
  });

  const markNeedsReconnect = Effect.fn("TeamGitHubOAuth.markNeedsReconnect")(function* (
    record: TeamGitHubRepository.StoredMemberGitHubRecord,
    reason: string,
  ) {
    // Serialize CAS update + secret removal + lease revocation + state publish with credential mutations
    // so a concurrent PAT/OAuth replacement cannot interleave and lose its leases or read model.
    yield* withMemberGitHubCredentialMutationLock(
      input.teamId,
      input.memberId,
      Effect.gen(function* () {
        const updatedOpt = yield* input.githubRepo
          .updateMemberCredentialRefreshState({
            memberId: input.memberId,
            expectedSecretKey: record.secretKey,
            tokenExpiresAt: null,
            hasRefreshToken: false,
            needsReconnect: true,
            reconnectReason: reason,
          })
          .pipe(Effect.orElseSucceed(() => Option.none()));
        if (Option.isNone(updatedOpt)) {
          return;
        }
        yield* TeamGitHubRepository.removeTeamGitHubSecret(input.secrets, record.secretKey).pipe(
          Effect.ignore,
        );
        if (input.onRefreshRevoked) {
          yield* input.onRefreshRevoked(input.memberId).pipe(Effect.ignore);
        }
        if (input.onIdentityUpdated) {
          yield* input
            .onIdentityUpdated(TeamGitHubRepository.stripMemberGitHubSecretKey(updatedOpt.value))
            .pipe(Effect.ignore);
        }
      }),
    );
  });

  // Fast path: PATs, non-expiring OAuth tokens, and fresh tokens bypass the refresh Semaphore.
  const initial = yield* loadSnapshot;
  if (initial === null) return null;
  const nowInitialMs = yield* Clock.currentTimeMillis;
  const initialExpiresMs = initial.secret.expiresAt ? Date.parse(initial.secret.expiresAt) : NaN;
  const needsRefreshInitial =
    initial.secret.authMethod !== "pat" &&
    (initial.secret.accessToken.trim().length === 0 ||
      (Number.isFinite(initialExpiresMs) && initialExpiresMs - nowInitialMs <= marginMs));
  if (!needsRefreshInitial) {
    if (initial.secret.accessToken.trim().length === 0) return null;
    return {
      token: initial.secret.accessToken,
      authMethod: initial.secret.authMethod,
      githubLogin: initial.record.githubLogin,
      githubName: initial.record.githubName,
      githubEmail: initial.record.githubEmail,
      apiBaseUrl: initial.record.apiBaseUrl,
      refreshed: false,
    };
  }

  // Serialized path: acquire per-(teamId, memberId) Semaphore and re-check before refreshing.
  const lock = getMemberGitHubRefreshLock(input.teamId, input.memberId);
  return yield* lock.withPermits(1)(
    Effect.gen(function* () {
      const current = yield* loadSnapshot;
      if (current === null) return null;
      const { record, secret } = current;
      const nowMs = yield* Clock.currentTimeMillis;
      const expiresAtMs = secret.expiresAt ? Date.parse(secret.expiresAt) : NaN;
      const stillValid =
        secret.accessToken.trim().length > 0 &&
        (!Number.isFinite(expiresAtMs) || expiresAtMs > nowMs + 5_000);

      // Another concurrent caller already refreshed while we waited on the Semaphore.
      if (
        secret.authMethod === "pat" ||
        (secret.accessToken.trim().length > 0 &&
          (!Number.isFinite(expiresAtMs) || expiresAtMs - nowMs > marginMs))
      ) {
        return {
          token: secret.accessToken,
          authMethod: secret.authMethod,
          githubLogin: record.githubLogin,
          githubName: record.githubName,
          githubEmail: record.githubEmail,
          apiBaseUrl: record.apiBaseUrl,
          refreshed: false,
        };
      }

      const refreshToken = secret.refreshToken?.trim() ?? "";
      if (refreshToken.length === 0) {
        if (stillValid) {
          return {
            token: secret.accessToken,
            authMethod: secret.authMethod,
            githubLogin: record.githubLogin,
            githubName: record.githubName,
            githubEmail: record.githubEmail,
            apiBaseUrl: record.apiBaseUrl,
            refreshed: false,
          };
        }
        yield* markNeedsReconnect(
          record,
          "GitHub access token expired and no refresh token is available. Please sign in again.",
        );
        return null;
      }

      if (secret.refreshTokenExpiresAt) {
        const rtExpMs = Date.parse(secret.refreshTokenExpiresAt);
        if (Number.isFinite(rtExpMs) && rtExpMs <= nowMs) {
          yield* markNeedsReconnect(
            record,
            "GitHub refresh token expired. Please sign in with GitHub again.",
          );
          return null;
        }
      }

      const appConfigOpt = yield* input.githubRepo
        .getGitHubAppConfig(input.teamId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(appConfigOpt) || !appConfigOpt.value.enabled) {
        if (stillValid) {
          return {
            token: secret.accessToken,
            authMethod: secret.authMethod,
            githubLogin: record.githubLogin,
            githubName: record.githubName,
            githubEmail: record.githubEmail,
            apiBaseUrl: record.apiBaseUrl,
            refreshed: false,
          };
        }
        yield* markNeedsReconnect(
          record,
          "Team GitHub OAuth / GitHub App configuration is disabled or removed. Please reconnect GitHub.",
        );
        return null;
      }
      const appConfig = appConfigOpt.value;
      // Never send a stored refresh_token to a different host or OAuth/GitHub App client_id.
      const hostMatches =
        secret.webBaseUrl !== undefined && secret.webBaseUrl === appConfig.webBaseUrl;
      const clientMatches = secret.clientId !== undefined && secret.clientId === appConfig.clientId;
      if (!hostMatches || !clientMatches) {
        if (stillValid && (yield* verifyRecordUnchanged(record))) {
          return {
            token: secret.accessToken,
            authMethod: secret.authMethod,
            githubLogin: record.githubLogin,
            githubName: record.githubName,
            githubEmail: record.githubEmail,
            apiBaseUrl: record.apiBaseUrl,
            refreshed: false,
          };
        }
        yield* markNeedsReconnect(
          record,
          "Team GitHub OAuth / GitHub App configuration changed. Please sign in with GitHub again.",
        );
        return null;
      }

      const clientSecret = appConfig.clientSecretKey
        ? yield* TeamGitHubRepository.readTeamGitHubAppClientSecret(
            input.secrets,
            appConfig.clientSecretKey,
          ).pipe(Effect.orElseSucceed(() => null))
        : null;

      const httpClient =
        input.httpClient ??
        (yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer)));

      const refreshParams: Record<string, string> = {
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: appConfig.clientId,
      };
      if (clientSecret && clientSecret.trim().length > 0) {
        refreshParams.client_secret = clientSecret.trim();
      }

      const postResult = yield* Effect.result(
        postGitHubOAuthForm({
          httpClient,
          webBaseUrl: appConfig.webBaseUrl,
          path: "/login/oauth/access_token",
          params: refreshParams,
          ...(input.allowedApiOrigins === undefined
            ? {}
            : { allowedApiOrigins: input.allowedApiOrigins }),
          ...(input.resolveHostAddresses === undefined
            ? {}
            : { resolveHostAddresses: input.resolveHostAddresses }),
        }),
      );

      if (postResult._tag === "Failure") {
        // Network/timeout error: preserve still-valid access token if credential was not disconnected/rotated.
        if (stillValid && (yield* verifyRecordUnchanged(record))) {
          return {
            token: secret.accessToken,
            authMethod: secret.authMethod,
            githubLogin: record.githubLogin,
            githubName: record.githubName,
            githubEmail: record.githubEmail,
            apiBaseUrl: record.apiBaseUrl,
            refreshed: false,
          };
        }
        return null;
      }

      const { status, bodyText } = postResult.success;
      const decodedOpt = decodeGitHubTokenResponse(bodyText);
      const parsed = Option.isSome(decodedOpt) ? decodedOpt.value : null;

      const normalizedError = parsed?.error?.trim().toLowerCase() ?? "";
      const isPermanentAuthRejection =
        normalizedError.length > 0
          ? PERMANENT_REFRESH_ERROR_CODES.has(normalizedError)
          : status === 400 || status === 401;

      if (isPermanentAuthRejection) {
        const reason =
          parsed?.error_description?.trim() ||
          (parsed?.error
            ? `GitHub token refresh failed (${parsed.error}). Please sign in again.`
            : "GitHub authorization was revoked or expired. Please sign in again.");
        yield* markNeedsReconnect(record, reason);
        return null;
      }

      if (status < 200 || status >= 300 || parsed === null || normalizedError.length > 0) {
        // Transient error (5xx, 403 secondary rate limit, temporarily_unavailable, etc.):
        // keep stored refresh_token intact and reuse still-valid access token if unchanged.
        if (stillValid && (yield* verifyRecordUnchanged(record))) {
          return {
            token: secret.accessToken,
            authMethod: secret.authMethod,
            githubLogin: record.githubLogin,
            githubName: record.githubName,
            githubEmail: record.githubEmail,
            apiBaseUrl: record.apiBaseUrl,
            refreshed: false,
          };
        }
        return null;
      }

      const tokenSet = parseTokenSetFromJson(nowMs, parsed);
      if (tokenSet === null) {
        yield* markNeedsReconnect(
          record,
          "GitHub token refresh returned an empty access token. Please sign in again.",
        );
        return null;
      }

      // Serialize secret write + CAS update + state publish with credential mutations so a disconnect
      // or PAT/OAuth replacement cannot interleave, resurrect a deleted secret, or publish stale state.
      const committed = yield* withMemberGitHubCredentialMutationLock(
        input.teamId,
        input.memberId,
        Effect.gen(function* () {
          if (!(yield* verifyRecordUnchanged(record))) {
            return false;
          }

          const nextRefreshToken = tokenSet.refreshToken ?? refreshToken;
          const nextRefreshTokenExpiresAt =
            tokenSet.refreshTokenExpiresAt ?? secret.refreshTokenExpiresAt ?? undefined;
          const { expiresAt: _prevExpiresAt, ...baseSecret } = secret;
          const nextSecret: TeamGitHubRepository.StoredTeamGitHubSecret = {
            ...baseSecret,
            accessToken: tokenSet.accessToken,
            ...(nextRefreshToken.length > 0 ? { refreshToken: nextRefreshToken } : {}),
            ...(tokenSet.expiresAt !== null ? { expiresAt: tokenSet.expiresAt } : {}),
            ...(nextRefreshTokenExpiresAt !== undefined
              ? { refreshTokenExpiresAt: nextRefreshTokenExpiresAt }
              : {}),
            tokenEndpoint: `${appConfig.webBaseUrl}/login/oauth/access_token`,
            webBaseUrl: appConfig.webBaseUrl,
            clientId: appConfig.clientId,
          };
          const writeResult = yield* Effect.result(
            TeamGitHubRepository.writeTeamGitHubSecret(input.secrets, record.secretKey, nextSecret),
          );
          if (writeResult._tag === "Failure") {
            return false;
          }

          const updatedRecordOpt = yield* input.githubRepo
            .updateMemberCredentialRefreshState({
              memberId: input.memberId,
              expectedSecretKey: record.secretKey,
              tokenExpiresAt: tokenSet.expiresAt,
              hasRefreshToken: nextRefreshToken.length > 0,
              needsReconnect: false,
              reconnectReason: null,
            })
            .pipe(Effect.orElseSucceed(() => Option.none()));

          if (Option.isNone(updatedRecordOpt)) {
            yield* TeamGitHubRepository.removeTeamGitHubSecret(
              input.secrets,
              record.secretKey,
            ).pipe(Effect.ignore);
            return false;
          }

          if (input.onIdentityUpdated) {
            yield* input
              .onIdentityUpdated(
                TeamGitHubRepository.stripMemberGitHubSecretKey(updatedRecordOpt.value),
              )
              .pipe(Effect.ignore);
          }
          return true;
        }),
      );
      if (!committed) {
        return null;
      }

      return {
        token: tokenSet.accessToken,
        authMethod: secret.authMethod,
        githubLogin: record.githubLogin,
        githubName: record.githubName,
        githubEmail: record.githubEmail,
        apiBaseUrl: record.apiBaseUrl,
        refreshed: true,
      };
    }),
  );
});

function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderGitHubOAuthCallbackHtml(
  outcome:
    | { readonly ok: true; readonly githubLogin: string; readonly mode: TeamGitHubOAuthMode }
    | { readonly ok: "confirm"; readonly confirmationCode: string }
    | { readonly ok: false; readonly message: string },
): string {
  const title =
    outcome.ok === true
      ? "GitHub Connected - T3 Code"
      : outcome.ok === "confirm"
        ? "Confirm GitHub Sign-In - T3 Code"
        : "GitHub Sign-In Failed - T3 Code";
  const badgeText =
    outcome.ok === true
      ? "Connected"
      : outcome.ok === "confirm"
        ? "Confirmation required"
        : "Sign-in failed";
  const badgeBg =
    outcome.ok === true ? "#065f46" : outcome.ok === "confirm" ? "#1e3a8a" : "#7f1d1d";
  const badgeFg =
    outcome.ok === true ? "#d1fae5" : outcome.ok === "confirm" ? "#dbeafe" : "#fee2e2";
  const heading =
    outcome.ok === true
      ? `Connected as @${escapeHtml(outcome.githubLogin)}`
      : outcome.ok === "confirm"
        ? "Finish sign-in in T3 Code"
        : "Could not complete GitHub sign-in";
  const detail =
    outcome.ok === true
      ? outcome.mode === "github_app"
        ? "Your GitHub App authorization is active with automatic short-lived token refresh. You can close this window and return to T3 Code."
        : "Your GitHub OAuth account is connected to your team profile. You can close this window and return to T3 Code."
      : outcome.ok === "confirm"
        ? "Enter this one-time confirmation code in the T3 Code Settings tab where you started GitHub sign-in (expires in 2 minutes). Only enter this code if you started sign-in yourself; if someone else sent you this link, close this page."
        : escapeHtml(outcome.message);
  const codeBlock =
    outcome.ok === "confirm"
      ? `<div class="code" data-testid="github-oauth-confirmation-code">${escapeHtml(outcome.confirmationCode)}</div>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark light; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: #0b0d12;
      color: #f3f4f6;
      padding: 24px;
    }
    .card {
      max-width: 440px;
      width: 100%;
      border-radius: 14px;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: #141821;
      padding: 28px;
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
    }
    .badge {
      display: inline-block;
      font-size: 12px;
      font-weight: 600;
      padding: 4px 10px;
      border-radius: 999px;
      background: ${badgeBg};
      color: ${badgeFg};
      margin-bottom: 14px;
    }
    h1 {
      margin: 0 0 10px;
      font-size: 20px;
      line-height: 1.3;
    }
    p {
      margin: 0;
      font-size: 14px;
      line-height: 1.55;
      color: #9ca3af;
    }
    .code {
      margin-top: 16px;
      padding: 12px 16px;
      border-radius: 10px;
      border: 1px solid rgba(255, 255, 255, 0.14);
      background: #0b0d12;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 22px;
      font-weight: 700;
      letter-spacing: 0.14em;
      text-align: center;
      color: #f9fafb;
    }
  </style>
</head>
<body>
  <main class="card">
    <span class="badge">${escapeHtml(badgeText)}</span>
    <h1>${heading}</h1>
    <p>${detail}</p>
    ${codeBlock}
  </main>
</body>
</html>`;
}
