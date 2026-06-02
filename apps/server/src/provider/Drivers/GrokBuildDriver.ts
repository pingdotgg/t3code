import {
  GrokBuildSettings,
  ProviderDriverKind,
  type ServerProvider,
  TextGenerationError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Crypto from "effect/Crypto";
import * as Stream from "effect/Stream";
import * as Duration from "effect/Duration";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ProviderDriverError } from "../Errors.ts";
import { makeGrokBuildAdapter } from "../Layers/GrokBuildAdapter.ts";
import {
  buildInitialGrokBuildProviderSnapshot,
  checkGrokBuildProviderStatus,
} from "../Layers/GrokBuildProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { ServerConfig } from "../../config.ts";
import { type TextGenerationShape } from "../../textGeneration/TextGeneration.ts";

const DRIVER_KIND = ProviderDriverKind.make("grok-build");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(5);

export type GrokBuildDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig;

export const GrokBuildDriver: ProviderDriver<GrokBuildSettings, GrokBuildDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Grok Build",
    supportsMultipleInstances: true,
  },
  configSchema: GrokBuildSettings,
  defaultConfig: () => ({
    enabled: false,
    command: "grok",
    args: ["agent", "stdio"],
    envJson: "{}",
    customModels: [],
  }),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);

      const effectiveConfig = { ...config, enabled } as GrokBuildSettings;

      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });

      const stampIdentity = (snapshot: any): ServerProvider => ({
        ...snapshot,
        instanceId,
        driver: DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
      });

      const adapter = yield* makeGrokBuildAdapter(effectiveConfig, {
        environment: processEnv,
        ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        instanceId,
      });

      const textGeneration: TextGenerationShape = {
        generateCommitMessage: (_input) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateCommitMessage",
              detail: "Text generation is not supported by Grok Build.",
            }),
          ),
        generatePrContent: (_input) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generatePrContent",
              detail: "Text generation is not supported by Grok Build.",
            }),
          ),
        generateBranchName: (_input) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateBranchName",
              detail: "Text generation is not supported by Grok Build.",
            }),
          ),
        generateThreadTitle: (_input) =>
          Effect.fail(
            new TextGenerationError({
              operation: "generateThreadTitle",
              detail: "Text generation is not supported by Grok Build.",
            }),
          ),
      };

      const checkProvider = checkGrokBuildProviderStatus(effectiveConfig, processEnv).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );

      const snapshot = yield* makeManagedServerProvider<GrokBuildSettings>({
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          buildInitialGrokBuildProviderSnapshot(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
        maintenanceCapabilities: { provider: DRIVER_KIND, packageName: null, update: null },
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build Grok Build snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
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
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
