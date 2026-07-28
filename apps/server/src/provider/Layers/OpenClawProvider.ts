import {
  type ModelCapabilities,
  type OpenClawSettings,
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

const OPENCLAW_PRESENTATION = {
  displayName: "OpenClaw",
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
  name: "OpenClaw default",
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
};

function openClawModels(settings: OpenClawSettings): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [DEFAULT_MODEL],
    settings.customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

const runOpenClawCommand = (
  settings: OpenClawSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = settings.binaryPath || "openclaw";
    const spawn = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawn.command, spawn.args, {
        env: environment,
        shell: spawn.shell,
      }),
    );
  });

export function buildInitialOpenClawProviderSnapshot(
  settings: OpenClawSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    return buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: openClawModels(settings),
      probe: settings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking OpenClaw ACP availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "OpenClaw is disabled in T3 Code settings.",
          },
    });
  });
}

export const checkOpenClawProviderStatus = Effect.fn("checkOpenClawProviderStatus")(function* (
  settings: OpenClawSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = openClawModels(settings);
  const build = (probe: Parameters<typeof buildServerProvider>[0]["probe"]): ServerProviderDraft =>
    buildServerProvider({
      presentation: OPENCLAW_PRESENTATION,
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
      message: "OpenClaw is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runOpenClawCommand(settings, ["--version"], environment).pipe(
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
        ? "OpenClaw CLI (`openclaw`) is not installed or not on PATH."
        : "Failed to execute the OpenClaw version probe.",
    });
  }
  if (Option.isNone(versionResult.success)) {
    return build({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: "OpenClaw CLI timed out while checking `openclaw --version`.",
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
      message: "The OpenClaw version probe exited unsuccessfully.",
    });
  }

  const helpResult = yield* runOpenClawCommand(settings, ["acp", "--help"], environment).pipe(
    Effect.timeoutOption(PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(helpResult)) {
    return build({
      installed: !isCommandMissingCause(helpResult.failure),
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "OpenClaw ACP help could not be executed.",
    });
  }
  if (Option.isNone(helpResult.success)) {
    return build({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "OpenClaw ACP help timed out.",
    });
  }
  if (helpResult.success.value.code !== 0) {
    return build({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "This OpenClaw CLI does not expose a working `openclaw acp` command.",
    });
  }

  return build({
    installed: true,
    version,
    status: "ready",
    auth: { status: "unknown" },
  });
});
