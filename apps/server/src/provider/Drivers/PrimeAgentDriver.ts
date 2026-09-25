import { PrimeAgentSettings, ProviderDriverKind, ProviderSetupError } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import type * as EffectAcpSchema from "effect-acp/schema";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makePrimeAgentTextGeneration } from "../../textGeneration/PrimeAgentTextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makePrimeAgentAdapter } from "../Layers/PrimeAgentAdapter.ts";
import { makePrimeAgentProvider } from "../Layers/PrimeAgentProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { parseGenericCliVersion, spawnAndCollect } from "../providerSnapshot.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  buildPrimeAgentAcpSpawnInput,
  makePrimeAgentAcpRuntime,
  type PrimeAgentAcpRuntimeOptions,
} from "../acp/PrimeAgentAcpSupport.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const DRIVER = ProviderDriverKind.make("primeAgent");
const decodeSettings = Schema.decodeSync(PrimeAgentSettings);

export type PrimeAgentDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const PrimeAgentDriver: ProviderDriver<PrimeAgentSettings, PrimeAgentDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Prime Agent", supportsMultipleInstances: true },
  configSchema: PrimeAgentSettings,
  defaultConfig: (): PrimeAgentSettings => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const crypto = yield* Crypto.Crypto;
      const loggers = yield* ProviderEventLoggers;
      const settings = { ...config, enabled } satisfies PrimeAgentSettings;
      const processEnvironment = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });

      const makeRuntime = (input: PrimeAgentAcpRuntimeOptions) =>
        makePrimeAgentAcpRuntime({
          ...input,
          childProcessSpawner: spawner,
          primeAgentSettings: settings,
          environment: processEnvironment,
          spawn: buildPrimeAgentAcpSpawnInput(settings, input.cwd, processEnvironment),
        }).pipe(Effect.provideService(Crypto.Crypto, crypto));

      // Health runs --version so a status poll never starts Prime Agent's daemon.
      const probe = Effect.gen(function* () {
        const command = settings.binaryPath.trim() || "prime-agent";
        const result = yield* spawnAndCollect(
          command,
          ChildProcess.make(command, ["--version"], { env: processEnvironment }),
        ).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.mapError(
            (cause) =>
              new ProviderSetupError({
                instanceId,
                operation: "resolve",
                detail: `Prime Agent is not installed or its executable could not be found at '${command}'.`,
                cause,
              }),
          ),
        );
        if (result.code !== 0) {
          return yield* new ProviderSetupError({
            instanceId,
            operation: "resolve",
            detail: `Prime Agent exited with code ${result.code} when reporting its version.`,
          });
        }
        const version = parseGenericCliVersion(result.stdout || result.stderr) ?? "unknown";
        return {
          protocolVersion: 1,
          agentCapabilities: {
            loadSession: false,
            promptCapabilities: { image: true, embeddedContext: true },
            sessionCapabilities: { close: {} },
          },
          authMethods: [],
          agentInfo: { name: "prime-agent", title: "Prime Agent", version },
        } satisfies EffectAcpSchema.InitializeResponse;
      });

      const provider = yield* makePrimeAgentProvider(settings, { stampIdentity, probe }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Could not prepare the Prime Agent provider status.",
              cause,
            }),
        ),
      );
      const adapter = yield* makePrimeAgentAdapter(settings, {
        instanceId,
        makeRuntime,
        onSessionStarted: provider.onSessionStarted,
        onConfigOptionsUpdated: provider.onConfigOptionsUpdated,
        onAvailableCommands: provider.onAvailableCommands,
        ...(loggers.native ? { nativeEventLogger: loggers.native } : {}),
      });

      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot: provider.snapshot,
        snapshotForCwd: (cwd) => provider.snapshotForCwd(cwd),
        adapter,
        textGeneration: makePrimeAgentTextGeneration(),
      } satisfies ProviderInstance;
    }),
};
