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
  resolveDevinAcpBaseModelId,
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
const DEVIN_MODELS_LIST_TIMEOUT_MS = 10_000;

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

interface DevinModelsListVariant {
  readonly model_uid: string;
  readonly label: string;
  readonly is_new?: boolean | undefined;
  readonly is_beta?: boolean | undefined;
}

interface DevinModelsListFamily {
  readonly family_uid: string;
  readonly family_label: string;
  readonly slug: string;
  readonly aliases?: ReadonlyArray<string> | undefined;
  readonly variants: ReadonlyArray<DevinModelsListVariant>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isModelsListVariant(value: unknown): value is DevinModelsListVariant {
  if (!isRecord(value)) return false;
  const modelUid = nonEmptyString(value.model_uid);
  const label = nonEmptyString(value.label);
  if (modelUid === undefined || label === undefined) return false;
  const isNew = value.is_new;
  const isBeta = value.is_beta;
  if (isNew !== undefined && typeof isNew !== "boolean") return false;
  if (isBeta !== undefined && typeof isBeta !== "boolean") return false;
  return true;
}

function isModelsListFamily(value: unknown): value is DevinModelsListFamily {
  if (!isRecord(value)) return false;
  if (
    nonEmptyString(value.family_uid) === undefined ||
    nonEmptyString(value.family_label) === undefined ||
    nonEmptyString(value.slug) === undefined
  ) {
    return false;
  }
  const aliases = value.aliases;
  const variants = value.variants;
  if (!Array.isArray(variants) || !variants.every(isModelsListVariant)) return false;
  if (aliases !== undefined && !isStringArray(aliases)) return false;
  return true;
}

function buildDevinModelAliases(
  variant: DevinModelsListVariant,
  family: DevinModelsListFamily,
): ReadonlyArray<string> | undefined {
  const seen = new Set<string>();
  const aliases: Array<string> = [];
  const push = (value: string | undefined) => {
    const trimmed = value?.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    aliases.push(trimmed);
  };
  if (family.aliases) {
    for (const alias of family.aliases) {
      push(alias);
    }
  }
  push(family.slug);
  push(family.family_uid);
  push(variant.model_uid);
  return aliases.length > 0 ? aliases : undefined;
}

export function parseDevinModelsListJson(raw: string): ReadonlyArray<ServerProviderModel> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.families)) return [];

  const models: Array<ServerProviderModel> = [];
  const seen = new Set<string>();
  for (const familyCandidate of parsed.families) {
    if (!isModelsListFamily(familyCandidate)) continue;
    const family = familyCandidate;
    for (const variant of family.variants) {
      const slug = resolveDevinAcpBaseModelId(variant.model_uid);
      if (seen.has(slug)) continue;
      seen.add(slug);
      models.push({
        slug,
        name: variant.label,
        isCustom: false,
        ...(variant.is_new ? { badge: "new" as const } : {}),
        aliases: buildDevinModelAliases(variant, family),
        capabilities: EMPTY_CAPABILITIES,
      });
    }
  }
  return models;
}

const discoverDevinModelsViaModelsList = (
  devinSettings: DevinSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const listResult = yield* runDevinCliCommand(
      devinSettings,
      ["models", "list", "--format", "json"],
      environment,
      cwd,
    ).pipe(Effect.timeoutOption(DEVIN_MODELS_LIST_TIMEOUT_MS), Effect.result);

    if (Result.isFailure(listResult)) {
      yield* Effect.logWarning("Devin models list probe failed.", {
        errorTag: listResult.failure._tag,
      });
      return [];
    }

    if (Option.isNone(listResult.success)) {
      yield* Effect.logWarning("Devin models list probe timed out.");
      return [];
    }

    const listOutput = listResult.success.value;
    if (listOutput.code !== 0) {
      yield* Effect.logWarning("Devin models list probe exited with a non-zero status.", {
        exitCode: listOutput.code,
        stdoutLength: listOutput.stdout.length,
        stderrLength: listOutput.stderr.length,
      });
      return [];
    }

    const models = parseDevinModelsListJson(listOutput.stdout);
    if (models.length === 0) {
      yield* Effect.logWarning("Devin models list probe returned no models.");
    }
    return models;
  }).pipe(Effect.orElseSucceed(() => []));

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

  const cliExit =
    acpModels.length === 0
      ? yield* discoverDevinModelsViaModelsList(
          devinSettings,
          resolvedProfile.environment,
          workCwd,
        ).pipe(Effect.exit)
      : Exit.succeed([]);
  const cliModels = Exit.isSuccess(cliExit) ? cliExit.value : [];

  const discoveredModels = acpModels.length > 0 ? acpModels : cliModels;
  const discoveredViaCli = acpModels.length === 0 && cliModels.length > 0;
  const modelDiscoveryFailed = discoveredModels.length === 0;

  if (modelDiscoveryFailed) {
    yield* Effect.logWarning(
      "Devin ACP initialize and models list probe failed or returned no models.",
      {
        acpErrorTag: Exit.isFailure(acpExit)
          ? (acpExit.cause as { _tag?: string })?._tag
          : "NoModels",
        cliErrorTag: Exit.isFailure(cliExit)
          ? (cliExit.cause as { _tag?: string })?._tag
          : "NoModels",
      },
    );
  }

  const auth: ServerProviderAuth = discoveredViaCli
    ? { status: "authenticated" }
    : { status: "unknown" };

  const mergedBuiltInModels = (() => {
    const builtIn = [...DEVIN_BUILT_IN_MODELS];
    const seen = new Set(builtIn.map((m) => m.slug));
    for (const model of discoveredModels) {
      if (!seen.has(model.slug)) {
        seen.add(model.slug);
        builtIn.push(model);
      }
    }
    return builtIn;
  })();
  const models = devinModelsFromSettings(devinSettings.customModels, mergedBuiltInModels);

  return buildServerProvider({
    presentation: DEVIN_PRESENTATION,
    enabled: devinSettings.enabled,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: modelDiscoveryFailed ? "warning" : "ready",
      auth,
      ...(modelDiscoveryFailed
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
