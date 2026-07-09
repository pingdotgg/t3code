/**
 * Fugu home bootstrap — ensure a dedicated CODEX_HOME for Sakana Fugu.
 *
 * The `codex-fugu` wrapper cannot run `app-server` (Codex rejects `--profile`
 * for that subcommand). SergeCode therefore spawns the real `codex` binary
 * with CODEX_HOME pointed at a Fugu-specific home containing:
 *   - profile keys (model / reasoning / sakana provider / catalog path)
 *   - `[model_providers.sakana]` block with `env_key = "SAKANA_API_KEY"`
 *
 * We never overwrite an existing `config.toml`. Catalog lives at
 * `~/.codex/fugu.json` (installed by codex-fugu); if missing, probe fails
 * with a clear install hint.
 *
 * @module provider/Drivers/FuguHome
 */
import type { FuguSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../../pathExpansion.ts";

export const DEFAULT_FUGU_HOME_PATH = "~/.codex/fugu-home";
export const FUGU_MODEL_CATALOG_PATH = "~/.codex/fugu.json";

export class FuguHomeError extends Schema.TaggedErrorClass<FuguHomeError>()("FuguHomeError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export type EnsureFuguHomeOptions = {
  /** Override catalog path (absolute or `~`-prefixed). Defaults to ~/.codex/fugu.json. */
  readonly catalogPath?: string;
};

/**
 * Build the exact CODEX_HOME `config.toml` contents for a Fugu home.
 * `catalogPath` must already be an absolute filesystem path (tilde-expanded).
 */
export function buildFuguConfigToml(catalogPath: string): string {
  return [
    `model = "fugu-ultra"`,
    `model_reasoning_effort = "xhigh"`,
    `model_provider = "sakana"`,
    `model_catalog_json = "${catalogPath}"`,
    ``,
    `[model_providers.sakana]`,
    `name = "Sakana API"`,
    `base_url = "https://api.sakana.ai/v1"`,
    `env_key = "SAKANA_API_KEY"`,
    `wire_api = "responses"`,
    `stream_idle_timeout_ms = 7_200_000`,
    `stream_max_retries = 5`,
    `request_max_retries = 4`,
    ``,
  ].join("\n");
}

export function resolveFuguHomePath(homePath: string): string {
  const trimmed = homePath.trim();
  const value = trimmed.length > 0 ? trimmed : DEFAULT_FUGU_HOME_PATH;
  return expandHomePath(value);
}

export function resolveFuguModelCatalogPath(catalogPath?: string): string {
  return expandHomePath(catalogPath?.trim() || FUGU_MODEL_CATALOG_PATH);
}

/**
 * Ensure the Fugu CODEX_HOME exists with a valid config.toml when missing.
 *
 * - Creates the home directory if needed.
 * - Writes config.toml only when it does not already exist (never clobbers).
 * - Fails when the model catalog is absent so the user installs codex-fugu.
 */
export const ensureFuguHome = Effect.fn("ensureFuguHome")(function* (
  config: Pick<FuguSettings, "homePath">,
  options?: EnsureFuguHomeOptions,
): Effect.fn.Return<string, FuguHomeError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolvedHomePath = path.resolve(resolveFuguHomePath(config.homePath));
  const catalogPath = path.resolve(resolveFuguModelCatalogPath(options?.catalogPath));
  const configTomlPath = path.join(resolvedHomePath, "config.toml");

  const catalogExists = yield* fileSystem.exists(catalogPath).pipe(
    Effect.mapError(
      (cause) =>
        new FuguHomeError({
          detail: `Failed to check Fugu model catalog at ${catalogPath}.`,
          cause,
        }),
    ),
  );
  if (!catalogExists) {
    return yield* new FuguHomeError({
      detail: `Fugu model catalog not found at ${catalogPath}. Install codex-fugu first so the Sakana model catalog is available.`,
    });
  }

  yield* fileSystem.makeDirectory(resolvedHomePath, { recursive: true }).pipe(
    Effect.mapError(
      (cause) =>
        new FuguHomeError({
          detail: `Failed to create Fugu CODEX_HOME at ${resolvedHomePath}.`,
          cause,
        }),
    ),
  );

  const configExists = yield* fileSystem.exists(configTomlPath).pipe(
    Effect.mapError(
      (cause) =>
        new FuguHomeError({
          detail: `Failed to check Fugu config.toml at ${configTomlPath}.`,
          cause,
        }),
    ),
  );
  if (!configExists) {
    yield* fileSystem.writeFileString(configTomlPath, buildFuguConfigToml(catalogPath)).pipe(
      Effect.mapError(
        (cause) =>
          new FuguHomeError({
            detail: `Failed to write Fugu config.toml at ${configTomlPath}.`,
            cause,
          }),
      ),
    );
  }

  return resolvedHomePath;
});
