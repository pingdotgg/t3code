import type * as EffectAcpSchema from "effect-acp/compat";
import {
  type RuntimeMode,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import type { VibeSettings } from "../settings.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import type * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  acpProviderOptionDescriptors,
  flattenSelectChoices,
} from "@t3tools/provider-acp/server/sessionConfig";
import { findModelConfigOption } from "@t3tools/provider-acp/server/runtimeModel";
import {
  makeVibeAcpRuntime,
  VIBE_DEFAULT_MODEL_SLUG,
  VIBE_DRIVER_KIND,
  VIBE_MODE_CONFIG_ID,
  VIBE_SUPPORTED_RUNTIME_MODES,
  vibeRuntimeModeForSessionMode,
} from "./acpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  type ProviderProbeResult,
  providerModelsFromSettings,
  type ServerProviderDraft,
  spawnAndCollect,
} from "@t3tools/provider-core/server/snapshotProbe";

const VIBE_PRESENTATION = {
  displayName: "Mistral Vibe",
  showInteractionModeToggle: false,
} as const;
const VERSION_PROBE_TIMEOUT_MS = 10_000;
const NO_OPTIONS = createModelCapabilities({ optionDescriptors: [] });

/** `_auth/status` on vibe-acp 3.0: `authenticated` is whether the active provider can be used. */
const decodeVibeAuthStatus = Schema.decodeUnknownOption(
  Schema.Struct({ authenticated: Schema.Boolean }),
);

export function vibeAuthFromStatusReport(report: unknown): ServerProviderAuth {
  const decoded = decodeVibeAuthStatus(report);
  if (Option.isNone(decoded)) return { status: "unknown" };
  return { status: decoded.value.authenticated ? "authenticated" : "unauthenticated" };
}

/**
 * Vibe's model choices from a session's config options. "Default" keeps the
 * session's own model. Vibe lists thinking levels for that model only, so the
 * others carry none. The mode option is left out: T3's runtime mode selects
 * the Vibe agent.
 */
export function vibeModelsFromConfigOptions(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ReadonlyArray<ServerProviderModel> {
  const currentCapabilities = createModelCapabilities({
    optionDescriptors: acpProviderOptionDescriptors({
      configOptions: configOptions.filter((option) => option.id !== VIBE_MODE_CONFIG_ID),
      modeState: undefined,
    }),
  });
  const modelOption = findModelConfigOption(configOptions);
  const choices = modelOption?.type === "select" ? flattenSelectChoices(modelOption.options) : [];
  const current = modelOption?.type === "select" ? modelOption.currentValue : undefined;
  const currentName = choices.find((choice) => choice.value === current)?.name;
  return [
    {
      slug: VIBE_DEFAULT_MODEL_SLUG,
      name: currentName === undefined ? "Default" : `Default (${currentName})`,
      ...(current === undefined ? {} : { aliases: [current] }),
      isCustom: false,
      isDefault: true,
      capabilities: currentCapabilities,
    },
    ...choices
      .filter((choice) => choice.value !== VIBE_DEFAULT_MODEL_SLUG)
      .map((choice) => ({
        slug: choice.value,
        name: choice.name || choice.value,
        isCustom: false,
        capabilities: choice.value === current ? currentCapabilities : NO_OPTIONS,
      })),
  ];
}

/**
 * The runtime modes whose Vibe agent the session lists. Vibe config can turn an
 * agent off (`enable_auto_approve = false`), and selecting it then fails.
 */
export function vibeRuntimeModes(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | undefined,
): ReadonlyArray<RuntimeMode> {
  const modeOption = configOptions?.find(
    (option) => option.id === VIBE_MODE_CONFIG_ID && option.type === "select",
  );
  if (modeOption?.type !== "select") return VIBE_SUPPORTED_RUNTIME_MODES;
  const listed = flattenSelectChoices(modeOption.options).map((choice) =>
    vibeRuntimeModeForSessionMode(choice.value),
  );
  const modes = VIBE_SUPPORTED_RUNTIME_MODES.filter((mode) => listed.includes(mode));
  return modes.length > 0 ? modes : VIBE_SUPPORTED_RUNTIME_MODES;
}

const snapshot = (
  settings: VibeSettings,
  checkedAt: string,
  probe: ProviderProbeResult,
  configOptions?: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
): ServerProviderDraft => {
  const models = vibeModelsFromConfigOptions(configOptions ?? []);
  return {
    ...buildServerProvider({
      driver: VIBE_DRIVER_KIND,
      presentation: {
        ...VIBE_PRESENTATION,
        supportedRuntimeModes: vibeRuntimeModes(configOptions),
      },
      enabled: settings.enabled,
      checkedAt,
      models: providerModelsFromSettings(models, settings.customModels, NO_OPTIONS),
      probe,
    }),
    supportsTextGeneration: false,
  };
};

export const buildInitialVibeProviderSnapshot = (
  settings: VibeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.map(DateTime.now, (now) =>
    snapshot(settings, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking Mistral Vibe availability..."
        : "Mistral Vibe is disabled in T3 Code settings.",
    }),
  );

const runVibeVersion = Effect.fn("runVibeVersion")(function* (
  settings: VibeSettings,
  environment: NodeJS.ProcessEnv,
) {
  const command = settings.binaryPath || "vibe-acp";
  const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
  return yield* spawnAndCollect(
    command,
    ChildProcess.make(spawnCommand.command, spawnCommand.args, {
      env: environment,
      shell: spawnCommand.shell,
    }),
  );
});

/**
 * `initialize` and `_auth/status` need no session. Only a signed-in Vibe gets
 * a `session/new` for its model list: Vibe saves no session until a prompt,
 * and signed out it refuses to open one.
 */
const probeVibeAcp = Effect.fn("VibeProvider.probeVibeAcp")(function* (
  settings: VibeSettings,
  environment: NodeJS.ProcessEnv,
) {
  const runtime = yield* makeVibeAcpRuntime({
    settings,
    environment,
    cwd: yield* HostProcess.WorkingDirectory,
    clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
  });
  const auth = yield* runtime.initialize().pipe(
    Effect.andThen(runtime.request("_auth/status", {})),
    Effect.map(vibeAuthFromStatusReport),
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.map(Option.getOrElse((): ServerProviderAuth => ({ status: "unknown" }))),
    Effect.orElseSucceed((): ServerProviderAuth => ({ status: "unknown" })),
  );
  if (auth.status !== "authenticated") return { auth, configOptions: undefined };
  const configOptions = yield* runtime.start().pipe(
    Effect.map((started) => started.sessionSetupResult.configOptions ?? []),
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.map(Option.getOrUndefined),
    Effect.orElseSucceed(() => undefined),
  );
  return { auth, configOptions };
}, Effect.scoped);

/** The snapshot status for what the ACP probe learned. */
export function vibeProbeStatus(
  auth: ServerProviderAuth,
  modelsListed: boolean,
): Pick<ProviderProbeResult, "status" | "message"> {
  if (auth.status === "unauthenticated") {
    return {
      status: "error",
      message: "Mistral Vibe is not signed in. Run `vibe --setup` or set MISTRAL_API_KEY.",
    };
  }
  if (auth.status !== "authenticated") {
    return { status: "warning", message: "Could not confirm the Mistral Vibe sign-in." };
  }
  return modelsListed
    ? { status: "ready" }
    : {
        status: "warning",
        message: "Mistral Vibe is signed in but its models could not be listed.",
      };
}

export const checkVibeProviderStatus = Effect.fn("checkVibeProviderStatus")(function* (
  settings: VibeSettings,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | SecureRandom.SecureRandom
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  if (!settings.enabled) {
    return snapshot(settings, checkedAt, {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Mistral Vibe is disabled in T3 Code settings.",
    });
  }

  const versionResult = yield* runVibeVersion(settings, environment).pipe(
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
        ? "Mistral Vibe (`vibe-acp`) is not installed or not on PATH."
        : "Failed to run `vibe-acp --version`.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return snapshot(settings, checkedAt, {
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: "Mistral Vibe is installed but `vibe-acp` failed to run.",
    });
  }

  const probed = yield* probeVibeAcp(settings, environment).pipe(
    Effect.orElseSucceed(() => ({
      auth: { status: "unknown" } satisfies ServerProviderAuth,
      configOptions: undefined,
    })),
  );
  return snapshot(
    settings,
    checkedAt,
    {
      installed: true,
      version,
      auth: probed.auth,
      ...vibeProbeStatus(probed.auth, probed.configOptions !== undefined),
    },
    probed.configOptions,
  );
});
