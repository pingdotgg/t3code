import * as NodeOS from "node:os";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { isPlatformErrorLike } from "../platformError.ts";

const CodexAuthJsonSchema = Schema.Struct({
  tokens: Schema.Struct({
    account_id: Schema.String,
  }),
});

const ClaudeJsonSchema = Schema.Struct({
  userID: Schema.String,
});

export const TelemetryIdentitySource = Schema.Literals(["codex", "claude", "anonymous"]);
export type TelemetryIdentitySource = typeof TelemetryIdentitySource.Type;

export class TelemetryIdentityReadError extends Schema.TaggedErrorClass<TelemetryIdentityReadError>()(
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

export class TelemetryIdentityDecodeError extends Schema.TaggedErrorClass<TelemetryIdentityDecodeError>()(
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

export class TelemetryAnonymousIdGenerationError extends Schema.TaggedErrorClass<TelemetryAnonymousIdGenerationError>()(
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

export class TelemetryAnonymousIdPersistenceError extends Schema.TaggedErrorClass<TelemetryAnonymousIdPersistenceError>()(
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

export class TelemetryIdentityHashError extends Schema.TaggedErrorClass<TelemetryIdentityHashError>()(
  "TelemetryIdentityHashError",
  {
    source: TelemetryIdentitySource,
    algorithm: Schema.Literal("SHA-256"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to hash ${this.source} telemetry identity with ${this.algorithm}.`;
  }
}

type TelemetryIdentityError =
  | TelemetryIdentityReadError
  | TelemetryIdentityDecodeError
  | TelemetryAnonymousIdGenerationError
  | TelemetryAnonymousIdPersistenceError
  | TelemetryIdentityHashError;

const decodeCodexAuthJson = Schema.decodeEffect(Schema.fromJsonString(CodexAuthJsonSchema));
const decodeClaudeJson = Schema.decodeEffect(Schema.fromJsonString(ClaudeJsonSchema));

function isNotFoundError(error: PlatformError.PlatformError): boolean {
  return error.reason._tag === "NotFound";
}

const getTelemetryIdentityCauseAnnotations = (cause: unknown) => {
  if (isPlatformErrorLike(cause)) {
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
    Effect.map(Option.some),
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

const hash = (source: TelemetryIdentitySource, value: string) =>
  Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.digest("SHA-256", new TextEncoder().encode(value))),
    Effect.map(Encoding.encodeHex),
    Effect.mapError(
      (cause) =>
        new TelemetryIdentityHashError({
          source,
          algorithm: "SHA-256",
          cause,
        }),
    ),
  );

const getCodexAccountId = Effect.fn("TelemetryIdentity.getCodexAccountId")(function* (
  homeDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const authJsonPath = path.join(homeDirectory, ".codex", "auth.json");
  const encoded = yield* readIdentityFile(fileSystem, "codex", authJsonPath);
  if (Option.isNone(encoded)) {
    return Option.none<string>();
  }
  const authJson = yield* decodeCodexAuthJson(encoded.value).pipe(
    Effect.mapError(
      (cause) =>
        new TelemetryIdentityDecodeError({
          source: "codex",
          filePath: authJsonPath,
          cause,
        }),
    ),
  );

  return Option.some(authJson.tokens.account_id);
});

const getClaudeUserId = Effect.fn("TelemetryIdentity.getClaudeUserId")(function* (
  homeDirectory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const claudeJsonPath = path.join(homeDirectory, ".claude.json");
  const encoded = yield* readIdentityFile(fileSystem, "claude", claudeJsonPath);
  if (Option.isNone(encoded)) {
    return Option.none<string>();
  }
  const claudeJson = yield* decodeClaudeJson(encoded.value).pipe(
    Effect.mapError(
      (cause) =>
        new TelemetryIdentityDecodeError({
          source: "claude",
          filePath: claudeJsonPath,
          cause,
        }),
    ),
  );

  return Option.some(claudeJson.userID);
});

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig.ServerConfig;

  const existing = yield* readIdentityFile(fileSystem, "anonymous", anonymousIdPath);
  if (Option.isSome(existing)) {
    return existing.value;
  }

  const anonymousId = yield* Crypto.Crypto.pipe(
    Effect.flatMap((crypto) => crypto.randomUUIDv4),
    Effect.mapError(
      (cause) =>
        new TelemetryAnonymousIdGenerationError({
          source: "anonymous",
          filePath: anonymousIdPath,
          cause,
        }),
    ),
  );
  yield* fileSystem.writeFileString(anonymousIdPath, anonymousId).pipe(
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

/**
 * getTelemetryIdentifier - Users are "identified" by finding the first match of the following, then hashing the value.
 * 1. ~/.codex/auth.json tokens.account_id
 * 2. ~/.claude.json userID
 * 3. ~/.t3/telemetry/anonymous-id
 */
export const getTelemetryIdentifierForHome = Effect.fn("getTelemetryIdentifierForHome")(
  function* (homeDirectory: string) {
    const codexAccountId = yield* getCodexAccountId(homeDirectory).pipe(
      Effect.catchTags({
        TelemetryIdentityReadError: (error) =>
          logTelemetryIdentityError(error).pipe(Effect.as(Option.none<string>())),
        TelemetryIdentityDecodeError: (error) =>
          logTelemetryIdentityError(error).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isSome(codexAccountId)) {
      return yield* hash("codex", codexAccountId.value);
    }

    const claudeUserId = yield* getClaudeUserId(homeDirectory).pipe(
      Effect.catchTags({
        TelemetryIdentityReadError: (error) =>
          logTelemetryIdentityError(error).pipe(Effect.as(Option.none<string>())),
        TelemetryIdentityDecodeError: (error) =>
          logTelemetryIdentityError(error).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isSome(claudeUserId)) {
      return yield* hash("claude", claudeUserId.value);
    }

    const anonymousId = yield* upsertAnonymousId.pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        TelemetryIdentityReadError: (error) =>
          logTelemetryIdentityError(error).pipe(Effect.as(Option.none<string>())),
        TelemetryAnonymousIdGenerationError: (error) =>
          logTelemetryIdentityError(error).pipe(Effect.as(Option.none<string>())),
        TelemetryAnonymousIdPersistenceError: (error) =>
          logTelemetryIdentityError(error).pipe(Effect.as(Option.none<string>())),
      }),
    );
    if (Option.isSome(anonymousId)) {
      return yield* hash("anonymous", anonymousId.value);
    }

    return null;
  },
  Effect.tapError(logTelemetryIdentityError),
  Effect.orElseSucceed(() => null),
);

export const getTelemetryIdentifier = Effect.suspend(() =>
  getTelemetryIdentifierForHome(NodeOS.homedir()),
);
