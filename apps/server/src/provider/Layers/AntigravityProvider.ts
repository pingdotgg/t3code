import type {
  AntigravitySettings,
  ModelCapabilities,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { discoverAntigravitySkills } from "../Drivers/AntigravitySkills.ts";
import { parseAntigravityModels } from "../antigravity/AntigravityCli.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "../providerMaintenance.ts";

const PRESENTATION = {
  displayName: "Antigravity",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = parseAntigravityModels(
  [
    "gemini-3.6-flash-high\tGemini 3.6 Flash (High)",
    "gemini-3.6-flash-medium\tGemini 3.6 Flash (Medium)",
    "gemini-3.6-flash-low\tGemini 3.6 Flash (Low)",
  ].join("\n"),
);

function modelsFromSettings(
  customModels: ReadonlyArray<string>,
  builtIn: ReadonlyArray<ServerProviderModel> = FALLBACK_MODELS,
) {
  return providerModelsFromSettings(builtIn, customModels, EMPTY_CAPABILITIES);
}

const runCommand = (
  settings: AntigravitySettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const binary = settings.binaryPath || "agy";
    const spawn = yield* resolveSpawnCommand(binary, [...args], { env: environment });
    return yield* spawnAndCollect(
      binary,
      ChildProcess.make(spawn.command, spawn.args, {
        env: environment,
        shell: spawn.shell,
        stdin: "ignore",
      }),
    );
  });

function snapshot(input: {
  readonly settings: AntigravitySettings;
  readonly checkedAt: string;
  readonly models: ReadonlyArray<ServerProviderModel>;
  readonly skills?: ServerProviderDraft["skills"];
  readonly installed: boolean;
  readonly version: string | null;
  readonly status: "ready" | "warning" | "error";
  readonly auth: "authenticated" | "unauthenticated" | "unknown";
  readonly message?: string;
}) {
  return buildServerProvider({
    presentation: PRESENTATION,
    enabled: input.settings.enabled,
    checkedAt: input.checkedAt,
    models: input.models,
    ...(input.skills ? { skills: input.skills } : {}),
    probe: {
      installed: input.installed,
      version: input.version,
      status: input.status,
      auth: { status: input.auth },
      ...(input.message ? { message: input.message } : {}),
    },
  });
}

export function buildInitialAntigravityProviderSnapshot(settings: AntigravitySettings) {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return snapshot({
      settings,
      checkedAt,
      models: modelsFromSettings(settings.customModels),
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: "unknown",
      message: settings.enabled
        ? "Checking Antigravity CLI availability..."
        : "Antigravity is disabled in T3 Code settings.",
    });
  });
}

export const checkAntigravityProviderStatus = Effect.fn("checkAntigravityProviderStatus")(
  function* (
    settings: AntigravitySettings,
    environment: NodeJS.ProcessEnv = process.env,
    cwd?: string,
  ): Effect.fn.Return<
    ServerProviderDraft,
    never,
    ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
  > {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    const fallback = modelsFromSettings(settings.customModels);
    if (!settings.enabled) {
      return yield* buildInitialAntigravityProviderSnapshot(settings);
    }
    const skills = yield* discoverAntigravitySkills(cwd);
    const versionResult = yield* runCommand(settings, ["--version"], environment).pipe(
      Effect.timeoutOption(4_000),
      Effect.result,
    );
    if (Result.isFailure(versionResult)) {
      return snapshot({
        settings,
        checkedAt,
        models: fallback,
        skills,
        installed: !isCommandMissingCause(versionResult.failure),
        version: null,
        status: "error",
        auth: "unknown",
        message: isCommandMissingCause(versionResult.failure)
          ? "Antigravity CLI (`agy`) is not installed or not on PATH."
          : "Failed to execute Antigravity CLI health check.",
      });
    }
    if (Option.isNone(versionResult.success)) {
      return snapshot({
        settings,
        checkedAt,
        models: fallback,
        skills,
        installed: true,
        version: null,
        status: "error",
        auth: "unknown",
        message: "Antigravity CLI timed out while running `agy --version`.",
      });
    }
    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      return snapshot({
        settings,
        checkedAt,
        models: fallback,
        skills,
        installed: true,
        version,
        status: "error",
        auth: "unknown",
        message: "Antigravity CLI is installed but failed to run.",
      });
    }
    const modelsResult = yield* runCommand(settings, ["models"], environment).pipe(
      Effect.timeoutOption(15_000),
      Effect.result,
    );
    if (Result.isFailure(modelsResult) || Option.isNone(modelsResult.success)) {
      return snapshot({
        settings,
        checkedAt,
        models: fallback,
        skills,
        installed: true,
        version,
        status: "warning",
        auth: "unknown",
        message: "Antigravity CLI is installed but `agy models` did not answer.",
      });
    }
    const modelsOutput = modelsResult.success.value;
    if (modelsOutput.code !== 0) {
      return snapshot({
        settings,
        checkedAt,
        models: fallback,
        skills,
        installed: true,
        version,
        status: "warning",
        auth: "unauthenticated",
        message: "Antigravity CLI is installed but not signed in. Run `agy` to authenticate.",
      });
    }
    const discovered = parseAntigravityModels(modelsOutput.stdout);
    return snapshot({
      settings,
      checkedAt,
      models: discovered.length ? modelsFromSettings(settings.customModels, discovered) : fallback,
      skills,
      installed: true,
      version,
      status: "ready",
      auth: discovered.length ? "authenticated" : "unknown",
    });
  },
);

export const enrichAntigravitySnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}) =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap(input.publishSnapshot),
    Effect.catchCause((cause) =>
      Effect.logWarning("Antigravity version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
