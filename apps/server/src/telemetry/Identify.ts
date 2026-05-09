import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as Crypto from "node:crypto";
import { homedir } from "node:os";
import { ServerConfig } from "../config.ts";

const CodexAuthJsonSchema = Schema.Struct({
  tokens: Schema.Struct({
    account_id: Schema.String,
  }),
});

const ClaudeJsonSchema = Schema.Struct({
  userID: Schema.String,
});

class IdentifyUserError extends Schema.TaggedErrorClass<IdentifyUserError>()("IdentifyUserError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect),
}) {}

const hash = (value: string) =>
  Effect.try({
    try: () => Crypto.createHash("sha256").update(value).digest("hex"),
    catch: (error) =>
      new IdentifyUserError({
        message: "Failed to hash identifier",
        cause: error,
      }),
  });

const getCodexAccountId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const authJsonPath = path.join(homedir(), ".codex", "auth.json");
  const authJson = yield* Effect.flatMap(
    fileSystem.readFileString(authJsonPath),
    Schema.decodeEffect(Schema.fromJsonString(CodexAuthJsonSchema)),
  );

  return authJson.tokens.account_id;
});

const getClaudeUserId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const claudeJsonPath = path.join(homedir(), ".claude.json");
  const claudeJson = yield* Effect.flatMap(
    fileSystem.readFileString(claudeJsonPath),
    Schema.decodeEffect(Schema.fromJsonString(ClaudeJsonSchema)),
  );

  return claudeJson.userID;
});

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const { anonymousIdPath } = yield* ServerConfig;

  const anonymousId = yield* fileSystem.readFileString(anonymousIdPath).pipe(
    Effect.catch(() =>
      Effect.gen(function* () {
        const randomId = yield* Random.nextUUIDv4;
        yield* fileSystem.writeFileString(anonymousIdPath, randomId);
        return randomId;
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
export const getTelemetryIdentifier = Effect.gen(function* () {
  const codexAccountId = yield* Effect.result(getCodexAccountId);
  if (codexAccountId._tag === "Success") {
    return yield* hash(codexAccountId.success);
  }

  const claudeUserId = yield* Effect.result(getClaudeUserId);
  if (claudeUserId._tag === "Success") {
    return yield* hash(claudeUserId.success);
  }

  const anonymousId = yield* Effect.result(upsertAnonymousId);
  if (anonymousId._tag === "Success") {
    return yield* hash(anonymousId.success);
  }

  return null;
}).pipe(
  Effect.tapError((error) => Effect.logWarning("Failed to get identifier", { cause: error })),
  Effect.orElseSucceed(() => null),
);
