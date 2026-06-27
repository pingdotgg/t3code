import type { JiraApiAuth } from "@t3tools/integrations-atlassian";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { ServerConfig } from "./config.ts";
import { toAtlassianError } from "./t3work-atlassian-http.ts";
import { t3workRandomUUID } from "./t3work-random.ts";

export type PersistedAtlassianAuths = {
  readonly version: 1;
  readonly auths: ReadonlyArray<{
    readonly accountId: string;
    readonly auth: JiraApiAuth;
  }>;
};

const ATLASSIAN_AUTH_SECRET_NAME = "t3work-atlassian-auths";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const PersistedJiraApiAuth = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("oauth"),
    cloudId: Schema.String,
    siteUrl: Schema.optional(Schema.String),
    accessToken: Schema.String,
    refreshToken: Schema.optional(Schema.String),
    expiresAt: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    kind: Schema.Literal("basic"),
    siteUrl: Schema.String,
    email: Schema.String,
    apiToken: Schema.String,
  }),
]);

const PersistedAtlassianAuths = Schema.Struct({
  version: Schema.Literal(1),
  auths: Schema.Array(
    Schema.Struct({
      accountId: Schema.String,
      auth: PersistedJiraApiAuth,
    }),
  ),
});
const PersistedAtlassianAuthsJson = fromJsonStringPretty(PersistedAtlassianAuths);
const decodePersistedAtlassianAuths = Schema.decodeEffect(PersistedAtlassianAuthsJson);
const encodePersistedAtlassianAuths = Schema.encodeEffect(PersistedAtlassianAuthsJson);

const atlassianAuthSecretPath = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  yield* fileSystem
    .makeDirectory(serverConfig.secretsDir, { recursive: true })
    .pipe(Effect.mapError(toAtlassianError("Failed to prepare Atlassian settings directory.")));
  yield* fileSystem
    .chmod(serverConfig.secretsDir, 0o700)
    .pipe(Effect.mapError(toAtlassianError("Failed to secure Atlassian settings directory.")));
  return path.join(serverConfig.secretsDir, `${ATLASSIAN_AUTH_SECRET_NAME}.bin`);
});

export const loadPersistedAtlassianAuthsPayload = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const secretPath = yield* atlassianAuthSecretPath;
  const persisted = yield* fileSystem.readFile(secretPath).pipe(
    Effect.map((bytes) => Uint8Array.from(bytes)),
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed(null)
        : Effect.fail(toAtlassianError("Failed to load persisted Atlassian settings.")(cause)),
    ),
  );
  if (!persisted) return null;

  return yield* decodePersistedAtlassianAuths(textDecoder.decode(persisted)).pipe(
    Effect.mapError(toAtlassianError("Failed to parse persisted Atlassian settings.")),
  );
});

export function savePersistedAtlassianAuthsPayload(payload: PersistedAtlassianAuths) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const secretPath = yield* atlassianAuthSecretPath;
    const encoded = yield* encodePersistedAtlassianAuths(payload).pipe(
      Effect.mapError(toAtlassianError("Failed to encode Atlassian settings.")),
    );
    const tempPath = `${secretPath}.${t3workRandomUUID()}.tmp`;
    yield* Effect.gen(function* () {
      yield* fileSystem.writeFile(tempPath, textEncoder.encode(encoded));
      yield* fileSystem.chmod(tempPath, 0o600);
      yield* fileSystem.rename(tempPath, secretPath);
      yield* fileSystem.chmod(secretPath, 0o600);
    }).pipe(
      Effect.catch((cause) =>
        fileSystem.remove(tempPath).pipe(
          Effect.ignore,
          Effect.flatMap(() =>
            Effect.fail(toAtlassianError("Failed to persist Atlassian settings.")(cause)),
          ),
        ),
      ),
    );
  });
}
