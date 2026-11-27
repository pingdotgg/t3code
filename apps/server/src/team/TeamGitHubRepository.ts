// @effect-diagnostics nodeBuiltinImport:off -- Server-side AES-256-GCM credential encryption and DNS/IP SSRF validation.
import * as NodeCrypto from "node:crypto";
import * as NodeDnsPromises from "node:dns/promises";
import * as NodeNet from "node:net";

import {
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_WEB_BASE_URL,
  TeamId,
  TeamMemberId,
  TeamOperationError,
  type TeamAutomationGitHubIdentity,
  type TeamGitHubAppConfig,
  type TeamGitHubAuthMethod,
  type TeamGitHubIdentity,
  type TeamGitHubOAuthMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import type * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { runTeamMigrations } from "./migrations.ts";

export class TeamGitHubRepositoryError extends Schema.TaggedError<TeamGitHubRepositoryError>()(
  "TeamGitHubRepositoryError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Team GitHub database operation failed (${this.operation}).`;
  }
}

/**
 * Encrypted credential payload persisted in `ServerSecretStore`.
 * Structured for Phase 7a PATs while remaining cleanly extensible for Phase 7b
 * GitHub OAuth and GitHub App user-to-server tokens (`refreshToken`, `expiresAt`, etc.).
 */
export const StoredTeamGitHubSecret = Schema.Struct({
  authMethod: Schema.Literals(["pat", "oauth", "github_app"]),
  accessToken: Schema.String,
  refreshToken: Schema.optionalKey(Schema.String),
  expiresAt: Schema.optionalKey(Schema.String),
  refreshTokenExpiresAt: Schema.optionalKey(Schema.String),
  tokenEndpoint: Schema.optionalKey(Schema.String),
  webBaseUrl: Schema.optionalKey(Schema.String),
  installationId: Schema.optionalKey(Schema.String),
  apiBaseUrl: Schema.String,
  githubLogin: Schema.String,
  githubName: Schema.NullOr(Schema.String),
  githubEmail: Schema.NullOr(Schema.String),
});
export type StoredTeamGitHubSecret = typeof StoredTeamGitHubSecret.Type;

const StoredGitHubAppClientSecretPayload = Schema.Struct({
  clientSecret: Schema.String,
});
const decodeStoredGitHubAppClientSecret = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredGitHubAppClientSecretPayload),
);
const encodeStoredGitHubAppClientSecret = Schema.encodeSync(
  Schema.fromJsonString(StoredGitHubAppClientSecretPayload),
);

const decodeStoredGitHubSecret = Schema.decodeUnknownOption(
  Schema.fromJsonString(StoredTeamGitHubSecret),
);
const encodeStoredGitHubSecret = Schema.encodeSync(Schema.fromJsonString(StoredTeamGitHubSecret));

const EncryptedSecretEnvelopeSchema = Schema.Struct({
  v: Schema.Literal(1),
  alg: Schema.Literal("aes-256-gcm"),
  iv: Schema.NonEmptyString,
  tag: Schema.NonEmptyString,
  ciphertext: Schema.NonEmptyString,
});
const decodeEncryptedEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(EncryptedSecretEnvelopeSchema),
);
const encodeEncryptedEnvelope = Schema.encodeSync(
  Schema.fromJsonString(EncryptedSecretEnvelopeSchema),
);

const TEAM_GITHUB_ENCRYPTION_KEY_NAME = "team-github-encryption-key-v1";
const TEAM_GITHUB_ALLOWED_API_ORIGINS_ENV = "T3_TEAM_GITHUB_ALLOWED_API_ORIGINS";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sanitizeSecretSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function teamMemberGitHubSecretKey(teamId: TeamId, memberId: TeamMemberId): string {
  return `team-github-member-${sanitizeSecretSegment(teamId)}-${sanitizeSecretSegment(memberId)}`;
}

export function teamAutomationGitHubSecretKey(teamId: TeamId): string {
  return `team-github-automation-${sanitizeSecretSegment(teamId)}`;
}

export function teamGitHubAppClientSecretKey(teamId: TeamId): string {
  return `team-github-app-client-secret-${sanitizeSecretSegment(teamId)}`;
}

const getOrCreateEncryptionKey = Effect.fn("TeamGitHubRepository.getOrCreateEncryptionKey")(
  function* (
    secrets: ServerSecretStore.ServerSecretStore["Service"],
    createIfMissing: boolean,
  ): Effect.fn.Return<Uint8Array | null, TeamOperationError> {
    if (!createIfMissing) {
      const existing = yield* secrets.get(TEAM_GITHUB_ENCRYPTION_KEY_NAME).pipe(
        Effect.mapError(
          () =>
            new TeamOperationError({
              code: "internal",
              message: "Could not access GitHub credential encryption key.",
            }),
        ),
      );
      if (Option.isNone(existing)) return null;
      if (existing.value.byteLength !== 32) {
        return yield* new TeamOperationError({
          code: "internal",
          message: "Stored GitHub credential encryption key has an invalid length.",
        });
      }
      return existing.value;
    }
    const key = yield* secrets.getOrCreateRandom(TEAM_GITHUB_ENCRYPTION_KEY_NAME, 32).pipe(
      Effect.mapError(
        () =>
          new TeamOperationError({
            code: "internal",
            message: "Could not initialize GitHub credential encryption key.",
          }),
      ),
    );
    if (key.byteLength !== 32) {
      return yield* new TeamOperationError({
        code: "internal",
        message: "Stored GitHub credential encryption key has an invalid length.",
      });
    }
    return key;
  },
);

function decryptGitHubSecretEnvelope(
  key: Uint8Array,
  secretKey: string,
  envelope: typeof EncryptedSecretEnvelopeSchema.Type,
): StoredTeamGitHubSecret | null {
  try {
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    if (iv.byteLength !== 12 || tag.byteLength !== 16) {
      return null;
    }
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(secretKey, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    const parsed = decodeStoredGitHubSecret(plaintext);
    return Option.isSome(parsed) ? parsed.value : null;
  } catch {
    return null;
  }
}

export const readTeamGitHubSecret = Effect.fn("TeamGitHubRepository.readSecret")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  secretKey: string,
): Effect.fn.Return<StoredTeamGitHubSecret | null, TeamOperationError> {
  const raw = yield* secrets.get(secretKey).pipe(
    Effect.mapError(
      () =>
        new TeamOperationError({
          code: "internal",
          message: "Could not read GitHub credentials from secret store.",
        }),
    ),
  );
  if (Option.isNone(raw)) return null;
  const envelopeOpt = decodeEncryptedEnvelope(decoder.decode(raw.value));
  if (Option.isNone(envelopeOpt)) {
    return null;
  }
  const key = yield* getOrCreateEncryptionKey(secrets, false);
  if (key === null) return null;
  return decryptGitHubSecretEnvelope(key, secretKey, envelopeOpt.value);
});

export const writeTeamGitHubSecret = Effect.fn("TeamGitHubRepository.writeSecret")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  secretKey: string,
  payload: StoredTeamGitHubSecret,
): Effect.fn.Return<void, TeamOperationError> {
  const key = yield* getOrCreateEncryptionKey(secrets, true);
  if (key === null) {
    return yield* new TeamOperationError({
      code: "internal",
      message: "Could not initialize GitHub credential encryption key.",
    });
  }
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(secretKey, "utf8"));
  const plaintext = encodeStoredGitHubSecret(payload);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = encodeEncryptedEnvelope({
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
  yield* secrets.set(secretKey, encoder.encode(envelope)).pipe(
    Effect.mapError(
      () =>
        new TeamOperationError({
          code: "internal",
          message: "Could not persist GitHub credentials in secret store.",
        }),
    ),
  );
});

export const removeTeamGitHubSecret = Effect.fn("TeamGitHubRepository.removeSecret")(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  secretKey: string,
): Effect.fn.Return<void, TeamOperationError> {
  yield* secrets.remove(secretKey).pipe(
    Effect.mapError(
      () =>
        new TeamOperationError({
          code: "internal",
          message: "Could not remove GitHub credentials from secret store.",
        }),
    ),
  );
});

function decryptGitHubAppClientSecretEnvelope(
  key: Uint8Array,
  secretKey: string,
  envelope: typeof EncryptedSecretEnvelopeSchema.Type,
): string | null {
  try {
    const iv = Buffer.from(envelope.iv, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64");
    if (iv.byteLength !== 12 || tag.byteLength !== 16) return null;
    const decipher = NodeCrypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAAD(Buffer.from(secretKey, "utf8"));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
      "utf8",
    );
    const parsed = decodeStoredGitHubAppClientSecret(plaintext);
    return Option.isSome(parsed) ? parsed.value.clientSecret : null;
  } catch {
    return null;
  }
}

export const readTeamGitHubAppClientSecret = Effect.fn("TeamGitHubRepository.readAppClientSecret")(
  function* (
    secrets: ServerSecretStore.ServerSecretStore["Service"],
    secretKey: string,
  ): Effect.fn.Return<string | null, TeamOperationError> {
    const raw = yield* secrets.get(secretKey).pipe(
      Effect.mapError(
        () =>
          new TeamOperationError({
            code: "internal",
            message: "Could not read GitHub App client secret from secret store.",
          }),
      ),
    );
    if (Option.isNone(raw)) return null;
    const envelopeOpt = decodeEncryptedEnvelope(decoder.decode(raw.value));
    if (Option.isNone(envelopeOpt)) return null;
    const key = yield* getOrCreateEncryptionKey(secrets, false);
    if (key === null) return null;
    return decryptGitHubAppClientSecretEnvelope(key, secretKey, envelopeOpt.value);
  },
);

export const writeTeamGitHubAppClientSecret = Effect.fn(
  "TeamGitHubRepository.writeAppClientSecret",
)(function* (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
  secretKey: string,
  clientSecret: string,
): Effect.fn.Return<void, TeamOperationError> {
  const key = yield* getOrCreateEncryptionKey(secrets, true);
  if (key === null) {
    return yield* new TeamOperationError({
      code: "internal",
      message: "Could not initialize GitHub credential encryption key.",
    });
  }
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(secretKey, "utf8"));
  const plaintext = encodeStoredGitHubAppClientSecret({ clientSecret });
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const envelope = encodeEncryptedEnvelope({
    v: 1,
    alg: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  });
  yield* secrets.set(secretKey, encoder.encode(envelope)).pipe(
    Effect.mapError(
      () =>
        new TeamOperationError({
          code: "internal",
          message: "Could not persist GitHub App client secret in secret store.",
        }),
    ),
  );
});

function parseAllowedApiOrigins(explicit?: ReadonlyArray<string>): ReadonlySet<string> {
  const result = new Set<string>();
  const rawSources: Array<string> = [];
  const envRaw = process.env[TEAM_GITHUB_ALLOWED_API_ORIGINS_ENV];
  if (typeof envRaw === "string" && envRaw.trim().length > 0) {
    for (const part of envRaw.split(",")) {
      if (part.trim().length > 0) rawSources.push(part.trim());
    }
  }
  if (explicit) {
    for (const part of explicit) {
      if (part.trim().length > 0) rawSources.push(part.trim());
    }
  }
  for (const entry of rawSources) {
    try {
      const parsed = new URL(entry);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        result.add(parsed.origin.toLowerCase());
      }
    } catch {
      // ignore malformed allowlist entry
    }
  }
  return result;
}

function isBlockedIpv4(ip: string): boolean {
  const parts = ip.split(".").map((segment) => Number(segment));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT / Tailscale
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF / TEST-NET-1
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmark
  if (a === 198 && b === 51 && c === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast & reserved/broadcast
  return false;
}

function expandIpv6Groups(raw: string): ReadonlyArray<number> | null {
  const withoutZone = raw.split("%")[0] ?? raw;
  const lower = withoutZone.toLowerCase();
  const mappedDotMatch = /^(.*):(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  let normalized = lower;
  if (mappedDotMatch) {
    const octets = mappedDotMatch[2]!.split(".").map((n) => Number(n));
    if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
      return null;
    }
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    normalized = `${mappedDotMatch[1]}:${hi}:${lo}`;
  }
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - (left.length + right.length);
  if (halves.length === 1 && missing !== 0) return null;
  if (halves.length === 2 && missing < 0) return null;
  const rawGroups = [...left, ...Array.from({ length: Math.max(0, missing) }, () => "0"), ...right];
  if (rawGroups.length !== 8) return null;
  const groups: Array<number> = [];
  for (const g of rawGroups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    groups.push(Number.parseInt(g, 16));
  }
  return groups;
}

function isBlockedGitHubApiIp(rawIp: string): boolean {
  const stripped = rawIp.trim().replace(/^\[|\]$/g, "");
  if (NodeNet.isIPv4(stripped)) {
    return isBlockedIpv4(stripped);
  }
  if (NodeNet.isIPv6(stripped)) {
    const groups = expandIpv6Groups(stripped);
    if (groups === null) return true;
    const isAllZeroPrefix = (count: number) => groups.slice(0, count).every((g) => g === 0);
    // Unspecified :: and loopback ::1
    if (isAllZeroPrefix(7) && (groups[7] === 0 || groups[7] === 1)) return true;
    // IPv4-mapped ::ffff:0:0/96 or IPv4-compatible ::/96
    if (isAllZeroPrefix(5) && (groups[5] === 0xffff || groups[5] === 0)) {
      const a = (groups[6]! >> 8) & 0xff;
      const b = groups[6]! & 0xff;
      const c = (groups[7]! >> 8) & 0xff;
      const d = groups[7]! & 0xff;
      return isBlockedIpv4(`${a}.${b}.${c}.${d}`);
    }
    const first = groups[0]!;
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 ULA
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
    if ((first & 0xff00) === 0xff00) return true; // ff00::/8 multicast
    if (first === 0x0064 && groups[1] === 0xff9b) return true; // 64:ff9b::/96 NAT64
    if (first === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return true; // 100::/64 discard
    if (first === 0x2001 && groups[1] === 0x0db8) return true; // 2001:db8::/32 docs
    return false;
  }
  return true;
}

const normalizeGitHubBaseUrl = Effect.fn("TeamGitHubRepository.normalizeBaseUrl")(
  function* (input: {
    readonly raw?: string | null;
    readonly defaultUrl: string;
    readonly label: string;
    readonly allowedApiOrigins?: ReadonlyArray<string>;
  }): Effect.fn.Return<string, TeamOperationError> {
    const trimmed = input.raw?.trim() ?? "";
    if (trimmed.length === 0) {
      return input.defaultUrl;
    }
    const parsed = yield* Effect.try({
      try: () => new URL(trimmed),
      catch: () =>
        new TeamOperationError({
          code: "invalid_input",
          message: `${input.label} must be a valid https:// URL.`,
        }),
    });
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: `${input.label} must use https://.`,
      });
    }
    if (parsed.username.length > 0 || parsed.password.length > 0) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: `${input.label} must not contain embedded credentials.`,
      });
    }
    if (parsed.search.length > 0 || parsed.hash.length > 0) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: `${input.label} must not contain query parameters or fragments.`,
      });
    }
    const allowedOrigins = parseAllowedApiOrigins(input.allowedApiOrigins);
    const explicitlyAllowed = allowedOrigins.has(parsed.origin.toLowerCase());
    if (!explicitlyAllowed) {
      if (parsed.protocol !== "https:") {
        return yield* new TeamOperationError({
          code: "invalid_input",
          message: `${input.label} must use https:// unless explicitly allowlisted by server configuration.`,
        });
      }
      const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
      if (
        hostname === "localhost" ||
        hostname.endsWith(".localhost") ||
        (NodeNet.isIP(hostname) !== 0 && isBlockedGitHubApiIp(hostname))
      ) {
        return yield* new TeamOperationError({
          code: "invalid_input",
          message: `${input.label} cannot target loopback, link-local, or private network addresses unless explicitly allowlisted.`,
        });
      }
    }
    return `${parsed.origin}${parsed.pathname}`.replace(/\/+$/, "");
  },
);

export const normalizeGitHubApiBaseUrl = Effect.fn("TeamGitHubRepository.normalizeApiBaseUrl")(
  function* (
    raw?: string | null,
    options?: { readonly allowedApiOrigins?: ReadonlyArray<string> },
  ): Effect.fn.Return<string, TeamOperationError> {
    return yield* normalizeGitHubBaseUrl({
      raw: raw ?? null,
      defaultUrl: DEFAULT_GITHUB_API_BASE_URL,
      label: "GitHub API base URL",
      ...(options?.allowedApiOrigins === undefined
        ? {}
        : { allowedApiOrigins: options.allowedApiOrigins }),
    });
  },
);

export const normalizeGitHubWebBaseUrl = Effect.fn("TeamGitHubRepository.normalizeWebBaseUrl")(
  function* (
    raw?: string | null,
    options?: { readonly allowedApiOrigins?: ReadonlyArray<string> },
  ): Effect.fn.Return<string, TeamOperationError> {
    return yield* normalizeGitHubBaseUrl({
      raw: raw ?? null,
      defaultUrl: DEFAULT_GITHUB_WEB_BASE_URL,
      label: "GitHub web base URL",
      ...(options?.allowedApiOrigins === undefined
        ? {}
        : { allowedApiOrigins: options.allowedApiOrigins }),
    });
  },
);

const TRUSTED_PUBLIC_GITHUB_ORIGINS: ReadonlySet<string> = new Set([
  DEFAULT_GITHUB_API_BASE_URL,
  DEFAULT_GITHUB_WEB_BASE_URL,
]);

/**
 * Resolves DNS for custom GitHub hosts before issuing server-side outbound requests so DNS
 * rebinding cannot target loopback, link-local metadata, or private RFC1918/ULA addresses.
 */
export const assertGitHubHostAllowed = Effect.fn("TeamGitHubRepository.assertHostAllowed")(
  function* (input: {
    readonly baseUrl: string;
    readonly label?: string;
    readonly allowedApiOrigins?: ReadonlyArray<string>;
    readonly resolveHostAddresses?: (hostname: string) => Promise<ReadonlyArray<string>>;
  }): Effect.fn.Return<void, TeamOperationError> {
    const parsedBase = new URL(input.baseUrl);
    const originLower = parsedBase.origin.toLowerCase();
    const allowedOrigins = parseAllowedApiOrigins(input.allowedApiOrigins);
    if (allowedOrigins.has(originLower) || TRUSTED_PUBLIC_GITHUB_ORIGINS.has(originLower)) {
      return;
    }
    const label = input.label ?? "GitHub base URL";
    const hostname = parsedBase.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    const resolvedAddresses = yield* Effect.tryPromise({
      try: async () => {
        if (input.resolveHostAddresses) {
          return await input.resolveHostAddresses(hostname);
        }
        const entries = await NodeDnsPromises.lookup(hostname, { all: true, verbatim: true });
        return entries.map((entry) => entry.address);
      },
      catch: () =>
        new TeamOperationError({
          code: "github_verification_failed",
          message: `Could not resolve GitHub host ${hostname}.`,
        }),
    });
    if (
      resolvedAddresses.length === 0 ||
      resolvedAddresses.some((address) => isBlockedGitHubApiIp(address))
    ) {
      return yield* new TeamOperationError({
        code: "invalid_input",
        message: `${label} resolves to a blocked loopback, link-local, or private network address.`,
      });
    }
  },
);

const GitHubUserResponseSchema = Schema.Struct({
  id: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.Number, Schema.String]))),
  login: Schema.NonEmptyString,
  name: Schema.optionalKey(Schema.NullOr(Schema.String)),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
const decodeGitHubUserResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(GitHubUserResponseSchema),
);

const GitHubUserEmailsResponseSchema = Schema.Array(
  Schema.Struct({
    email: Schema.NonEmptyString,
    primary: Schema.optionalKey(Schema.Boolean),
    verified: Schema.optionalKey(Schema.Boolean),
  }),
);
const decodeGitHubUserEmailsResponse = Schema.decodeUnknownOption(
  Schema.fromJsonString(GitHubUserEmailsResponseSchema),
);

export interface VerifiedGitHubProfile {
  readonly githubLogin: string;
  readonly githubName: string;
  readonly githubEmail: string;
  readonly apiBaseUrl: string;
}

/**
 * Verifies a GitHub token against `GET <apiBaseUrl>/user` (without following redirects so bearer
 * credentials are never forwarded across origins) and resolves login, name, and commit email.
 */
export const verifyGitHubToken = Effect.fn("TeamGitHubRepository.verifyToken")(function* (input: {
  readonly httpClient: HttpClient.HttpClient;
  readonly token: string;
  readonly apiBaseUrl?: string | null;
  readonly githubNameOverride?: string | null;
  readonly githubEmailOverride?: string | null;
  readonly allowedApiOrigins?: ReadonlyArray<string>;
  readonly resolveHostAddresses?: (hostname: string) => Promise<ReadonlyArray<string>>;
}): Effect.fn.Return<VerifiedGitHubProfile, TeamOperationError> {
  const token = input.token.trim();
  if (token.length === 0) {
    return yield* new TeamOperationError({
      code: "invalid_input",
      message: "GitHub token cannot be empty.",
    });
  }
  const apiBaseUrl = yield* normalizeGitHubApiBaseUrl(
    input.apiBaseUrl,
    input.allowedApiOrigins === undefined
      ? undefined
      : { allowedApiOrigins: input.allowedApiOrigins },
  );
  yield* assertGitHubHostAllowed({
    baseUrl: apiBaseUrl,
    label: "GitHub API base URL",
    ...(input.allowedApiOrigins === undefined
      ? {}
      : { allowedApiOrigins: input.allowedApiOrigins }),
    ...(input.resolveHostAddresses === undefined
      ? {}
      : { resolveHostAddresses: input.resolveHostAddresses }),
  });
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "user-agent": "t3code-teams",
    "x-github-api-version": "2022-11-28",
  } as const;

  const userReq = HttpClientRequest.get(`${apiBaseUrl}/user`).pipe(
    HttpClientRequest.setHeaders(headers),
  );
  const userRes = yield* input.httpClient.execute(userReq).pipe(
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
    Effect.timeout("15 seconds"),
    Effect.mapError(
      () =>
        new TeamOperationError({
          code: "github_verification_failed",
          message: `Could not reach GitHub API at ${apiBaseUrl} to verify token.`,
        }),
    ),
  );

  if (userRes.status >= 300 && userRes.status < 400) {
    return yield* new TeamOperationError({
      code: "github_verification_failed",
      message: "GitHub API redirected the verification request; check the API base URL.",
    });
  }
  if (userRes.status === 401 || userRes.status === 403) {
    return yield* new TeamOperationError({
      code: "github_verification_failed",
      message: "GitHub rejected the token. Check that the PAT is valid and has not expired.",
    });
  }
  if (userRes.status < 200 || userRes.status >= 300) {
    return yield* new TeamOperationError({
      code: "github_verification_failed",
      message: `GitHub API verification failed with HTTP ${userRes.status}.`,
    });
  }

  const rawBody = yield* userRes.text.pipe(
    Effect.mapError(
      () =>
        new TeamOperationError({
          code: "github_verification_failed",
          message: "Could not read GitHub user profile response.",
        }),
    ),
  );
  const decodedUser = decodeGitHubUserResponse(rawBody);
  if (Option.isNone(decodedUser)) {
    return yield* new TeamOperationError({
      code: "github_verification_failed",
      message: "GitHub API returned an invalid user profile payload.",
    });
  }

  const login = decodedUser.value.login.trim();
  const profileName = decodedUser.value.name?.trim() ?? "";
  let resolvedEmail = decodedUser.value.email?.trim() ?? "";

  if (resolvedEmail.length === 0 && !input.githubEmailOverride?.trim()) {
    const emailsReq = HttpClientRequest.get(`${apiBaseUrl}/user/emails`).pipe(
      HttpClientRequest.setHeaders(headers),
    );
    const emailsRes = yield* input.httpClient
      .execute(emailsReq)
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
        Effect.timeout("10 seconds"),
        Effect.option,
      );
    if (Option.isSome(emailsRes) && emailsRes.value.status >= 200 && emailsRes.value.status < 300) {
      const emailsText = yield* emailsRes.value.text.pipe(Effect.orElseSucceed(() => ""));
      const parsedEmails = decodeGitHubUserEmailsResponse(emailsText);
      if (Option.isSome(parsedEmails)) {
        const best =
          parsedEmails.value.find((entry) => entry.primary && entry.verified) ??
          parsedEmails.value.find((entry) => entry.primary) ??
          parsedEmails.value.find((entry) => entry.verified) ??
          parsedEmails.value[0];
        if (best) {
          resolvedEmail = best.email.trim();
        }
      }
    }
  }

  const fallbackEmail =
    decodedUser.value.id !== undefined && decodedUser.value.id !== null
      ? `${decodedUser.value.id}+${login}@users.noreply.github.com`
      : `${login}@users.noreply.github.com`;

  const githubName = input.githubNameOverride?.trim() || profileName || login;
  const githubEmail = input.githubEmailOverride?.trim() || resolvedEmail || fallbackEmail;

  return {
    githubLogin: login,
    githubName,
    githubEmail,
    apiBaseUrl,
  };
});

export interface StoredMemberGitHubRecord extends TeamGitHubIdentity {
  readonly memberId: TeamMemberId;
  readonly teamId: TeamId;
  readonly secretKey: string;
}

export interface StoredAutomationGitHubRecord extends TeamAutomationGitHubIdentity {
  readonly teamId: TeamId;
  readonly secretKey: string;
}

export interface StoredGitHubAppConfigRecord {
  readonly teamId: TeamId;
  readonly mode: TeamGitHubOAuthMode;
  readonly clientId: string;
  readonly webBaseUrl: string;
  readonly apiBaseUrl: string;
  readonly scopes: string;
  readonly enabled: boolean;
  readonly clientSecretKey: string | null;
  readonly updatedByMemberId: TeamMemberId;
  readonly updatedAt: string;
}

export function stripMemberGitHubSecretKey(record: StoredMemberGitHubRecord): TeamGitHubIdentity {
  return {
    authMethod: record.authMethod,
    githubLogin: record.githubLogin,
    githubName: record.githubName,
    githubEmail: record.githubEmail,
    apiBaseUrl: record.apiBaseUrl,
    connectedAt: record.connectedAt,
    updatedAt: record.updatedAt,
    ...(record.tokenExpiresAt !== undefined ? { tokenExpiresAt: record.tokenExpiresAt } : {}),
    ...(record.hasRefreshToken !== undefined ? { hasRefreshToken: record.hasRefreshToken } : {}),
    ...(record.needsReconnect !== undefined ? { needsReconnect: record.needsReconnect } : {}),
    ...(record.reconnectReason !== undefined ? { reconnectReason: record.reconnectReason } : {}),
  };
}

export function stripGitHubAppClientSecretKey(
  record: StoredGitHubAppConfigRecord,
  options?: { readonly includeUpdatedBy?: boolean },
): TeamGitHubAppConfig {
  return {
    enabled: record.enabled,
    mode: record.mode,
    clientId: record.clientId,
    webBaseUrl: record.webBaseUrl,
    apiBaseUrl: record.apiBaseUrl,
    scopes: record.scopes,
    hasClientSecret: record.clientSecretKey !== null,
    ...(options?.includeUpdatedBy === true ? { updatedByMemberId: record.updatedByMemberId } : {}),
    updatedAt: record.updatedAt,
  };
}

export function stripAutomationGitHubSecretKey(
  record: StoredAutomationGitHubRecord,
): TeamAutomationGitHubIdentity {
  return {
    authMethod: record.authMethod,
    githubLogin: record.githubLogin,
    githubName: record.githubName,
    githubEmail: record.githubEmail,
    apiBaseUrl: record.apiBaseUrl,
    updatedByMemberId: record.updatedByMemberId,
    connectedAt: record.connectedAt,
    updatedAt: record.updatedAt,
  };
}

interface MemberCredentialRow {
  readonly member_id: string;
  readonly team_id: string;
  readonly auth_method: TeamGitHubAuthMethod;
  readonly github_login: string;
  readonly github_name: string | null;
  readonly github_email: string | null;
  readonly api_base_url: string;
  readonly secret_key: string;
  readonly connected_at: string;
  readonly updated_at: string;
  readonly token_expires_at: string | null;
  readonly has_refresh_token: number;
  readonly needs_reconnect: number;
  readonly reconnect_reason: string | null;
}

interface AutomationCredentialRow {
  readonly team_id: string;
  readonly auth_method: TeamGitHubAuthMethod;
  readonly github_login: string;
  readonly github_name: string | null;
  readonly github_email: string | null;
  readonly api_base_url: string;
  readonly secret_key: string;
  readonly updated_by_member_id: string;
  readonly connected_at: string;
  readonly updated_at: string;
}

interface GitHubAppConfigRow {
  readonly team_id: string;
  readonly mode: TeamGitHubOAuthMode;
  readonly client_id: string;
  readonly web_base_url: string;
  readonly api_base_url: string;
  readonly scopes: string;
  readonly enabled: number;
  readonly client_secret_key: string | null;
  readonly updated_by_member_id: string;
  readonly updated_at: string;
}

const mapMemberRow = (row: MemberCredentialRow): StoredMemberGitHubRecord => ({
  memberId: TeamMemberId.make(row.member_id),
  teamId: TeamId.make(row.team_id),
  authMethod: row.auth_method,
  githubLogin: row.github_login,
  githubName: row.github_name,
  githubEmail: row.github_email,
  apiBaseUrl: row.api_base_url,
  secretKey: row.secret_key,
  connectedAt: row.connected_at,
  updatedAt: row.updated_at,
  ...(row.token_expires_at !== null ? { tokenExpiresAt: row.token_expires_at } : {}),
  ...(row.has_refresh_token === 1 ? { hasRefreshToken: true } : {}),
  ...(row.needs_reconnect === 1 ? { needsReconnect: true } : {}),
  ...(row.reconnect_reason !== null ? { reconnectReason: row.reconnect_reason } : {}),
});

const mapAutomationRow = (row: AutomationCredentialRow): StoredAutomationGitHubRecord => ({
  teamId: TeamId.make(row.team_id),
  authMethod: row.auth_method,
  githubLogin: row.github_login,
  githubName: row.github_name,
  githubEmail: row.github_email,
  apiBaseUrl: row.api_base_url,
  secretKey: row.secret_key,
  updatedByMemberId: TeamMemberId.make(row.updated_by_member_id),
  connectedAt: row.connected_at,
  updatedAt: row.updated_at,
});

const mapAppConfigRow = (row: GitHubAppConfigRow): StoredGitHubAppConfigRecord => ({
  teamId: TeamId.make(row.team_id),
  mode: row.mode,
  clientId: row.client_id,
  webBaseUrl: row.web_base_url,
  apiBaseUrl: row.api_base_url,
  scopes: row.scopes,
  enabled: row.enabled === 1,
  clientSecretKey: row.client_secret_key,
  updatedByMemberId: TeamMemberId.make(row.updated_by_member_id),
  updatedAt: row.updated_at,
});

export interface UpdateMemberRefreshStateInput {
  readonly memberId: TeamMemberId;
  readonly tokenExpiresAt: string | null;
  readonly hasRefreshToken: boolean;
  readonly needsReconnect: boolean;
  readonly reconnectReason: string | null;
}

export class TeamGitHubRepository extends Context.Service<
  TeamGitHubRepository,
  {
    readonly getMemberCredential: (
      memberId: TeamMemberId,
    ) => Effect.Effect<Option.Option<StoredMemberGitHubRecord>, TeamGitHubRepositoryError>;
    readonly upsertMemberCredential: (
      record: StoredMemberGitHubRecord,
    ) => Effect.Effect<StoredMemberGitHubRecord, TeamGitHubRepositoryError>;
    readonly updateMemberCredentialRefreshState: (
      input: UpdateMemberRefreshStateInput,
    ) => Effect.Effect<Option.Option<StoredMemberGitHubRecord>, TeamGitHubRepositoryError>;
    readonly deleteMemberCredential: (
      memberId: TeamMemberId,
      updatedAt?: string,
    ) => Effect.Effect<Option.Option<string>, TeamGitHubRepositoryError>;
    readonly getAutomationCredential: (
      teamId: TeamId,
    ) => Effect.Effect<Option.Option<StoredAutomationGitHubRecord>, TeamGitHubRepositoryError>;
    readonly upsertAutomationCredential: (
      record: StoredAutomationGitHubRecord,
    ) => Effect.Effect<StoredAutomationGitHubRecord, TeamGitHubRepositoryError>;
    readonly deleteAutomationCredential: (
      teamId: TeamId,
    ) => Effect.Effect<Option.Option<string>, TeamGitHubRepositoryError>;
    readonly getGitHubAppConfig: (
      teamId: TeamId,
    ) => Effect.Effect<Option.Option<StoredGitHubAppConfigRecord>, TeamGitHubRepositoryError>;
    readonly upsertGitHubAppConfig: (
      record: StoredGitHubAppConfigRecord,
    ) => Effect.Effect<StoredGitHubAppConfigRecord, TeamGitHubRepositoryError>;
    readonly deleteGitHubAppConfig: (
      teamId: TeamId,
    ) => Effect.Effect<
      Option.Option<{ readonly clientSecretKey: string | null }>,
      TeamGitHubRepositoryError
    >;
  }
>()("t3/team/TeamGitHubRepository") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runTeamMigrations();

  const wrap = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    effect.pipe(Effect.mapError((cause) => new TeamGitHubRepositoryError({ operation, cause })));

  return TeamGitHubRepository.of({
    getMemberCredential: Effect.fn("TeamGitHubRepository.getMemberCredential")(
      function* (memberId) {
        return yield* wrap(
          "getMemberCredential",
          sql<MemberCredentialRow>`
          SELECT member_id, team_id, auth_method, github_login, github_name, github_email,
                 api_base_url, secret_key, connected_at, updated_at,
                 token_expires_at, has_refresh_token, needs_reconnect, reconnect_reason
          FROM team_github_member_credentials
          WHERE member_id = ${memberId}
          LIMIT 1
        `.pipe(
            Effect.map((rows) =>
              rows[0] !== undefined ? Option.some(mapMemberRow(rows[0])) : Option.none(),
            ),
          ),
        );
      },
    ),

    upsertMemberCredential: Effect.fn("TeamGitHubRepository.upsertMemberCredential")(
      function* (record) {
        const tokenExpiresAt = record.tokenExpiresAt ?? null;
        const hasRefreshToken = record.hasRefreshToken === true ? 1 : 0;
        const needsReconnect = record.needsReconnect === true ? 1 : 0;
        const reconnectReason = record.reconnectReason ?? null;
        return yield* wrap(
          "upsertMemberCredential",
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
              INSERT INTO team_github_member_credentials (
                member_id, team_id, auth_method, github_login, github_name, github_email,
                api_base_url, secret_key, connected_at, updated_at,
                token_expires_at, has_refresh_token, needs_reconnect, reconnect_reason
              )
              VALUES (
                ${record.memberId},
                ${record.teamId},
                ${record.authMethod},
                ${record.githubLogin},
                ${record.githubName},
                ${record.githubEmail},
                ${record.apiBaseUrl},
                ${record.secretKey},
                ${record.connectedAt},
                ${record.updatedAt},
                ${tokenExpiresAt},
                ${hasRefreshToken},
                ${needsReconnect},
                ${reconnectReason}
              )
              ON CONFLICT(member_id) DO UPDATE SET
                auth_method = excluded.auth_method,
                github_login = excluded.github_login,
                github_name = excluded.github_name,
                github_email = excluded.github_email,
                api_base_url = excluded.api_base_url,
                secret_key = excluded.secret_key,
                updated_at = excluded.updated_at,
                token_expires_at = excluded.token_expires_at,
                has_refresh_token = excluded.has_refresh_token,
                needs_reconnect = excluded.needs_reconnect,
                reconnect_reason = excluded.reconnect_reason
            `;
              yield* sql`
              UPDATE team_members
              SET github_login = ${record.githubLogin},
                  github_name = ${record.githubName},
                  github_email = ${record.githubEmail},
                  updated_at = ${record.updatedAt}
              WHERE id = ${record.memberId}
            `;
              const rows = yield* sql<MemberCredentialRow>`
              SELECT member_id, team_id, auth_method, github_login, github_name, github_email,
                     api_base_url, secret_key, connected_at, updated_at,
                     token_expires_at, has_refresh_token, needs_reconnect, reconnect_reason
              FROM team_github_member_credentials
              WHERE member_id = ${record.memberId}
              LIMIT 1
            `;
              return rows[0] !== undefined ? mapMemberRow(rows[0]) : record;
            }),
          ),
        );
      },
    ),

    updateMemberCredentialRefreshState: Effect.fn(
      "TeamGitHubRepository.updateMemberCredentialRefreshState",
    )(function* (input) {
      // Preserves `updated_at` so active turn leases continue seamlessly across server-side token refreshes.
      return yield* wrap(
        "updateMemberCredentialRefreshState",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              UPDATE team_github_member_credentials
              SET token_expires_at = ${input.tokenExpiresAt},
                  has_refresh_token = ${input.hasRefreshToken ? 1 : 0},
                  needs_reconnect = ${input.needsReconnect ? 1 : 0},
                  reconnect_reason = ${input.reconnectReason}
              WHERE member_id = ${input.memberId}
            `;
            const rows = yield* sql<MemberCredentialRow>`
              SELECT member_id, team_id, auth_method, github_login, github_name, github_email,
                     api_base_url, secret_key, connected_at, updated_at,
                     token_expires_at, has_refresh_token, needs_reconnect, reconnect_reason
              FROM team_github_member_credentials
              WHERE member_id = ${input.memberId}
              LIMIT 1
            `;
            return rows[0] !== undefined ? Option.some(mapMemberRow(rows[0])) : Option.none();
          }),
        ),
      );
    }),

    deleteMemberCredential: Effect.fn("TeamGitHubRepository.deleteMemberCredential")(
      function* (memberId, updatedAt) {
        const nextUpdatedAt = updatedAt ?? DateTime.formatIso(yield* DateTime.now);
        return yield* wrap(
          "deleteMemberCredential",
          sql.withTransaction(
            Effect.gen(function* () {
              const existing = yield* sql<{ readonly secret_key: string }>`
              SELECT secret_key FROM team_github_member_credentials WHERE member_id = ${memberId} LIMIT 1
            `;
              yield* sql`
              DELETE FROM team_github_member_credentials WHERE member_id = ${memberId}
            `;
              yield* sql`
              UPDATE team_members
              SET github_login = NULL,
                  github_name = NULL,
                  github_email = NULL,
                  updated_at = ${nextUpdatedAt}
              WHERE id = ${memberId}
            `;
              return existing[0] !== undefined
                ? Option.some(existing[0].secret_key)
                : Option.none();
            }),
          ),
        );
      },
    ),

    getAutomationCredential: Effect.fn("TeamGitHubRepository.getAutomationCredential")(
      function* (teamId) {
        return yield* wrap(
          "getAutomationCredential",
          sql<AutomationCredentialRow>`
          SELECT team_id, auth_method, github_login, github_name, github_email,
                 api_base_url, secret_key, updated_by_member_id, connected_at, updated_at
          FROM team_github_automation_credentials
          WHERE team_id = ${teamId}
          LIMIT 1
        `.pipe(
            Effect.map((rows) =>
              rows[0] !== undefined ? Option.some(mapAutomationRow(rows[0])) : Option.none(),
            ),
          ),
        );
      },
    ),

    upsertAutomationCredential: Effect.fn("TeamGitHubRepository.upsertAutomationCredential")(
      function* (record) {
        return yield* wrap(
          "upsertAutomationCredential",
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO team_github_automation_credentials (
                  team_id, auth_method, github_login, github_name, github_email,
                  api_base_url, secret_key, updated_by_member_id, connected_at, updated_at
                )
                VALUES (
                  ${record.teamId},
                  ${record.authMethod},
                  ${record.githubLogin},
                  ${record.githubName},
                  ${record.githubEmail},
                  ${record.apiBaseUrl},
                  ${record.secretKey},
                  ${record.updatedByMemberId},
                  ${record.connectedAt},
                  ${record.updatedAt}
                )
                ON CONFLICT(team_id) DO UPDATE SET
                  auth_method = excluded.auth_method,
                  github_login = excluded.github_login,
                  github_name = excluded.github_name,
                  github_email = excluded.github_email,
                  api_base_url = excluded.api_base_url,
                  secret_key = excluded.secret_key,
                  updated_by_member_id = excluded.updated_by_member_id,
                  updated_at = excluded.updated_at
              `;
              const rows = yield* sql<AutomationCredentialRow>`
                SELECT team_id, auth_method, github_login, github_name, github_email,
                       api_base_url, secret_key, updated_by_member_id, connected_at, updated_at
                FROM team_github_automation_credentials
                WHERE team_id = ${record.teamId}
                LIMIT 1
              `;
              return rows[0] !== undefined ? mapAutomationRow(rows[0]) : record;
            }),
          ),
        );
      },
    ),

    deleteAutomationCredential: Effect.fn("TeamGitHubRepository.deleteAutomationCredential")(
      function* (teamId) {
        return yield* wrap(
          "deleteAutomationCredential",
          sql.withTransaction(
            Effect.gen(function* () {
              const existing = yield* sql<{ readonly secret_key: string }>`
                SELECT secret_key FROM team_github_automation_credentials WHERE team_id = ${teamId} LIMIT 1
              `;
              yield* sql`
                DELETE FROM team_github_automation_credentials WHERE team_id = ${teamId}
              `;
              return existing[0] !== undefined
                ? Option.some(existing[0].secret_key)
                : Option.none();
            }),
          ),
        );
      },
    ),

    getGitHubAppConfig: Effect.fn("TeamGitHubRepository.getGitHubAppConfig")(function* (teamId) {
      return yield* wrap(
        "getGitHubAppConfig",
        sql<GitHubAppConfigRow>`
          SELECT team_id, mode, client_id, web_base_url, api_base_url, scopes,
                 enabled, client_secret_key, updated_by_member_id, updated_at
          FROM team_github_app_config
          WHERE team_id = ${teamId}
          LIMIT 1
        `.pipe(
          Effect.map((rows) =>
            rows[0] !== undefined ? Option.some(mapAppConfigRow(rows[0])) : Option.none(),
          ),
        ),
      );
    }),

    upsertGitHubAppConfig: Effect.fn("TeamGitHubRepository.upsertGitHubAppConfig")(
      function* (record) {
        return yield* wrap(
          "upsertGitHubAppConfig",
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO team_github_app_config (
                  team_id, mode, client_id, web_base_url, api_base_url, scopes,
                  enabled, client_secret_key, updated_by_member_id, updated_at
                )
                VALUES (
                  ${record.teamId},
                  ${record.mode},
                  ${record.clientId},
                  ${record.webBaseUrl},
                  ${record.apiBaseUrl},
                  ${record.scopes},
                  ${record.enabled ? 1 : 0},
                  ${record.clientSecretKey},
                  ${record.updatedByMemberId},
                  ${record.updatedAt}
                )
                ON CONFLICT(team_id) DO UPDATE SET
                  mode = excluded.mode,
                  client_id = excluded.client_id,
                  web_base_url = excluded.web_base_url,
                  api_base_url = excluded.api_base_url,
                  scopes = excluded.scopes,
                  enabled = excluded.enabled,
                  client_secret_key = excluded.client_secret_key,
                  updated_by_member_id = excluded.updated_by_member_id,
                  updated_at = excluded.updated_at
              `;
              const rows = yield* sql<GitHubAppConfigRow>`
                SELECT team_id, mode, client_id, web_base_url, api_base_url, scopes,
                       enabled, client_secret_key, updated_by_member_id, updated_at
                FROM team_github_app_config
                WHERE team_id = ${record.teamId}
                LIMIT 1
              `;
              return rows[0] !== undefined ? mapAppConfigRow(rows[0]) : record;
            }),
          ),
        );
      },
    ),

    deleteGitHubAppConfig: Effect.fn("TeamGitHubRepository.deleteGitHubAppConfig")(
      function* (teamId) {
        return yield* wrap(
          "deleteGitHubAppConfig",
          sql.withTransaction(
            Effect.gen(function* () {
              const existing = yield* sql<{ readonly client_secret_key: string | null }>`
                SELECT client_secret_key FROM team_github_app_config WHERE team_id = ${teamId} LIMIT 1
              `;
              yield* sql`
                DELETE FROM team_github_app_config WHERE team_id = ${teamId}
              `;
              return existing[0] !== undefined
                ? Option.some({ clientSecretKey: existing[0].client_secret_key })
                : Option.none();
            }),
          ),
        );
      },
    ),
  });
});

export const layer = Layer.effect(TeamGitHubRepository, make);
