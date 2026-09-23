import {
  type CustomModelSetting,
  type HermesSettings,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
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
import {
  HERMES_DEFAULT_MODEL_SLUG,
  resolveHermesAcpBaseModelId,
  withHermesAcpAuthRetry,
} from "../acp/HermesAcpSupport.ts";

const HERMES_PRESENTATION = {
  displayName: "Hermes",
  supportsConversationRollback: false,
  badgeLabel: "Experimental",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 10_000;
// `acp --check` only verifies local imports; it never opens a session.
const CHECK_PROBE_TIMEOUT_MS = 10_000;
// Model discovery opens (and immediately tears down) a real ACP session, so
// it is given more room than Grok's initialize-only probe.
const HERMES_ACP_SESSION_PROBE_TIMEOUT_MS = 15_000;

const HERMES_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: HERMES_DEFAULT_MODEL_SLUG,
    name: "Hermes Agent",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function buildInitialHermesProviderSnapshot(
  hermesSettings: HermesSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = hermesModelsFromSettings(hermesSettings.customModels);

    if (!hermesSettings.enabled) {
      return buildServerProvider({
        presentation: HERMES_PRESENTATION,
        enabled: false,
        checkedAt,
        models,
        probe: {
          installed: false,
          version: null,
          status: "warning",
          auth: { status: "unknown" },
          message: "Hermes is disabled in T3 Code settings.",
        },
      });
    }

    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Hermes Agent CLI availability...",
      },
    });
  });
}

function hermesModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = HERMES_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/** Models advertised by `session/new`, with the session's current model marked as default. */
export function buildHermesModelsFromSessionModelState(
  modelState: EffectAcpSchema.SessionModelState | null | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const currentModelId = modelState.currentModelId.trim();
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model): ServerProviderModel[] => {
    const slug = resolveHermesAcpBaseModelId(model.modelId);
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        ...(model.modelId.trim() === currentModelId ? { isDefault: true } : {}),
        capabilities: EMPTY_CAPABILITIES,
      },
    ];
  });
}

const runHermesAcpSubcommand = (
  hermesSettings: HermesSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = hermesSettings.binaryPath || "hermes";
    const fullArgs = ["acp", ...args];
    const spawnCommand = yield* resolveSpawnCommand(command, fullArgs, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/**
 * Opens a throwaway ACP session purely to read `session/new`'s advertised
 * `models.availableModels`, then tears the process down. This never calls
 * `session/prompt`, so it cannot run agent turns or mutate the workspace,
 * but — unlike Grok's initialize-only probe — it does start a real Hermes
 * session (and therefore Hermes's own MCP discovery, unless the caller sets
 * `HERMES_ACP_SKIP_CONFIGURED_MCP=1`), because Hermes only advertises models
 * through `session/new`, not `initialize`.
 */
const discoverHermesModelsViaAcpSession = (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    // withHermesAcpAuthRetry: a cached auth-method id that Hermes has
    // started rejecting (e.g. its active provider changed since caching)
    // would otherwise fail this probe opaquely for up to the cache TTL.
    const started = yield* withHermesAcpAuthRetry(
      {
        hermesSettings,
        environment,
        childProcessSpawner,
        cwd: process.cwd(),
        clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
      },
      (acp) => acp.start(),
    );
    return buildHermesModelsFromSessionModelState(started.sessionSetupResult.models ?? null);
  }).pipe(Effect.scoped);

export const checkHermesProviderStatus = Effect.fn("checkHermesProviderStatus")(function* (
  hermesSettings: HermesSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = hermesModelsFromSettings(hermesSettings.customModels);

  if (!hermesSettings.enabled) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: false,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Hermes is disabled in T3 Code settings.",
      },
    });
  }

  const checkResult = yield* runHermesAcpSubcommand(hermesSettings, ["--check"], environment).pipe(
    Effect.timeoutOption(CHECK_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(checkResult)) {
    const error = checkResult.failure;
    yield* Effect.logWarning("Hermes ACP health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Hermes Agent CLI (`hermes`) is not installed or not on PATH."
          : "Failed to execute Hermes ACP health check.",
      },
    });
  }

  if (Option.isNone(checkResult.success)) {
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes Agent CLI is installed but timed out while running `hermes acp --check`.",
      },
    });
  }

  const checkOutput = checkResult.success.value;
  if (checkOutput.code !== 0) {
    yield* Effect.logWarning("Hermes ACP health check exited with a non-zero status.", {
      exitCode: checkOutput.code,
    });
    return buildServerProvider({
      presentation: HERMES_PRESENTATION,
      enabled: hermesSettings.enabled,
      checkedAt,
      models: fallbackModels,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Hermes Agent CLI is installed but `hermes acp --check` failed.",
      },
    });
  }

  const versionResult = yield* runHermesAcpSubcommand(
    hermesSettings,
    ["--version"],
    environment,
  ).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);
  const versionOutput =
    Result.isSuccess(versionResult) && Option.isSome(versionResult.success)
      ? versionResult.success.value
      : undefined;
  const version =
    versionOutput && versionOutput.code === 0
      ? parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`)
      : null;

  const acpExit = yield* discoverHermesModelsViaAcpSession(hermesSettings, environment).pipe(
    Effect.timeoutOption(HERMES_ACP_SESSION_PROBE_TIMEOUT_MS),
    Effect.exit,
  );
  const acpModels = Exit.isSuccess(acpExit) ? Option.getOrElse(acpExit.value, () => []) : [];
  const acpFailed = Exit.isFailure(acpExit) || Option.isNone(acpExit.value);
  if (acpFailed) {
    yield* Effect.logWarning("Hermes ACP session probe failed or timed out.", {
      errorTag: Exit.isFailure(acpExit) ? causeErrorTag(acpExit.cause) : "Timeout",
    });
  }

  const models =
    acpModels.length > 0
      ? hermesModelsFromSettings(hermesSettings.customModels, acpModels)
      : fallbackModels;
  // Hermes speaks only ACP over stdio: reaching a live session is itself the
  // auth signal, since there is no separate CLI login-status command like
  // Grok's `grok models`.
  const auth: ServerProviderAuth = acpFailed
    ? { status: "unknown" }
    : { status: "authenticated", type: "cached_token", label: "Hermes Agent session" };

  return buildServerProvider({
    presentation: HERMES_PRESENTATION,
    enabled: hermesSettings.enabled,
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
              "Hermes Agent CLI is installed but its ACP session failed to start. Model options may be incomplete.",
          }
        : {}),
    },
  });
});

export const enrichHermesSnapshot = (input: {
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
      Effect.logWarning("Hermes version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
