import {
  type CustomModelSetting,
  type ModelCapabilities,
  type ServerProvider,
  type ServerProviderModel,
  ZCODE_DEFAULT_MODEL,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { createModelCapabilities } from "@t3tools/shared/model";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  providerModelsFromSettings,
  type ServerProviderDraft,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  enrichProviderSnapshotWithVersionAdvisory,
  type ProviderMaintenanceCapabilities,
} from "@t3tools/provider-core/server/maintenanceResolver";
import type { ZCodeSettings } from "../settings.ts";
import {
  makeZCodeAcpRuntime,
  ZCODE_ACP_AUTH_METHOD_ID,
  ZCODE_SUPPORTED_RUNTIME_MODES,
} from "./acpSupport.ts";
import type { ZCodeLiveConfiguration, ZCodeLiveStateValue } from "./liveState.ts";

const ZCODE_PRESENTATION = {
  displayName: "ZCode",
  supportsConversationRollback: false,
  showInteractionModeToggle: false,
  supportedRuntimeModes: ZCODE_SUPPORTED_RUNTIME_MODES,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

// The bridge starts Node and loads its config before answering `initialize`.
const ZCODE_ACP_INITIALIZE_TIMEOUT_MS = 15_000;
const ZCODE_BRIDGE_INSTALL_HINT = "Install it with `npm install -g zcode-acp-server`.";
// T3's runtime mode owns ZCode's permission mode, so the session's own mode
// selector is not offered as a model option.
const ZCODE_MODE_CONFIG_ID = "mode";

const ZCODE_DEFAULT_MODEL_ENTRY: ServerProviderModel = {
  slug: ZCODE_DEFAULT_MODEL,
  name: "ZCode default",
  isCustom: false,
  capabilities: EMPTY_CAPABILITIES,
};

function zcodeModelsFromSettings(
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
  builtInModels: ReadonlyArray<ServerProviderModel> = [ZCODE_DEFAULT_MODEL_ENTRY],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtInModels, customModels ?? [], EMPTY_CAPABILITIES);
}

/**
 * The models a live ZCode session offers. The default alias stays first so a
 * thread that never picked a model keeps following ZCode's own selection; it
 * is not labelled with a model because live sessions can each run another.
 */
export function zcodeModelsFromLiveConfiguration(
  configuration: ZCodeLiveConfiguration,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): ReadonlyArray<ServerProviderModel> {
  const optionDescriptors = configuration.configOptions.filter(
    (descriptor) => descriptor.id !== ZCODE_MODE_CONFIG_ID,
  );
  const capabilities =
    optionDescriptors.length === 0
      ? EMPTY_CAPABILITIES
      : createModelCapabilities({ optionDescriptors });
  return zcodeModelsFromSettings(customModels, [
    {
      ...ZCODE_DEFAULT_MODEL_ENTRY,
      capabilities,
    },
    ...configuration.models.map((model) => ({
      slug: model.id,
      name: model.name,
      isCustom: false,
      capabilities,
    })),
  ]);
}

/** Overlays what the instance's live sessions advertised onto a status snapshot. */
export function applyZCodeLiveState<P extends ServerProvider | ServerProviderDraft>(
  provider: P,
  state: ZCodeLiveStateValue,
  customModels: ReadonlyArray<CustomModelSetting> | undefined,
): P {
  const commands = state.commands;
  const slashCommands =
    commands === undefined
      ? provider.slashCommands
      : commands.slashCommands.some((command) => command.name === COMPACT_SLASH_COMMAND.name)
        ? commands.slashCommands
        : [COMPACT_SLASH_COMMAND, ...commands.slashCommands];
  return {
    ...provider,
    ...(state.configuration === undefined
      ? {}
      : { models: zcodeModelsFromLiveConfiguration(state.configuration, customModels) }),
    ...(commands === undefined ? {} : { slashCommands, skills: commands.skills }),
  };
}

export function buildInitialZCodeProviderSnapshot(
  zcodeSettings: ZCodeSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: zcodeSettings.enabled,
      checkedAt,
      models: zcodeModelsFromSettings(zcodeSettings.customModels),
      probe: {
        installed: zcodeSettings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: zcodeSettings.enabled
          ? "Checking the ZCode ACP bridge..."
          : "ZCode is disabled in T3 Code settings.",
      },
    });
  });
}

/**
 * Reads the bridge version and auth methods from `initialize`. The bridge
 * starts ZCode's app-server only for a session, so this never opens one, never
 * boots the workspace's MCP servers, and spends no plan quota.
 */
const probeZCodeBridge = (
  zcodeSettings: ZCodeSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
) =>
  Effect.gen(function* () {
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const acp = yield* makeZCodeAcpRuntime({
      zcodeSettings,
      environment,
      childProcessSpawner,
      cwd,
      clientInfo: { name: "t3-code-provider-probe", version: "0.0.0" },
    });
    const initialized = yield* acp.initialize();
    return {
      version: initialized.agentInfo?.version?.trim() || null,
      hasZCodeCredentials: (initialized.authMethods ?? []).some(
        (method) => method.id === ZCODE_ACP_AUTH_METHOD_ID,
      ),
    };
  }).pipe(Effect.scoped);

export const checkZCodeProviderStatus = Effect.fn("checkZCodeProviderStatus")(function* (
  zcodeSettings: ZCodeSettings,
  environment: NodeJS.ProcessEnv,
  cwd: string,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = zcodeModelsFromSettings(zcodeSettings.customModels);

  if (!zcodeSettings.enabled) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "ZCode is disabled in T3 Code settings.",
      },
    });
  }

  const probeExit = yield* probeZCodeBridge(zcodeSettings, environment, cwd).pipe(
    Effect.timeoutOption(ZCODE_ACP_INITIALIZE_TIMEOUT_MS),
    Effect.exit,
  );

  if (Exit.isFailure(probeExit)) {
    const error = Option.getOrUndefined(Cause.findErrorOption(probeExit.cause));
    const missing = error?._tag === "AcpSpawnError" && isCommandMissingCause(error.cause);
    yield* Effect.logWarning("ZCode ACP bridge probe failed.", {
      errorTag: causeErrorTag(probeExit.cause),
    });
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? `The ZCode ACP bridge (\`${zcodeSettings.binaryPath}\`) is not installed or not on PATH. ${ZCODE_BRIDGE_INSTALL_HINT}`
          : "The ZCode ACP bridge failed to start.",
      },
    });
  }

  if (Option.isNone(probeExit.value)) {
    return buildServerProvider({
      presentation: ZCODE_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "The ZCode ACP bridge timed out during `initialize`.",
      },
    });
  }

  const probe = probeExit.value.value;
  return buildServerProvider({
    presentation: ZCODE_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe: {
      installed: true,
      version: probe.version,
      status: probe.hasZCodeCredentials ? "ready" : "warning",
      // The bridge reads the ZCode desktop app's plan credentials only when a
      // session starts, so sign-in is not known until then.
      auth: { status: "unknown" },
      ...(probe.hasZCodeCredentials
        ? {}
        : {
            message:
              "The ZCode ACP bridge did not offer ZCode credentials. Sign in with the ZCode desktop app.",
          }),
    },
  });
});

export const enrichZCodeSnapshot = (input: {
  readonly snapshot: ServerProvider;
  readonly maintenanceCapabilities: ProviderMaintenanceCapabilities;
  readonly enableProviderUpdateChecks?: boolean;
  readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  readonly httpClient: HttpClient.HttpClient;
}): Effect.Effect<void> =>
  enrichProviderSnapshotWithVersionAdvisory(input.snapshot, input.maintenanceCapabilities, {
    enableProviderUpdateChecks: input.enableProviderUpdateChecks,
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.httpClient),
    Effect.flatMap((enrichedSnapshot) => input.publishSnapshot(enrichedSnapshot)),
    Effect.catchCause((cause) =>
      Effect.logWarning("ZCode version advisory enrichment failed", {
        errorTag: causeErrorTag(cause),
      }),
    ),
    Effect.asVoid,
  );
