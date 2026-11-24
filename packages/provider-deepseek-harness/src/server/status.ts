import { resolveProviderProbeTimeoutMs } from "@t3tools/provider-core/server/snapshotProbe";
import {
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { DeepSeekHarnessSettings } from "../settings.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, type ChildProcessSpawner } from "effect/process";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseCliVersionResult,
  providerModelsFromSettings,
  type ProviderProbeResult,
  type ServerProviderDraft,
  providerProbeEnvironment,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

const DSH_DRIVER_KIND = ProviderDriverKind.make("deepseekHarness");
const DSH_PRESENTATION = {
  displayName: "DeepSeek Harness",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const DSH_DEFAULT_MODEL_SLUG = "default";
const VERSION_PROBE_TIMEOUT_MS = 10_000;

/**
 * Models are the session's own ACP config options; the picker fills from what
 * the harness advertises per thread. The snapshot only carries the default and
 * any user-added custom ids.
 */
const dshModels = (settings: DeepSeekHarnessSettings): ReadonlyArray<ServerProviderModel> =>
  providerModelsFromSettings(
    [
      {
        slug: DSH_DEFAULT_MODEL_SLUG,
        name: "DeepSeek Harness default",
        isCustom: false,
        capabilities: EMPTY_CAPABILITIES,
      },
    ],
    settings.customModels,
    EMPTY_CAPABILITIES,
  );

const snapshot = (
  settings: DeepSeekHarnessSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
) =>
  buildServerProvider({
    driver: DSH_DRIVER_KIND,
    presentation: DSH_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: dshModels(settings),
    probe,
  });

export const buildInitialDshProviderSnapshot = Effect.fn(
  "DshProvider.buildInitialDshProviderSnapshot",
)(function* (settings: DeepSeekHarnessSettings): Effect.fn.Return<ServerProviderDraft> {
  const now = yield* DateTime.now;
  return snapshot(settings, DateTime.formatIso(now), {
    installed: settings.enabled,
    version: null,
    status: "warning",
    auth: { status: "unknown" },
    message: settings.enabled
      ? "Checking DeepSeek Harness CLI availability..."
      : "DeepSeek Harness is disabled in T3 Code settings.",
  });
});

const runDshCli = Effect.fn("DshProvider.runDshCli")(function* (
  settings: DeepSeekHarnessSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "dsh";
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

export const checkDshProviderStatus = Effect.fn("checkDshProviderStatus")(function* (
  settings: DeepSeekHarnessSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "DeepSeek Harness is disabled in T3 Code settings.",
    });
  }

  const probeEnvironment = providerProbeEnvironment(environment);
  const versionResult = yield* runDshCli(settings, ["--version"], probeEnvironment).pipe(
    Effect.timeoutOption(
      resolveProviderProbeTimeoutMs("deepseek_harness", VERSION_PROBE_TIMEOUT_MS, environment),
    ),
    Effect.result,
  );
  if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
    const missing = Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
    return snapshot(settings, checkedAt, {
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "The DeepSeek Harness CLI (`dsh`) is not installed or not on PATH. Install it with `npm install -g @deepseek-ai/dsh`."
        : "Failed to run `dsh --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseCliVersionResult(versionOutput);
  if (versionOutput.code !== 0) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "The DeepSeek Harness CLI is installed but failed to run.",
    });
  }

  // Credentials live in the harness profile, not in T3: the CLI running at all
  // means the profile's own provider sign-in governs every turn.
  return snapshot(settings, checkedAt, {
    installed: true,
    version,
    status: "ready",
    auth: { status: "authenticated", type: "api_key", label: "DeepSeek Harness profile" },
  });
});
