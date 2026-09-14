/**
 * Auggie provider snapshot — installation, version, and sign-in state.
 *
 * The probe deliberately never opens an ACP session. Auggie only advertises
 * its model catalog on `session/new` / `session/load`, and creating a session
 * would index the workspace and start the user's MCP servers as a side effect
 * of a health check. The adapter publishes the real catalog once a thread
 * actually runs; until then the picker shows the {@link AUGGIE_DEFAULT_MODEL}
 * sentinel and whatever `providerStatusCache` retained from a previous run.
 *
 * @module provider/Layers/AuggieProvider
 */
import {
  type AuggieSettings,
  AUGGIE_DEFAULT_MODEL,
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { HttpClient } from "effect/unstable/http";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  AUTH_PROBE_TIMEOUT_MS,
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
import { resolveAuggieAcpBaseModelId } from "../acp/AuggieAcpSupport.ts";

const AUGGIE_PRESENTATION = {
  displayName: "Auggie",
  // Auggie has no ACP rollback capability, so the checkpoint boundary must
  // reject revert before touching files.
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const VERSION_PROBE_TIMEOUT_MS = 4_000;
/** Same format as `~/.augment/session.json`; set, it replaces the stored login. */
const AUGGIE_SESSION_AUTH_ENV = "AUGMENT_SESSION_AUTH";

const AUGGIE_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: AUGGIE_DEFAULT_MODEL,
    name: "Auggie Default",
    isCustom: false,
    isDefault: true,
    capabilities: EMPTY_CAPABILITIES,
  },
];

function auggieModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = AUGGIE_BUILT_IN_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * Models advertised on the live session, with the current one marked default.
 * The adapter calls this after `session/new` and `session/load`; the probe
 * never does.
 */
export function buildAuggieModelsFromSessionModelState(
  modelState:
    | {
        readonly currentModelId: string;
        readonly availableModels: ReadonlyArray<{
          readonly modelId: string;
          readonly name: string;
        }>;
      }
    | null
    | undefined,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState || modelState.availableModels.length === 0) {
    return [];
  }
  const currentModelId = modelState.currentModelId.trim();
  const seen = new Set<string>();
  return modelState.availableModels.flatMap((model): ServerProviderModel[] => {
    const slug = resolveAuggieAcpBaseModelId(model.modelId);
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

export function buildInitialAuggieProviderSnapshot(
  auggieSettings: AuggieSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = auggieModelsFromSettings(auggieSettings.customModels);

    return buildServerProvider({
      presentation: AUGGIE_PRESENTATION,
      enabled: auggieSettings.enabled,
      checkedAt,
      models,
      probe: auggieSettings.enabled
        ? {
            installed: true,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Checking Auggie CLI availability...",
          }
        : {
            installed: false,
            version: null,
            status: "warning",
            auth: { status: "unknown" },
            message: "Auggie is disabled in T3 Code settings.",
          },
    });
  });
}

const runAuggieCliCommand = (
  auggieSettings: AuggieSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = auggieSettings.binaryPath || "auggie";
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkAuggieProviderStatus = Effect.fn("checkAuggieProviderStatus")(function* (
  auggieSettings: AuggieSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = auggieModelsFromSettings(auggieSettings.customModels);

  if (!auggieSettings.enabled) {
    return buildServerProvider({
      presentation: AUGGIE_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Auggie is disabled in T3 Code settings.",
      },
    });
  }

  const versionResult = yield* runAuggieCliCommand(auggieSettings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    yield* Effect.logWarning("Auggie CLI health check failed.", { errorTag: error._tag });
    return buildServerProvider({
      presentation: AUGGIE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: isCommandMissingCause(error)
          ? "Auggie CLI (`auggie`) is not installed or not on PATH."
          : "Failed to execute Auggie CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: AUGGIE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "Auggie CLI is installed but timed out while running `auggie --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    yield* Effect.logWarning("Auggie CLI version probe exited with a non-zero status.", {
      exitCode: versionOutput.code,
      stdoutLength: versionOutput.stdout.length,
      stderrLength: versionOutput.stderr.length,
    });
    return buildServerProvider({
      presentation: AUGGIE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: "unknown" },
        message: "Auggie CLI is installed but failed to run.",
      },
    });
  }

  const auth = yield* probeAuggieAuth(auggieSettings, environment);

  if (auth.status === "unauthenticated") {
    return buildServerProvider({
      presentation: AUGGIE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth,
        message: "Auggie CLI is installed but not logged in. Run `auggie login`.",
      },
    });
  }

  return buildServerProvider({
    presentation: AUGGIE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: "ready",
      auth,
    },
  });
});

/**
 * Sign-in state without starting the agent.
 *
 * Auggie advertises `authMethods: []` over ACP, so there is no protocol-level
 * way to ask. `auggie token print` is the supported automation hook: it exits
 * zero and writes the session to stdout when signed in. That output is the
 * credential itself — only its length and the exit code may be observed, and
 * neither the value nor any slice of it may reach a log or a snapshot message.
 */
const probeAuggieAuth = Effect.fn("probeAuggieAuth")(function* (
  auggieSettings: AuggieSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<ServerProviderAuth, never, ChildProcessSpawner.ChildProcessSpawner> {
  if (environment[AUGGIE_SESSION_AUTH_ENV]?.trim()) {
    return { status: "authenticated", type: "api_key", label: "Augment session" };
  }

  const tokenResult = yield* runAuggieCliCommand(
    auggieSettings,
    ["token", "print"],
    environment,
  ).pipe(Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS), Effect.result);

  if (Result.isFailure(tokenResult)) {
    yield* Effect.logWarning("Auggie sign-in probe failed.", {
      errorTag: tokenResult.failure._tag,
    });
    return { status: "unknown" };
  }
  if (Option.isNone(tokenResult.success)) {
    yield* Effect.logWarning("Auggie sign-in probe timed out.");
    return { status: "unknown" };
  }

  const output = tokenResult.success.value;
  if (output.code !== 0) {
    return { status: "unauthenticated" };
  }
  // A clean exit with nothing on stdout means the CLI ran but held no session.
  return output.stdout.trim().length > 0
    ? { status: "authenticated", type: "cached_token", label: "Augment account" }
    : { status: "unauthenticated" };
});

export const enrichAuggieSnapshot = (input: {
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
      Effect.logWarning("Auggie version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
};
