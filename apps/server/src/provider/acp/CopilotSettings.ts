import * as os from "node:os";

import type { ServerProviderModel } from "@t3tools/contracts";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { Effect, FileSystem, Path, Result, Schema } from "effect";

export interface CopilotConfigReadWarning {
  readonly path: string;
  readonly message: string;
}

export interface CopilotConfigFile {
  readonly path: string;
  readonly raw: Readonly<Record<string, unknown>>;
  readonly model: string | undefined;
}

export interface CopilotAuthUser {
  readonly login: string;
  readonly host: string;
}

export interface CopilotMergedSettings {
  readonly userConfig: CopilotConfigFile | undefined;
  readonly projectConfig: CopilotConfigFile | undefined;
  readonly model: string | undefined;
  readonly warnings: ReadonlyArray<CopilotConfigReadWarning>;
  /** Authenticated user extracted from ~/.copilot/config.json, if present. */
  readonly auth: CopilotAuthUser | undefined;
}

export interface CopilotConfigPaths {
  readonly userConfigPath: string;
  readonly projectConfigPath: string;
}

export interface ReadCopilotMergedSettingsInput {
  readonly cwd: string;
  readonly homeDir?: string | null;
}

const CONFIG_DIRECTORY = ".copilot";
const CONFIG_FILE = "config.json";

type JsonRecord = Record<string, unknown>;

const LenientJsonUnknown = fromLenientJson(Schema.Unknown);
const decodeLenientJsonUnknown = Schema.decodeUnknownSync(LenientJsonUnknown);

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  return value.trim() || undefined;
}

function normalizeModel(value: unknown): string | undefined {
  return normalizeNonEmptyString(value);
}

export function extractCopilotConfiguredModel(
  config: Readonly<Record<string, unknown>> | null | undefined,
): string | undefined {
  if (!config) {
    return undefined;
  }

  const directModel = normalizeModel(config.model);
  if (directModel) {
    return directModel;
  }

  if (!isJsonRecord(config.model)) {
    return undefined;
  }

  return (
    normalizeModel(config.model.id) ??
    normalizeModel(config.model.slug) ??
    normalizeModel(config.model.name)
  );
}

function parseConfigFile(
  path: string,
  contents: string,
): CopilotConfigFile | CopilotConfigReadWarning {
  let parsed: unknown;
  try {
    parsed = decodeLenientJsonUnknown(contents);
  } catch (error) {
    return {
      path,
      message: `GitHub Copilot config is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!isJsonRecord(parsed)) {
    return {
      path,
      message: "GitHub Copilot config must contain a JSON object.",
    };
  }

  return {
    path,
    raw: parsed,
    model: extractCopilotConfiguredModel(parsed),
  };
}

function isConfigFile(
  value: CopilotConfigFile | CopilotConfigReadWarning,
): value is CopilotConfigFile {
  return "raw" in value;
}

function extractCopilotAuthUser(
  config: Readonly<Record<string, unknown>> | undefined,
): CopilotAuthUser | undefined {
  if (!config) {
    return undefined;
  }
  const lastLoggedInUser = config.lastLoggedInUser;
  const lastLoggedInLogin = isJsonRecord(lastLoggedInUser)
    ? normalizeNonEmptyString(lastLoggedInUser.login)
    : undefined;
  const lastLoggedInHost = isJsonRecord(lastLoggedInUser)
    ? normalizeNonEmptyString(lastLoggedInUser.host)
    : undefined;
  if (lastLoggedInLogin && lastLoggedInHost) {
    return {
      login: lastLoggedInLogin,
      host: lastLoggedInHost,
    };
  }
  const loggedInUsers = config.loggedInUsers;
  const firstLoggedInUser = Array.isArray(loggedInUsers) ? loggedInUsers[0] : undefined;
  const firstLoggedInLogin = isJsonRecord(firstLoggedInUser)
    ? normalizeNonEmptyString(firstLoggedInUser.login)
    : undefined;
  const firstLoggedInHost = isJsonRecord(firstLoggedInUser)
    ? normalizeNonEmptyString(firstLoggedInUser.host)
    : undefined;
  if (firstLoggedInLogin && firstLoggedInHost) {
    return {
      login: firstLoggedInLogin,
      host: firstLoggedInHost,
    };
  }
  return undefined;
}

export function resolveCopilotConfigPaths(
  input: ReadCopilotMergedSettingsInput,
): Effect.Effect<CopilotConfigPaths, never, Path.Path> {
  return Effect.gen(function* () {
    const path = yield* Path.Path;
    const homeDir = input.homeDir ?? os.homedir();
    return {
      userConfigPath: path.join(homeDir, CONFIG_DIRECTORY, CONFIG_FILE),
      projectConfigPath: path.join(input.cwd, CONFIG_DIRECTORY, CONFIG_FILE),
    };
  });
}

function readOptionalConfigFile(
  configPath: string,
): Effect.Effect<
  CopilotConfigFile | CopilotConfigReadWarning | undefined,
  never,
  FileSystem.FileSystem
> {
  return Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const exists = yield* fileSystem
      .exists(configPath)
      .pipe(Effect.catch(() => Effect.succeed(false)));
    if (!exists) {
      return undefined;
    }

    const readResult = yield* fileSystem.readFileString(configPath).pipe(Effect.result);
    if (Result.isFailure(readResult)) {
      return {
        path: configPath,
        message: `Failed to read GitHub Copilot config: ${readResult.failure.message}`,
      };
    }

    return parseConfigFile(configPath, readResult.success);
  });
}

export function readCopilotMergedSettings(
  input: ReadCopilotMergedSettingsInput,
): Effect.Effect<CopilotMergedSettings, never, FileSystem.FileSystem | Path.Path> {
  return Effect.gen(function* () {
    const paths = yield* resolveCopilotConfigPaths(input);
    const [userResult, projectResult] = yield* Effect.all(
      [
        readOptionalConfigFile(paths.userConfigPath),
        readOptionalConfigFile(paths.projectConfigPath),
      ],
      { concurrency: "unbounded" },
    );

    const warnings = [userResult, projectResult].flatMap((result) =>
      result && !isConfigFile(result) ? [result] : [],
    );
    const userConfig = userResult && isConfigFile(userResult) ? userResult : undefined;
    const projectConfig = projectResult && isConfigFile(projectResult) ? projectResult : undefined;

    return {
      userConfig,
      projectConfig,
      model: projectConfig?.model ?? userConfig?.model,
      warnings,
      auth: extractCopilotAuthUser(userConfig?.raw),
    };
  });
}

export function hasConcreteCopilotCurrentModel(currentModel: string | null | undefined): boolean {
  const normalized = currentModel?.trim();
  return !!normalized && normalized !== "auto";
}

export function applyCopilotConfiguredModelMetadata(input: {
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly configuredModel: string | null | undefined;
  readonly currentModel: string | null | undefined;
}): ReadonlyArray<ServerProviderModel> {
  const configuredModel = input.configuredModel?.trim();
  if (!configuredModel || hasConcreteCopilotCurrentModel(input.currentModel)) {
    return input.models;
  }

  return input.models.map((model) =>
    model.slug === "auto"
      ? {
          ...model,
          name: `Auto (${configuredModel})`,
        }
      : model,
  );
}
