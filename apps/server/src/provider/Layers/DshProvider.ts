import {
  type CustomModelSetting,
  DSH_DEFAULT_MODEL,
  type DshSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as EffectAcpSchema from "effect-acp/schema";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

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
import { makeDshAcpRuntime } from "../acp/DshAcpSupport.ts";
import { findSessionConfigOption } from "../acp/AcpRuntimeModel.ts";

const DSH_PRESENTATION = {
  displayName: "DSH",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
// `session/new` fetches the live provider/model catalog, so this covers initialize plus
// a networked catalog listing rather than a single local round trip.
const DSH_ACP_PROBE_TIMEOUT_MS = 15_000;
const DSH_API_KEY_ENV = "DEEPSEEK_API_KEY";

// Shown until the ACP probe replaces it with the live catalog. The slug is the wire route
// T3 passes to DSH verbatim, so it must stay identical to DSH_DEFAULT_MODEL.
const DSH_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: DSH_DEFAULT_MODEL,
    name: "deepseek-v4-flash",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialDshProviderSnapshot(
  dshSettings: DshSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = dshModelsFromSettings(dshSettings.customModels);

    if (!dshSettings.enabled) {
      return buildServerProvider({
        presentation: DSH_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "DSH is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: DSH_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking DSH CLI availability...",
      },
    });
  });
}

function dshModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = DSH_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Models from DSH's `session/new`/`resume` configOptions. DSH groups options by
 * provider; every leaf value is the wire route `JSON.stringify([provider, model])`,
 * which is also the T3 model slug.
 */
export function buildDshModelsFromSessionConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  const option = findSessionConfigOption(configOptions, "model");
  if (option?.type !== "select") {
    return [];
  }
  const currentValue = option.currentValue.trim();
  const seen = new Set<string>();
  const models: ServerProviderModel[] = [];
  for (const entry of option.options.flatMap((group) =>
    "value" in group ? [group] : group.options,
  )) {
    const slug = entry.value.trim();
    if (!slug || seen.has(slug)) {
      continue;
    }
    seen.add(slug);
    models.push({
      slug,
      name: entry.name.trim() || slug,
      isCustom: false,
      ...(currentValue.length > 0 && slug === currentValue ? { isDefault: true } : {}),
      capabilities: EMPTY_CAPABILITIES,
    });
  }
  return models;
}

const runDshCliCommand = (
  dshSettings: DshSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = dshSettings.binaryPath || "dsh";
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
 * Reads DSH's model catalog from a throwaway ACP session. DSH advertises no model
 * metadata in `initialize._meta`, so the catalog only exists on `session/new`;
 * `authenticate` always succeeds immediately, so no login can hang this probe.
 */
const discoverDshModelsViaAcpSession = (
  dshSettings: DshSettings,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeDshAcpRuntime({
      dshSettings,
      environment,
      childProcessSpawner,
      cwd: cwd ?? process.cwd(),
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const started = yield* acp.start();
    return buildDshModelsFromSessionConfigOptions(started.sessionSetupResult.configOptions);
  }).pipe(Effect.scoped);

export const checkDshProviderStatus = Effect.fn("checkDshProviderStatus")(function* (
  dshSettings: DshSettings,
  environment: NodeJS.ProcessEnv = process.env,
  cwd?: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = dshModelsFromSettings(dshSettings.customModels);

  if (!dshSettings.enabled) {
    return buildServerProvider({
      presentation: DSH_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "DSH is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runDshCliCommand(dshSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("DSH CLI health check failed.", {
      errorTag: error._tag,
    });
    return buildServerProvider({
      presentation: DSH_PRESENTATION,
      enabled: dshSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "DSH CLI (`dsh`) is not installed or not on PATH."
          : "Failed to execute DSH CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: DSH_PRESENTATION,
      enabled: dshSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "DSH CLI is installed but timed out while running `dsh --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("DSH CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: DSH_PRESENTATION,
      enabled: dshSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "DSH CLI is installed but failed to run.",
      },
    });
  }

  const acpExit = yield* discoverDshModelsViaAcpSession(dshSettings, environment, cwd).pipe(
    Effect.timeoutOption(DSH_ACP_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  const acpModels = Exit.isSuccess(acpExit) ? (Option.getOrUndefined(acpExit.value) ?? []) : [];
  const acpFailed = Exit.isFailure(acpExit) || acpModels.length === 0;
  if (acpFailed) {
    yield* Effect.logWarning("DSH ACP session probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "NoModels",
    });
  }

  const models =
    acpModels.length > 0
      ? dshModelsFromSettings(dshSettings.customModels, acpModels)
      : fallbackModels;

  const auth: ServerProviderAuth = environment[DSH_API_KEY_ENV]?.trim()
    ? { status: "authenticated", type: "api_key", label: "DeepSeek API key" }
    : { status: "unknown" };

  return buildServerProvider({
    presentation: DSH_PRESENTATION,
    enabled: dshSettings.enabled,
    checkedAt,
    models,
    // DSH's ACP surface has no compaction command plane, so T3 must not
    // advertise /compact; the adapter declares no compaction capability.
    probe: {
      installed: true,
      version,
      // A failed catalog probe degrades the model picker, it does not make chats fail.
      status: acpFailed ? "warning" : "ready",
      auth,
      ...(acpFailed
        ? {
            message:
              "DSH CLI is installed but the ACP session probe failed. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichDshSnapshot = (input: {
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
      Effect.logWarning("DSH version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
