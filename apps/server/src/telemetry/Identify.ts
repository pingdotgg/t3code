import { Effect, FileSystem, Path, Random, Schema } from "effect";
import * as Crypto from "node:crypto";
import { homedir } from "node:os";

const CodexAuthJsonSchema = Schema.Struct({
  tokens: Schema.Struct({
    account_id: Schema.String,
  }),
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

const upsertAnonymousId = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const anonymousIdPath = path.join(homedir(), ".t3", "telemetry", "anonymous-id");
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
 * 2. ~/.t3/telemetry/anonymous-id
 */
export const getTelemetryIdentifier = Effect.gen(function* () {
  const codexAccountId = yield* getCodexAccountId;
  if (codexAccountId) {
    return yield* hash(codexAccountId);
  }

  const anonymousId = yield* upsertAnonymousId;
  if (anonymousId) {
    return yield* hash(anonymousId);
  }

  return null;
}).pipe(
  Effect.tapError((error) => Effect.logWarning("Failed to get identifier", { cause: error })),
  Effect.orElseSucceed(() => null),
);
