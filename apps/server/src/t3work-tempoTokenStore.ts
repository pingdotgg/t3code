/**
 * Tempo API token store (see t3work-tempo.ts for the capacity integration).
 *
 * Token: `T3WORK_TEMPO_API_TOKEN` env var, else a persisted secret alongside
 * the Atlassian credentials (set via the /api/t3work/tempo/token route).
 */

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { ServerConfig } from "./config.ts";
import { toAtlassianError } from "./t3work-atlassian-http.ts";

const TEMPO_TOKEN_SECRET_NAME = "t3work-tempo-token";

const tempoTokenSecretPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  return path.join(serverConfig.secretsDir, `${TEMPO_TOKEN_SECRET_NAME}.bin`);
});

export const loadTempoToken = Effect.gen(function* () {
  const envToken = process.env["T3WORK_TEMPO_API_TOKEN"]?.trim();
  if (envToken) return envToken;
  const fileSystem = yield* FileSystem.FileSystem;
  const secretPath = yield* tempoTokenSecretPath;
  const persisted = yield* fileSystem.readFileString(secretPath).pipe(
    Effect.catch((cause) =>
      cause.reason._tag === "NotFound"
        ? Effect.succeed(null)
        : Effect.fail(toAtlassianError("Failed to load the persisted Tempo token.")(cause)),
    ),
  );
  const token = persisted?.trim();
  return token && token.length > 0 ? token : null;
});

export function saveTempoToken(token: string | null) {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const serverConfig = yield* ServerConfig;
    const secretPath = yield* tempoTokenSecretPath;
    if (!token || token.trim().length === 0) {
      yield* fileSystem
        .remove(secretPath)
        .pipe(Effect.catch(() => Effect.void));
      return;
    }
    yield* fileSystem
      .makeDirectory(serverConfig.secretsDir, { recursive: true })
      .pipe(Effect.mapError(toAtlassianError("Failed to prepare the secrets directory.")));
    yield* fileSystem
      .writeFileString(secretPath, token.trim())
      .pipe(Effect.mapError(toAtlassianError("Failed to persist the Tempo token.")));
    yield* fileSystem
      .chmod(secretPath, 0o600)
      .pipe(Effect.mapError(toAtlassianError("Failed to secure the Tempo token.")));
  });
}
