import {
  type HermesAcpSettings,
  type ModelCapabilities,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const HERMES_ACP_PRESENTATION = {
  displayName: "Hermes in Code",
  badgeLabel: "ACP",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: false,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});
const PROBE_TIMEOUT_MS = 8_000;
const DEFAULT_MODEL: ServerProviderModel = {
  slug: "default",
  name: "Hermes default",
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
};

function hermesAcpModels(settings: HermesAcpSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [DEFAULT_MODEL],
    settings.customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

const runHermesCommand = (
  settings: HermesAcpSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "hermes";
    const spawn = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawn.command, spawn.args, {
        env: environment,
        shell: spawn.shell,
      }),
    );
  });

export function buildInitialHermesAcpProviderSnapshot(
  settings: HermesAcpSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: HERMES_ACP_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: hermesAcpModels(settings),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Hermes ACP availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Hermes in Code is disabled in T3 Code settings.",
          },
    });
  });
}

export const checkHermesAcpProviderStatus = Effect.fn("checkHermesAcpProviderStatus")(function* (
  settings: HermesAcpSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = hermesAcpModels(settings);
  const build = (probe: Parameters<typeof buildServerProvider>[0]["probe"]): ServerProviderDraft =>
    buildServerProvider({
      presentation: HERMES_ACP_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe,
    });

  if (!settings.enabled) {
    return build({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Hermes in Code is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runHermesCommand(settings, ["acp", "--version"], environment).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    return build({
      installed: !isCommandMissingCause(versionResult.failure),
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: isCommandMissingCause(versionResult.failure)
        ? "Hermes Agent CLI (`hermes`) is not installed or not on PATH."
        : "Failed to execute the Hermes ACP version probe.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return build({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "Hermes Agent CLI timed out while checking `hermes acp --version`.",
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return build({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "This Hermes Agent CLI does not expose a working `hermes acp` stdio command.",
    });
  }

  const checkResult = yield* runHermesCommand(settings, ["acp", "--check"], environment).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(checkResult)) {
    return build({
      installed: !isCommandMissingCause(checkResult.failure),
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Hermes ACP dependency check could not be executed.",
    });
  }
  if (Option.isNone(checkResult.success)) {
    return build({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Hermes ACP dependency check timed out.",
    });
  }
  if (checkResult.success.value.code !== 0) {
    return build({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message:
        "Hermes Agent is installed, but its ACP adapter or protocol dependencies are unavailable.",
    });
  }

  return build({
    installed: true,
    version,
    status: "ready",
    auth: { status: "unknown" },
  });
});
