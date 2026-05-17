import {
  AcpRegistryInstallState,
  type AcpRegistryInstallState as AcpRegistryInstallStateType,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";

const MANIFEST_FILENAME = "installs.json";

export const InstallManifestSchema = Schema.Record(Schema.String, AcpRegistryInstallState);
const InstallManifestJsonSchema = Schema.fromJsonString(InstallManifestSchema);
const decodeInstallManifestJson = Schema.decodeUnknownEffect(InstallManifestJsonSchema);
const encodeInstallManifestJson = Schema.encodeEffect(InstallManifestJsonSchema);

export type InstallManifest = Readonly<Record<string, AcpRegistryInstallStateType>>;

export class InstallManifestError extends Data.TaggedError("InstallManifestError")<{
  readonly detail: string;
  readonly cause?: unknown;
}> {}

const getManifestPath: Effect.Effect<string, never, ServerConfig> = Effect.gen(function* () {
  const config = yield* ServerConfig;
  return `${config.acpRegistryCacheDir}/${MANIFEST_FILENAME}`;
});

const readManifestFile: Effect.Effect<
  InstallManifest | null,
  InstallManifestError | PlatformError.PlatformError,
  ServerConfig | FileSystem.FileSystem
> = Effect.gen(function* () {
  const manifestPath = yield* getManifestPath;
  const fs = yield* FileSystem.FileSystem;

  const exists = yield* fs.exists(manifestPath);
  if (!exists) {
    return null;
  }

  const content = yield* fs
    .readFileString(manifestPath)
    .pipe(
      Effect.mapError(
        (cause) => new InstallManifestError({ detail: "Failed to read install manifest", cause }),
      ),
    );

  return yield* decodeInstallManifestJson(content).pipe(
    Effect.mapError(
      (cause) =>
        new InstallManifestError({
          detail: "Invalid install manifest",
          cause,
        }),
    ),
  );
});

export const readInstalls: Effect.Effect<
  InstallManifest,
  InstallManifestError | PlatformError.PlatformError,
  ServerConfig | ServerSettingsService | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const manifest = yield* readManifestFile;

  if (manifest !== null) {
    return manifest;
  }

  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(
    Effect.mapError(
      (cause) =>
        new InstallManifestError({ detail: "Failed to read settings for migration", cause }),
    ),
  );

  const settingsInstalls = settings.acpRegistryInstalls;
  if (!settingsInstalls || Object.keys(settingsInstalls).length === 0) {
    return {};
  }

  const migrationExit = yield* Effect.exit(writeInstalls(settingsInstalls));
  if (migrationExit._tag === "Failure") {
    const error = Cause.squash(migrationExit.cause);
    const detail = error instanceof InstallManifestError ? error.detail : "Unknown migration error";
    yield* Effect.logWarning(`Failed to migrate installs to manifest: ${detail}`);
    return settingsInstalls;
  }

  // Cleanup: clear stale settings.json entries after successful migration
  yield* settingsService.updateSettings({ acpRegistryInstalls: {} }).pipe(
    Effect.asVoid,
    Effect.mapError(
      (cause) =>
        new InstallManifestError({
          detail: "Failed to cleanup stale settings after migration",
          cause,
        }),
    ),
  );
  yield* Effect.logInfo(
    "Migrated ACP registry installs from settings.json to manifest and cleaned up stale entries",
  );

  return settingsInstalls;
});

export const writeInstalls: (
  installs: InstallManifest,
) => Effect.Effect<void, InstallManifestError, ServerConfig | FileSystem.FileSystem | Path.Path> = (
  installs,
) =>
  Effect.gen(function* () {
    const manifestPath = yield* getManifestPath;

    const content = yield* encodeInstallManifestJson(installs).pipe(
      Effect.mapError(
        (cause) =>
          new InstallManifestError({
            detail: "Failed to encode install manifest",
            cause,
          }),
      ),
    );

    yield* writeFileStringAtomically({
      filePath: manifestPath,
      contents: content,
    }).pipe(
      Effect.mapError(
        (cause) => new InstallManifestError({ detail: "Failed to write install manifest", cause }),
      ),
    );
  });

export const getInstallState: (
  agentId: string,
) => Effect.Effect<
  AcpRegistryInstallStateType | undefined,
  InstallManifestError | PlatformError.PlatformError,
  ServerConfig | ServerSettingsService | FileSystem.FileSystem | Path.Path
> = (agentId) => Effect.map(readInstalls, (installs) => installs[agentId]);

export const setInstallState: (
  agentId: string,
  state: AcpRegistryInstallStateType | null,
) => Effect.Effect<
  void,
  InstallManifestError | PlatformError.PlatformError,
  ServerConfig | ServerSettingsService | FileSystem.FileSystem | Path.Path
> = (agentId, state) =>
  Effect.gen(function* () {
    const installs = yield* readInstalls;

    if (state === null) {
      const { [agentId]: _, ...rest } = installs;
      yield* writeInstalls(rest);
    } else {
      yield* writeInstalls({ ...installs, [agentId]: state });
    }
  });
