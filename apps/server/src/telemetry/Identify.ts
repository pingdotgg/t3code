import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { CLOUD_LINKED_USER_ID } from "../cloud/config.ts";
import * as ServerConfig from "../config.ts";

/**
 * Codex writes `tokens` only for ChatGPT logins and omits the key for API-key,
 * agent-identity, and personal-access-token logins, so its absence is a
 * supported install and not a malformed file. `account_id` is the ChatGPT
 * workspace, which a whole Team shares; the `id_token` names the person.
 */
const CodexAuthJsonSchema = Schema.Struct({
  tokens: Schema.optionalKey(
    Schema.Struct({
      account_id: Schema.String,
      id_token: Schema.optionalKey(Schema.String),
    }),
  ),
});

/** `userID` is random per machine. `oauthAccount` is present only while Claude Code is logged in. */
const ClaudeJsonSchema = Schema.Struct({
  userID: Schema.optionalKey(Schema.String),
  oauthAccount: Schema.optionalKey(
    Schema.Struct({
      accountUuid: Schema.optionalKey(Schema.String),
    }),
  ),
});

// `sub` names the login method (`google-oauth2|…`), so one person can have several.
// `user_id` (`user-…`) is the OpenAI account and is the same for every login.
const IdTokenClaims = Schema.Struct({
  "https://api.openai.com/auth": Schema.Struct({ user_id: Schema.NonEmptyString }),
});
const decodeIdTokenClaims = Schema.decodeUnknownOption(Schema.fromJsonString(IdTokenClaims));

/**
 * Who an install belongs to, from strongest to weakest. `connect` is the T3
 * Connect account. `openai` and `claude` are provider accounts. `device` is a
 * client device that connected.
 */
export const TelemetryOwnerSource = Schema.Literals(["connect", "openai", "claude", "device"]);
export type TelemetryOwnerSource = typeof TelemetryOwnerSource.Type;

export interface TelemetryOwner {
  readonly source: TelemetryOwnerSource;
  /** `hashTelemetryId` of the source's raw id. */
  readonly ownerId: string;
}

export const TelemetryIdentitySource = Schema.Literals(["codex", "claude", "anonymous"]);
export type TelemetryIdentitySource = typeof TelemetryIdentitySource.Type;

class TelemetryIdentityReadError extends Schema.TaggedError<TelemetryIdentityReadError>()(
  "TelemetryIdentityReadError",
  {
    source: TelemetryIdentitySource,
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read ${this.source} telemetry identity at '${this.filePath}'.`;
  }
}

class TelemetryIdentityDecodeError extends Schema.TaggedError<TelemetryIdentityDecodeError>()(
  "TelemetryIdentityDecodeError",
  {
    source: Schema.Literals(["codex", "claude"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to decode ${this.source} telemetry identity at '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdGenerationError extends Schema.TaggedError<TelemetryAnonymousIdGenerationError>()(
  "TelemetryAnonymousIdGenerationError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to generate anonymous telemetry identity for '${this.filePath}'.`;
  }
}

export class TelemetryAnonymousIdPersistenceError extends Schema.TaggedError<TelemetryAnonymousIdPersistenceError>()(
  "TelemetryAnonymousIdPersistenceError",
  {
    source: Schema.Literal("anonymous"),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to persist anonymous telemetry identity at '${this.filePath}'.`;
  }
}

type TelemetryIdentityError =
  | TelemetryIdentityReadError
  | TelemetryIdentityDecodeError
  | TelemetryAnonymousIdGenerationError
  | TelemetryAnonymousIdPersistenceError;

const decodeCodexAuthJson = Schema.decodeEffect(Schema.fromJsonString(CodexAuthJsonSchema));
const decodeClaudeJson = Schema.decodeEffect(Schema.fromJsonString(ClaudeJsonSchema));

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

const getTelemetryIdentityCauseAnnotations = (cause: unknown) => {
  if (cause instanceof PlatformError.PlatformError) {
    return {
      causeKind: "platform",
      platformReason: cause.reason._tag,
    };
  }
  if (cause instanceof Schema.SchemaError) {
    return { causeKind: "schema" };
  }
  return { causeKind: "other" };
};

const logTelemetryIdentityError = (error: TelemetryIdentityError) =>
  Effect.logWarning(error.message).pipe(
    Effect.annotateLogs({
      errorTag: error._tag,
      source: error.source,
      ...("filePath" in error ? { filePath: error.filePath } : {}),
      ...getTelemetryIdentityCauseAnnotations(error.cause),
      ...(error.stack === undefined ? {} : { errorStack: error.stack }),
    }),
  );

const readIdentityFile = (
  fileSystem: FileSystem.FileSystem,
  source: TelemetryIdentitySource,
  filePath: string,
) =>
  fileSystem.readFileString(filePath).pipe(
    Effect.asSome,
    Effect.catchTags({
      PlatformError: (cause) =>
        isNotFoundError(cause)
          ? Effect.succeed(Option.none<string>())
          : Effect.fail(
              new TelemetryIdentityReadError({
                source,
                filePath,
                cause,
              }),
            ),
    }),
  );

/**
 * The OpenAI account id in a ChatGPT id_token, read without verifying it:
 * analytics needs only a stable id. Codex CLI and T3's own sign-in both use it.
 */
export const openAiUserId = (idToken: string) => {
  const payload = Base64Url.decodeString(idToken.split(".")[1] ?? "");
  return Result.isSuccess(payload)
    ? Option.map(
        decodeIdTokenClaims(payload.success),
        (claims) => claims["https://api.openai.com/auth"].user_id,
      )
    : Option.none<string>();
};

const readJsonIdentityFile = Effect.fn("TelemetryIdentity.readJsonIdentityFile")(function* <A>(
  source: "codex" | "claude",
  filePath: string,
  decode: (encoded: string) => Effect.Effect<A, Schema.SchemaError>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const encoded = yield* readIdentityFile(fileSystem, source, filePath);
  if (Option.isNone(encoded)) {
    return Option.none<A>();
  }
  return yield* decode(encoded.value).pipe(
    Effect.asSome,
    Effect.mapError((cause) => new TelemetryIdentityDecodeError({ source, filePath, cause })),
  );
});

// A missing or unreadable file only removes that owner; it never blocks the others.
const skipOnError = <A, R>(
  effect: Effect.Effect<
    Option.Option<A>,
    TelemetryIdentityReadError | TelemetryIdentityDecodeError,
    R
  >,
) =>
  effect.pipe(
    Effect.catch((error) => logTelemetryIdentityError(error).pipe(Effect.as(Option.none<A>()))),
  );

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig.ServerConfig;

  const existing = yield* readIdentityFile(fileSystem, "anonymous", anonymousIdPath);
  if (Option.isSome(existing)) {
    return existing.value;
  }

  const anonymousId = yield* Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4()),
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdGenerationError({
          source: "anonymous",
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );
  yield* writeFileStringAtomically({ filePath: anonymousIdPath, contents: anonymousId }).pipe(
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdPersistenceError({
          source: "anonymous",
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );

  return anonymousId;
});

const readProviderLogins = Effect.fn("TelemetryIdentity.readProviderLogins")(function* (
  homeDirectory: string,
) {
  const path = yield* Path.Path;
  const codexTokens = yield* readJsonIdentityFile(
    "codex",
    path.join(homeDirectory, ".codex", "auth.json"),
    decodeCodexAuthJson,
  ).pipe(
    skipOnError,
    Effect.map(Option.flatMap((authJson) => Option.fromUndefinedOr(authJson.tokens))),
  );
  const claudeJson = yield* readJsonIdentityFile(
    "claude",
    path.join(homeDirectory, ".claude.json"),
    decodeClaudeJson,
  ).pipe(skipOnError);
  return { codexTokens, claudeJson };
});

/**
 * `distinctId` keeps the rule every earlier build used, so analytics stay
 * continuous: the hashed Codex `account_id`, else the Claude machine `userID`,
 * else the install's anonymous id. It can change when someone logs in, and a
 * Codex Team shares one. `installId` is the hashed anonymous id, which never
 * changes for an install; count installs and people with it.
 *
 * A null `distinctId` turns telemetry off. A missing file falls through quietly,
 * and so does an API-key-only Codex auth.json. Only unreadable or malformed
 * files warn.
 */
export const getTelemetryIdentityForHome = Effect.fn("getTelemetryIdentityForHome")(function* (
  homeDirectory: string,
) {
  const { codexTokens, claudeJson } = yield* readProviderLogins(homeDirectory);
  const installId = yield* upsertAnonymousId.pipe(
    Effect.map(hashTelemetryId),
    Effect.catch((error) => logTelemetryIdentityError(error).pipe(Effect.as(null))),
  );
  const providerId = Option.orElse(
    Option.map(codexTokens, (tokens) => tokens.account_id),
    () => Option.flatMap(claudeJson, (json) => Option.fromUndefinedOr(json.userID)),
  );
  return {
    distinctId: Option.isSome(providerId) ? hashTelemetryId(providerId.value) : installId,
    installId,
  };
});

export const getTelemetryIdentity = Effect.flatMap(
  HostProcess.HomeDirectory,
  getTelemetryIdentityForHome,
);

/**
 * Owners the server can read without a client: the linked T3 Connect account
 * and the provider logins under `homeDirectory`. Clients add `connect` and
 * `device` owners when they connect.
 */
export const getServerOwnersForHome = Effect.fn("getServerOwnersForHome")(function* (
  homeDirectory: string,
) {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const connectUser = yield* secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.map(Option.map((bytes) => new TextDecoder().decode(bytes))),
    Effect.catch((cause) =>
      Effect.logWarning("Failed to read the linked T3 Connect account for telemetry", {
        errorTag: cause._tag,
      }).pipe(Effect.as(Option.none<string>())),
    ),
  );
  const { codexTokens, claudeJson } = yield* readProviderLogins(homeDirectory);

  const raw: ReadonlyArray<readonly [TelemetryOwnerSource, Option.Option<string>]> = [
    ["connect", connectUser],
    [
      "openai",
      Option.flatMap(codexTokens, (tokens) =>
        Option.flatMap(Option.fromUndefinedOr(tokens.id_token), openAiUserId),
      ),
    ],
    [
      "claude",
      Option.flatMap(claudeJson, (json) => Option.fromUndefinedOr(json.oauthAccount?.accountUuid)),
    ],
  ];
  return raw.flatMap(([source, value]): ReadonlyArray<TelemetryOwner> =>
    Option.isSome(value) && value.value.trim() !== ""
      ? [{ source, ownerId: hashTelemetryId(value.value) }]
      : [],
  );
});

export const getServerOwners = Effect.flatMap(HostProcess.HomeDirectory, getServerOwnersForHome);
