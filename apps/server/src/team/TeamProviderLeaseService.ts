// @effect-diagnostics nodeBuiltinImport:off -- Reads local provider token files when linked to a Team Server OAuth profile.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  defaultInstanceIdForDriver,
  IsoDateTime,
  isTeamProviderInstanceId,
  NonNegativeInt,
  ProviderDriverKind,
  TeamOperationError,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerSettings,
  type TeamProviderLeaseResponse,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest } from "effect/http";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { getTeamHarnessProfile } from "./harnessProfiles.ts";

/** Refresh server-side when remaining lifetime is below 10 minutes. */
const TEAM_SERVER_OAUTH_REFRESH_THRESHOLD_MS = 10 * 60 * 1000;

export const StoredTeamProviderSecret = Schema.Struct({
  apiKey: Schema.optionalKey(Schema.String),
  oauthAccessToken: Schema.optionalKey(Schema.String),
  oauthRefreshToken: Schema.optionalKey(Schema.String),
  oauthExpiresAt: Schema.optionalKey(Schema.String),
  oauthTokenType: Schema.optionalKey(Schema.String),
  oauthTokenEndpoint: Schema.optionalKey(Schema.String),
  oauthClientId: Schema.optionalKey(Schema.String),
  oauthClientSecret: Schema.optionalKey(Schema.String),
  oauthEmail: Schema.optionalKey(Schema.String),
  oauthAuthMethod: Schema.optionalKey(Schema.String),
});
export type StoredTeamProviderSecret = typeof StoredTeamProviderSecret.Type;

const decodeStoredSecret = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredTeamProviderSecret),
);
const encodeStoredSecret = Schema.encodeSync(Schema.fromJsonString(StoredTeamProviderSecret));

const OAuthRefreshResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optionalKey(Schema.String),
  token_type: Schema.optionalKey(Schema.String),
  expires_in: Schema.optionalKey(Schema.Finite),
  expiry: Schema.optionalKey(Schema.String),
});
const decodeOAuthRefreshResponse = Schema.decodeUnknownEffect(OAuthRefreshResponse);

const decodeAntigravityOAuthTokenFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      token: Schema.optionalKey(
        Schema.Struct({
          access_token: Schema.optionalKey(Schema.String),
          refresh_token: Schema.optionalKey(Schema.String),
          token_type: Schema.optionalKey(Schema.String),
          expiry: Schema.optionalKey(Schema.String),
        }),
      ),
      auth_method: Schema.optionalKey(Schema.String),
      id_token_email: Schema.optionalKey(Schema.String),
    }),
  ),
);

const decodeClaudeCredentialsFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      claudeAiOauth: Schema.optionalKey(
        Schema.Struct({
          accessToken: Schema.optionalKey(Schema.String),
          refreshToken: Schema.optionalKey(Schema.String),
          expiresAt: Schema.optionalKey(Schema.Union([Schema.Number, Schema.String])),
        }),
      ),
    }),
  ),
);

const decodeCodexAuthFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      tokens: Schema.optionalKey(
        Schema.Struct({
          access_token: Schema.optionalKey(Schema.String),
          refresh_token: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
);

function expandLeadingTilde(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (trimmed === "~") return NodeOS.homedir();
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return NodePath.join(NodeOS.homedir(), trimmed.slice(2));
  }
  return trimmed;
}

function readInstanceConfigPath(
  instance: ProviderInstanceConfig,
  key: "homePath" | "shadowHomePath",
): string | null {
  const cfg = instance.config;
  if (cfg !== null && typeof cfg === "object" && key in cfg) {
    const raw = (cfg as Readonly<Record<string, unknown>>)[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return NodePath.resolve(expandLeadingTilde(raw));
    }
  }
  return null;
}

function readInstanceEnvValue(instance: ProviderInstanceConfig, envVarName: string): string | null {
  const env = instance.environment;
  if (!Array.isArray(env)) return null;
  for (const entry of env) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      "name" in entry &&
      "value" in entry &&
      (entry as { readonly name?: unknown }).name === envVarName
    ) {
      const value = (entry as { readonly value?: unknown }).value;
      if (typeof value === "string" && value.trim().length > 0) {
        return NodePath.resolve(expandLeadingTilde(value));
      }
    }
  }
  return null;
}

function isBuiltInDefaultInstanceForDriver(
  driver: ProviderDriverKind | string,
  instanceId: string,
): boolean {
  if (driver !== "antigravity" && driver !== "claudeAgent" && driver !== "codex") {
    return false;
  }
  return instanceId === defaultInstanceIdForDriver(ProviderDriverKind.make(driver));
}

/**
 * Resolves the on-disk profile directory for a linked Team Server provider instance.
 * Rejects `team:` IDs, fails closed when `serverSettings` is `null`, and follows Codex shadow homes.
 */
export function resolveLinkedServerProviderProfileDir(input: {
  readonly stateDir: string;
  readonly driver: ProviderDriverKind | string;
  readonly linkedServerInstanceId: string;
  readonly serverSettings?: ServerSettings | null;
}): string | null {
  const trimmedId = input.linkedServerInstanceId.trim();
  if (trimmedId.length === 0 || isTeamProviderInstanceId(trimmedId)) {
    return null;
  }
  // Explicit `null` signals that ServerSettingsService failed to read settings; fail closed
  // rather than silently falling back to host defaults.
  if (input.serverSettings === null) {
    return null;
  }
  let matchedInstance: ProviderInstanceConfig | null = null;
  if (input.serverSettings !== undefined) {
    const providerInstances = input.serverSettings.providerInstances as Readonly<
      Record<string, ProviderInstanceConfig>
    >;
    const candidate = Object.hasOwn(providerInstances, trimmedId)
      ? providerInstances[trimmedId]
      : undefined;
    if (candidate !== undefined) {
      if (candidate.driver !== input.driver) {
        return null;
      }
      matchedInstance = candidate;
    } else if (isBuiltInDefaultInstanceForDriver(input.driver, trimmedId)) {
      matchedInstance = { driver: input.driver as ProviderDriverKind };
    } else {
      return null;
    }
  }

  if (input.driver === "antigravity") {
    const hash = NodeCrypto.createHash("sha256").update(trimmedId, "utf8").digest("hex");
    return NodePath.join(input.stateDir, "providers", "antigravity", hash);
  }
  if (input.driver === "claudeAgent") {
    const instanceHome = matchedInstance
      ? readInstanceConfigPath(matchedInstance, "homePath")
      : null;
    if (instanceHome) return instanceHome;
    const instanceEnvDir = matchedInstance
      ? readInstanceEnvValue(matchedInstance, "CLAUDE_CONFIG_DIR")
      : null;
    if (instanceEnvDir) return instanceEnvDir;
    const envDir = process.env.CLAUDE_CONFIG_DIR?.trim();
    return envDir && envDir.length > 0
      ? NodePath.resolve(expandLeadingTilde(envDir))
      : NodePath.join(NodeOS.homedir(), ".claude");
  }
  if (input.driver === "codex") {
    // Codex authOverlay keeps its private auth.json in shadowHomePath when configured.
    const shadowHome = matchedInstance
      ? readInstanceConfigPath(matchedInstance, "shadowHomePath")
      : null;
    if (shadowHome) return shadowHome;
    const instanceHome = matchedInstance
      ? readInstanceConfigPath(matchedInstance, "homePath")
      : null;
    if (instanceHome) return instanceHome;
    const instanceEnvDir = matchedInstance
      ? readInstanceEnvValue(matchedInstance, "CODEX_HOME")
      : null;
    if (instanceEnvDir) return instanceEnvDir;
    const envDir = process.env.CODEX_HOME?.trim();
    return envDir && envDir.length > 0
      ? NodePath.resolve(expandLeadingTilde(envDir))
      : NodePath.join(NodeOS.homedir(), ".codex");
  }
  return null;
}

export function readLinkedServerInstanceIdFromConfig(
  config: Readonly<Record<string, unknown>> | null | undefined,
): string | null {
  const raw = config?.linkedServerInstanceId;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || isTeamProviderInstanceId(trimmed)) return null;
  return trimmed;
}

/**
 * Reads only the current short-lived access token metadata from a linked server profile directory.
 * Refresh tokens are deliberately never read or forwarded; the originating server provider adapter
 * owns token refresh and its upstream endpoint.
 */
async function readOAuthCredentialsFromServerProfileDir(input: {
  readonly driver: ProviderDriverKind | string;
  readonly profileDir: string;
}): Promise<StoredTeamProviderSecret | null> {
  if (input.driver === "antigravity") {
    const tokenPaths = getTeamHarnessProfile("antigravity").ephemeralTokenRelativePaths;
    for (const segments of tokenPaths) {
      const raw = await NodeFSP.readFile(
        NodePath.join(input.profileDir, ...segments),
        "utf8",
      ).catch(() => undefined);
      if (!raw) continue;
      const parsedOpt = decodeAntigravityOAuthTokenFile(raw);
      if (Option.isNone(parsedOpt)) continue;
      const parsed = parsedOpt.value;
      if (!parsed.token?.access_token) continue;
      return {
        oauthAccessToken: parsed.token.access_token,
        ...(parsed.token.token_type ? { oauthTokenType: parsed.token.token_type } : {}),
        ...(parsed.token.expiry ? { oauthExpiresAt: parsed.token.expiry } : {}),
        ...(parsed.auth_method ? { oauthAuthMethod: parsed.auth_method } : {}),
        ...(parsed.id_token_email ? { oauthEmail: parsed.id_token_email } : {}),
      };
    }
    return null;
  }

  if (input.driver === "claudeAgent") {
    const raw = await NodeFSP.readFile(
      NodePath.join(input.profileDir, ".credentials.json"),
      "utf8",
    ).catch(() => undefined);
    if (!raw) return null;
    const parsedOpt = decodeClaudeCredentialsFile(raw);
    if (Option.isNone(parsedOpt)) return null;
    const oauth = parsedOpt.value.claudeAiOauth;
    if (!oauth?.accessToken) return null;
    const parsedExpiry =
      typeof oauth.expiresAt === "number" && Number.isFinite(oauth.expiresAt)
        ? DateTime.make(oauth.expiresAt)
        : typeof oauth.expiresAt === "string"
          ? DateTime.make(oauth.expiresAt)
          : Option.none();
    const expiresAtIso = Option.isSome(parsedExpiry)
      ? DateTime.formatIso(parsedExpiry.value)
      : undefined;
    return {
      oauthAccessToken: oauth.accessToken,
      ...(expiresAtIso ? { oauthExpiresAt: expiresAtIso } : {}),
    };
  }

  if (input.driver === "codex") {
    const raw = await NodeFSP.readFile(NodePath.join(input.profileDir, "auth.json"), "utf8").catch(
      () => undefined,
    );
    if (!raw) return null;
    const parsedOpt = decodeCodexAuthFile(raw);
    if (Option.isNone(parsedOpt)) return null;
    const tokens = parsedOpt.value.tokens;
    if (!tokens?.access_token) return null;
    return {
      oauthAccessToken: tokens.access_token,
    };
  }

  return null;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function teamProviderSecretKey(teamId: string, providerInstanceId: string): string {
  const safeInstance = providerInstanceId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `team-provider-${teamId}-${safeInstance}`;
}

export const readTeamProviderSecret = Effect.fn("TeamProviderLease.readSecret")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  secretKey: string,
): Effect.fn.Return<StoredTeamProviderSecret | null, TeamOperationError> {
  const raw = yield* secrets.get(secretKey).pipe(
    Effect.mapError(
      () =>
        new TeamOperationError({
          code: "internal",
          message: "Could not read team provider credentials from secret store.",
        }),
    ),
  );
  if (Option.isNone(raw)) return null;
  const parsed = decodeStoredSecret(decoder.decode(raw.value));
  return Option.isSome(parsed) ? parsed.value : null;
});

export const writeTeamProviderSecret = Effect.fn("TeamProviderLease.writeSecret")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  secretKey: string,
  payload: StoredTeamProviderSecret,
): Effect.fn.Return<void, TeamOperationError> {
  const bytes = encoder.encode(encodeStoredSecret(payload));
  yield* secrets.set(secretKey, bytes).pipe(
    Effect.mapError(
      () =>
        new TeamOperationError({
          code: "internal",
          message: "Could not persist team provider credentials in secret store.",
        }),
    ),
  );
});

export const removeTeamProviderSecret = Effect.fn("TeamProviderLease.removeSecret")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  secretKey: string,
): Effect.fn.Return<void, TeamOperationError> {
  yield* secrets.remove(secretKey).pipe(
    Effect.mapError(
      () =>
        new TeamOperationError({
          code: "internal",
          message: "Could not remove team provider credentials from secret store.",
        }),
    ),
  );
});

const refreshLocks = new Map<string, Semaphore.Semaphore>();

export function clearTeamProviderRefreshLock(lockKey: string): void {
  refreshLocks.delete(lockKey);
}

function getRefreshLock(lockKey: string): Effect.Effect<Semaphore.Semaphore> {
  const existing = refreshLocks.get(lockKey);
  if (existing) return Effect.succeed(existing);
  return Semaphore.make(1).pipe(
    Effect.tap((sem) =>
      Effect.sync(() => {
        if (!refreshLocks.has(lockKey)) {
          refreshLocks.set(lockKey, sem);
        }
      }),
    ),
    Effect.map(() => refreshLocks.get(lockKey)!),
  );
}

/**
 * Issues a short-lived ephemeral OAuth access token lease for a team provider.
 * - Refreshes server-side under a per-provider lock when `forceRefresh` or `< 10 min` remains.
 * - Persists rotated refresh/access tokens exclusively in the Team Server's `ServerSecretStore`.
 * - Strictly strips `refresh_token`, `refreshToken`, and `clientSecret` before returning.
 */
export const issueEphemeralTeamProviderLease = Effect.fn("TeamProviderLease.issueLease")(
  function* (input: {
    readonly secrets: ServerSecretStore.ServerSecretStore["Service"];
    readonly httpClient: HttpClient.HttpClient;
    readonly secretKey: string;
    readonly providerInstanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly forceRefresh?: boolean;
    readonly fallbackProfileDir?: string;
  }): Effect.fn.Return<TeamProviderLeaseResponse, TeamOperationError> {
    const lock = yield* getRefreshLock(input.secretKey);
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        // Linked server profile mode: always read live access token metadata directly from disk
        // so CLI rotations are picked up immediately and linked refresh tokens never cross to
        // admin-configured OAuth endpoints.
        const isLinkedProfileMode = Boolean(input.fallbackProfileDir);
        let stored: StoredTeamProviderSecret | null = isLinkedProfileMode
          ? yield* Effect.promise(() =>
              readOAuthCredentialsFromServerProfileDir({
                driver: input.driver,
                profileDir: input.fallbackProfileDir!,
              }),
            )
          : yield* readTeamProviderSecret(input.secrets, input.secretKey);

        if (stored === null || (!stored.oauthAccessToken && !stored.oauthRefreshToken)) {
          return yield* new TeamOperationError({
            code: "not_found",
            message: `No OAuth credentials are configured on the Team Server for provider "${input.providerInstanceId}".`,
          });
        }

        const nowMs = yield* Clock.currentTimeMillis;
        const parsedExpiryMs = stored.oauthExpiresAt ? Date.parse(stored.oauthExpiresAt) : NaN;
        const remainingMs = Number.isFinite(parsedExpiryMs) ? parsedExpiryMs - nowMs : 0;
        const needsRefresh =
          !stored.oauthAccessToken ||
          input.forceRefresh === true ||
          remainingMs < TEAM_SERVER_OAUTH_REFRESH_THRESHOLD_MS;

        if (
          !isLinkedProfileMode &&
          needsRefresh &&
          stored.oauthRefreshToken &&
          stored.oauthTokenEndpoint
        ) {
          const form = new URLSearchParams({
            grant_type: "refresh_token",
            refresh_token: stored.oauthRefreshToken,
            ...(stored.oauthClientId ? { client_id: stored.oauthClientId } : {}),
            ...(stored.oauthClientSecret ? { client_secret: stored.oauthClientSecret } : {}),
          });
          const request = HttpClientRequest.post(stored.oauthTokenEndpoint).pipe(
            HttpClientRequest.bodyText(form.toString(), "application/x-www-form-urlencoded"),
            HttpClientRequest.setHeader("accept", "application/json"),
          );
          const response = yield* input.httpClient.execute(request).pipe(
            Effect.timeout("15 seconds"),
            Effect.mapError(
              () =>
                new TeamOperationError({
                  code: "internal",
                  message: `Failed to refresh OAuth token for team provider "${input.providerInstanceId}".`,
                }),
            ),
          );
          if (response.status < 200 || response.status >= 300) {
            return yield* new TeamOperationError({
              code: "internal",
              message: `OAuth token refresh returned HTTP ${response.status} for team provider "${input.providerInstanceId}".`,
            });
          }
          const json = yield* response.json.pipe(
            Effect.flatMap(decodeOAuthRefreshResponse),
            Effect.mapError(
              () =>
                new TeamOperationError({
                  code: "internal",
                  message: `OAuth token refresh returned an invalid response for "${input.providerInstanceId}".`,
                }),
            ),
          );
          const nextExpiresAtMs =
            json.expiry && Number.isFinite(Date.parse(json.expiry))
              ? Date.parse(json.expiry)
              : nowMs + Math.max(60, Math.floor(json.expires_in ?? 3600)) * 1000;
          const nextExpiresAtIso = DateTime.formatIso(DateTime.makeUnsafe(nextExpiresAtMs));
          stored = {
            ...stored,
            oauthAccessToken: json.access_token,
            ...(json.refresh_token ? { oauthRefreshToken: json.refresh_token } : {}),
            ...(json.token_type ? { oauthTokenType: json.token_type } : {}),
            oauthExpiresAt: nextExpiresAtIso,
          };
          yield* writeTeamProviderSecret(input.secrets, input.secretKey, stored);
        }

        if (!stored.oauthAccessToken) {
          return yield* new TeamOperationError({
            code: "not_found",
            message: `No valid OAuth access token is available for team provider "${input.providerInstanceId}".`,
          });
        }

        const finalExpiryMs =
          stored.oauthExpiresAt && Number.isFinite(Date.parse(stored.oauthExpiresAt))
            ? Date.parse(stored.oauthExpiresAt)
            : nowMs + 3_600_000;
        const expiresInSeconds = Math.max(0, Math.floor((finalExpiryMs - nowMs) / 1000));
        const expiresAt = IsoDateTime.make(DateTime.formatIso(DateTime.makeUnsafe(finalExpiryMs)));

        // Return ONLY short-lived access token metadata; refresh_token NEVER leaves the Team Server.
        return {
          providerInstanceId: input.providerInstanceId,
          driver: input.driver,
          accessToken: stored.oauthAccessToken,
          tokenType: stored.oauthTokenType ?? "Bearer",
          expiresAt,
          expiresInSeconds: NonNegativeInt.make(expiresInSeconds),
          ...(stored.oauthEmail !== undefined ? { email: stored.oauthEmail } : {}),
          ...(stored.oauthAuthMethod !== undefined ? { authMethod: stored.oauthAuthMethod } : {}),
        } satisfies TeamProviderLeaseResponse;
      }),
    );
  },
);
