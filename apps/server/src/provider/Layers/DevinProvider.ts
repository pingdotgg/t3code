import {
  type DevinSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HttpClient } from "effect/unstable/http";

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
import { sessionModelStateFromInitialize } from "../acp/AcpRuntimeModel.ts";
import {
  buildDevinModelsFromSessionModelState,
  DEVIN_DEFAULT_MODEL_SLUG_PUBLIC,
  makeDevinAcpRuntime,
  type DevinAcpRuntimeSettings,
} from "../acp/DevinAcpSupport.ts";
import {
  resolveDevinRuntimeProfile,
  type ResolvedDevinRuntimeProfile,
} from "../Drivers/DevinProfile.ts";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  badgeLabel: "Early Access",
  showInteractionModeToggle: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
const DEVIN_ACP_INITIALIZE_TIMEOUT_MS = 8_000;

const DEVIN_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DEVIN_DEFAULT_MODEL_SLUG_PUBLIC,
    name: "Devin Default",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function devinModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DEVIN_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

export function buildInitialDevinProviderSnapshot(
  devinSettings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = devinModelsFromSettings(devinSettings.customModels);

    if (!devinSettings.enabled) {
      return buildServerProvider({
        presentation: DEVIN_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Devin is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Devin CLI availability...",
      },
    });
  });
}

const runDevinCliCommand = (
  devinSettings: DevinSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const command = devinSettings.binaryPath.trim() || "devin";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        cwd,
      }),
    );
  });

const discoverDevinModelsViaAcpInitialize = (
  devinSettings: DevinSettings,
  resolvedProfile: ResolvedDevinRuntimeProfile,
  cwd: string,
): Effect.Effect<
  ReadonlyArray<ServerProviderModel>,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDevinAcpRuntime({
      childProcessSpawner,
      devinSettings: {
        binaryPath: devinSettings.binaryPath,
        agentType: devinSettings.agentType,
        sandbox: devinSettings.sandbox,
        respectWorkspaceTrust: devinSettings.respectWorkspaceTrust,
        launchArgs: devinSettings.launchArgs,
        resolvedConfigPath: resolvedProfile.configPath,
      } satisfies DevinAcpRuntimeSettings,
      environment: resolvedProfile.environment,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const initialized = yield* acp.initialize();
    return buildDevinModelsFromSessionModelState(sessionModelStateFromInitialize(initialized))
      .models;
  }).pipe(
    Effect.scoped,
    Effect.orElseSucceed(() => []),
    Effect.timeoutOption(DEVIN_ACP_INITIALIZE_TIMEOUT_MS),
    Effect.map((option) => Option.getOrElse(option, () => [])),
  );

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const resolvedProfile = yield* resolveDevinRuntimeProfile({
    settings: devinSettings,
    environment,
  });
  const workCwd = cwd ?? process.cwd();
  const fallbackModels = devinModelsFromSettings(devinSettings.customModels);

  if (!devinSettings.enabled) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Devin is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDevinCliCommand(
    devinSettings,
    ["--version"],
    resolvedProfile.environment,
    workCwd,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Devin CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Devin CLI (`devin`) is not installed or not on PATH."
          : "Failed to execute Devin CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but timed out while running `devin --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Devin CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: devinSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Devin CLI is installed but failed to run.",
      },
    });
  }

  const acpExit = yield* discoverDevinModelsViaAcpInitialize(
    devinSettings,
    resolvedProfile,
    workCwd,
  ).pipe(Effect.exit);
  const acpModels = Exit.isSuccess(acpExit) ? acpExit.value : [];
  const acpFailed = Exit.isFailure(acpExit) || acpModels.length === 0;
  if (acpFailed) {
    yield* Effect.logWarning("Devin ACP initialize probe failed or did not advertise models.", {
      errorTag: Exit.isFailure(acpExit) ? (acpExit.cause as { _tag?: string })?._tag : "NoModels",
    });
  }

  const auth: ServerProviderAuth = { status: "unknown" };

  const discoveredModels = acpModels.length > 0 ? acpModels : [];
  const models =
    discoveredModels.length > 0
      ? devinModelsFromSettings(devinSettings.customModels, discoveredModels)
      : fallbackModels;

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: devinSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: acpFailed ? "warning" : "ready",
      auth,
      ...(acpFailed
        ? {
            message:
              "Devin CLI is installed but ACP initialize did not advertise models. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichDevinSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> => {
  const { snapshot, publishSnapshot } = input;

  return enrichProviderSnapshotWithVersionAdvisory(snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("Devin version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
