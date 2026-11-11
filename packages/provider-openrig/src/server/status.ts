import { type ServerProviderModel } from "@t3tools/contracts";
import type { OpenRigSettings } from "../settings.ts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { OPENRIG_DRIVER_KIND } from "./acpSupport.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseCliVersionResult,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  providerProbeEnvironment,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

const OPENRIG_PRESENTATION = {
  displayName: "OpenRig",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const OPENRIG_DEFAULT_MODEL_SLUG = "default";
const OPENRIG_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: OPENRIG_DEFAULT_MODEL_SLUG,
    name: "OpenRig team",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];
const VERSION_PROBE_TIMEOUT_MS = 10_000;

const openRigModels = (settings: OpenRigSettings) =>
  providerModelsFromSettings(OPENRIG_BUILT_IN_MODELS, settings.customModels, EMPTY_CAPABILITIES);

const snapshot = (
  settings: OpenRigSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
): ServerProviderDraft => ({
  ...buildServerProvider({
    driver: OPENRIG_DRIVER_KIND,
    presentation: OPENRIG_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: openRigModels(settings),
    probe,
  }),
  // Text generation would open a throwaway ACP session against a live team.
  supportsTextGeneration: false,
});

export const buildInitialOpenRigProviderSnapshot = (
  settings: OpenRigSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot(settings, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking OpenRig CLI availability..."
        : "OpenRig is disabled in T3 Code settings.",
    }),
  );

const runOpenRigCli = Effect.fn("runOpenRigCli")(function* (
  settings: OpenRigSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "rig";
  const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

/**
 * Probes `rig --version` only. Does not start `rig acp serve`, which would attach
 * to a live team.
 */
export const checkOpenRigProviderStatus = Effect.fn("checkOpenRigProviderStatus")(function* (
  settings: OpenRigSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "OpenRig is disabled in T3 Code settings.",
    });
  }

  const probeEnvironment = providerProbeEnvironment(environment);
  const versionResult = yield* runOpenRigCli(settings, ["--version"], probeEnvironment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
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
        ? "OpenRig (`rig`) is not installed or not on PATH."
        : "Failed to run `rig --version`.",
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
      message: "OpenRig is installed but failed to run.",
    });
  }

  return snapshot(settings, checkedAt, {
    installed: true,
    version,
    status: "ready",
    auth: { status: "unknown" },
    message:
      "OpenRig is installed. Team auth stays with `rig`; a prompt becomes a team task over ACP.",
  });
});
