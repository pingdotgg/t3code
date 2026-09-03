import {
  AcpSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { tokenizeCliArgs } from "@t3tools/shared/cliArgs";
import { createModelCapabilities } from "@t3tools/shared/model";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeUnsupportedTextGeneration } from "../../textGeneration/TextGeneration.ts";
import * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  buildAcpModelCapabilities,
  extractModelOptions,
  sessionModelStateFromInitialize,
} from "../acp/AcpRuntimeModel.ts";
import { ProviderDriverError } from "../Errors.ts";
import { type AcpAdapterProfile, makeAcpAdapter } from "../Layers/CursorAdapter.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { buildServerProvider, providerModelsFromSettings } from "../providerSnapshot.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("acp");
const decodeSettings = Schema.decodeSync(AcpSettings);
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const defaultModels = (capabilities: ModelCapabilities = EMPTY_CAPABILITIES) => [
  {
    slug: "agent-default",
    name: "Agent default",
    isCustom: false,
    capabilities,
  },
];

/** Models an agent advertised on its initialize response, current one first. */
function modelsFromInitialize(
  modelState: EffectAcpSchema.SessionModelState | undefined,
  capabilities: ModelCapabilities,
): ReadonlyArray<ServerProviderModel> {
  if (!modelState) {
    return [];
  }
  const currentModelId = modelState.currentModelId.trim();
  const seen = new Set<string>();
  const models = modelState.availableModels.flatMap((model): ServerProviderModel[] => {
    const slug = model.modelId.trim();
    if (!slug || seen.has(slug)) {
      return [];
    }
    seen.add(slug);
    return [
      {
        slug,
        name: model.name.trim() || slug,
        isCustom: false,
        ...(slug === currentModelId ? { isDefault: true } : {}),
        capabilities,
      },
    ];
  });
  // Agents return their list in whatever order the provider does; show the
  // current model first and the rest alphabetically.
  return models.toSorted(
    (left, right) =>
      Number(right.isDefault === true) - Number(left.isDefault === true) ||
      left.name.localeCompare(right.name),
  );
}

/**
 * Reads `_meta.availableCommands` from an initialize response. The field is
 * optional and agent-defined, so anything unexpected is ignored rather than
 * failing the probe.
 */
function parseAdvertisedCommands(
  meta: { readonly [key: string]: unknown } | null | undefined,
): ReadonlyArray<EffectAcpSchema.AvailableCommand> {
  const advertised = meta?.availableCommands;
  if (!Array.isArray(advertised)) {
    return [];
  }
  return advertised.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) {
      return [];
    }
    const { name, description } = entry as { name?: unknown; description?: unknown };
    return typeof name === "string" && name.length > 0
      ? [
          {
            name,
            description: typeof description === "string" ? description : "",
          } as EffectAcpSchema.AvailableCommand,
        ]
      : [];
  });
}

function missingCommandMessage(command: string): string {
  return command ? `${command} is not installed or not on PATH.` : "Configure an ACP CLI command.";
}
export type AcpDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ServerSettingsService;

export const AcpDriver: ProviderDriver<AcpSettings, AcpDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: { displayName: "ACP Agent", supportsMultipleInstances: true },
  configSchema: AcpSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const driverScope = yield* Scope.Scope;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const observedCommandsRef = yield* Ref.make<ReadonlyArray<EffectAcpSchema.AvailableCommand>>(
        [],
      );
      const observedConfigRef = yield* Ref.make<ReadonlyArray<EffectAcpSchema.SessionConfigOption>>(
        [],
      );
      const agentName = displayName?.trim() || path.basename(config.binaryPath) || "ACP Agent";
      const makeRuntime: AcpAdapterProfile["makeRuntime"] = ({
        childProcessSpawner,
        environment: runtimeEnvironment,
        ...input
      }) =>
        AcpSessionRuntime.make({
          ...input,
          spawn: {
            command: config.binaryPath,
            args: tokenizeCliArgs(config.launchArgs),
            cwd: input.cwd,
            ...(runtimeEnvironment ? { env: runtimeEnvironment } : {}),
          },
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
        );
      const makeSnapshot = (input: {
        readonly checkedAt: string;
        readonly installed: boolean;
        readonly status: "ready" | "warning" | "error";
        readonly message: string;
        readonly displayName?: string;
        readonly version?: string | null;
        readonly models?: ReadonlyArray<ServerProviderModel>;
        readonly slashCommands?: ReadonlyArray<EffectAcpSchema.AvailableCommand>;
      }) => ({
        ...buildServerProvider({
          presentation: { displayName: displayName?.trim() || input.displayName || agentName },
          enabled,
          checkedAt: input.checkedAt,
          slashCommands: (input.slashCommands ?? []).map((command) => ({
            name: command.name,
            ...(command.description.trim() ? { description: command.description.trim() } : {}),
          })),
          models: providerModelsFromSettings(
            input.models ?? defaultModels(),
            config.customModels,
            EMPTY_CAPABILITIES,
          ),
          probe: {
            installed: input.installed,
            version: input.version ?? null,
            status: input.status,
            auth: { status: "unknown" },
            message: input.message,
          },
        }),
        instanceId,
        driver: DRIVER_KIND,
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });
      const unavailableSnapshot = (
        checkedAt: string,
        message: string,
        installed = false,
        status: "warning" | "error" = installed ? "warning" : "error",
      ) => makeSnapshot({ checkedAt, installed, status, message });
      const initialSnapshot = () =>
        Effect.map(DateTime.now, (now) =>
          unavailableSnapshot(
            DateTime.formatIso(now),
            config.binaryPath ? "Discovering ACP models..." : missingCommandMessage(""),
            config.binaryPath.length > 0,
          ),
        );
      const checkProvider = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        if (!enabled) {
          return unavailableSnapshot(
            checkedAt,
            "ACP agent is disabled in T3 Code settings.",
            false,
            "warning",
          );
        }
        const installed =
          config.binaryPath.length > 0 &&
          (yield* isCommandAvailable(config.binaryPath, { env: processEnv }));
        if (!installed) {
          return unavailableSnapshot(checkedAt, missingCommandMessage(config.binaryPath));
        }

        const connected = yield* makeRuntime({
          childProcessSpawner: spawner,
          environment: processEnv,
          cwd: serverConfig.cwd,
          clientInfo: { name: "t3-code", version: "0.0.0" },
        }).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.flatMap((runtime) => runtime.initialize()),
          Effect.scoped,
          Effect.timeout("10 seconds"),
          Effect.result,
        );
        if (Result.isFailure(connected)) {
          const failure = connected.failure;
          const authRequired = failure._tag === "AcpRequestError" && failure.code === -32000;
          return unavailableSnapshot(
            checkedAt,
            authRequired
              ? "Authentication required. Sign in with the configured CLI outside T3 Code, then retry."
              : "The ACP process started, but its initialize handshake failed.",
            true,
          );
        }

        const agentInfo = connected.success.agentInfo;
        // ACP advertises commands per session, so a client has nothing to show
        // until the first message. Agents may also publish the list on the
        // initialize response, which the probe can read before any session.
        const advertisedCommands = parseAdvertisedCommands(connected.success._meta);
        if (advertisedCommands.length > 0) {
          yield* Ref.set(observedCommandsRef, advertisedCommands);
        }
        const observedOptions = yield* Ref.get(observedConfigRef);
        const modelCapabilities = buildAcpModelCapabilities(observedOptions);
        const configuredModels = extractModelOptions(observedOptions).map((model) => ({
          slug: model.id,
          name: model.name,
          isCustom: false,
          ...(model.isDefault ? { isDefault: true } : {}),
          capabilities: modelCapabilities,
        }));
        // Models are session state in ACP, so an agent that advertises them on
        // the initialize response gives the model picker something to show
        // before any session exists. That list comes from the probe that just
        // ran; the session config options may have been observed from an
        // earlier session against an older agent build, so the advertised list
        // wins when present.
        const advertisedModels = modelsFromInitialize(
          sessionModelStateFromInitialize(connected.success),
          modelCapabilities,
        );
        const models = advertisedModels.length > 0 ? advertisedModels : configuredModels;
        const discoveredDisplayName = agentInfo?.title?.trim() || agentInfo?.name.trim();
        return makeSnapshot({
          checkedAt,
          installed: true,
          status: "ready",
          message:
            models.length > 0
              ? `${models.length} ACP models discovered.`
              : "ACP handshake succeeded. Models are discovered from the first active session.",
          ...(discoveredDisplayName ? { displayName: discoveredDisplayName } : {}),
          version: agentInfo?.version.trim() || null,
          // "Agent default" only stands in while the agent has not reported
          // models. Once it has, its current model is marked as the default
          // and the placeholder would be a second way to say the same thing.
          models: models.length > 0 ? models : defaultModels(modelCapabilities),
          slashCommands: yield* Ref.get(observedCommandsRef),
        });
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      );
      const snapshot = yield* makeManagedServerProvider<AcpSettings>({
        maintenanceCapabilities: MAINTENANCE_CAPABILITIES,
        getSettings: Effect.succeed(config),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot,
        checkProvider,
        refreshOnInterval: false,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build ACP snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const onConfigOptionsChanged = (
        options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
      ) =>
        Ref.set(observedConfigRef, options).pipe(
          Effect.andThen(
            snapshot.refresh.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to refresh ACP model metadata.", { cause }),
              ),
              Effect.forkIn(driverScope),
              Effect.asVoid,
            ),
          ),
        );
      const onAvailableCommandsChanged = (
        commands: ReadonlyArray<EffectAcpSchema.AvailableCommand>,
      ) =>
        Ref.set(observedCommandsRef, commands).pipe(
          Effect.andThen(
            snapshot.refresh.pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to refresh ACP slash commands.", { cause }),
              ),
              Effect.forkIn(driverScope),
              Effect.asVoid,
            ),
          ),
        );
      const adapter = yield* makeAcpAdapter(
        {
          provider: DRIVER_KIND,
          displayName: agentName,
          modelSelection: "standard",
          onConfigOptionsChanged,
          onAvailableCommandsChanged,
          makeRuntime,
        },
        { environment: processEnv, instanceId },
      );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration: makeUnsupportedTextGeneration(agentName),
      };
    }),
};
