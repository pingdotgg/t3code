import { ProviderDriverKind, T3ChatSettings, type ServerProvider } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TextGenerationError } from "@t3tools/contracts";
import { ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";

import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeT3ChatAdapter } from "../Layers/T3ChatAdapter.ts";
import { checkT3ChatProviderStatus, makePendingT3ChatProvider } from "../Layers/T3ChatProvider.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import type { ServerProviderDraft } from "../providerSnapshot.ts";
import { T3ChatRuntime } from "../t3chatRuntime.ts";

const decodeT3ChatSettings = Schema.decodeSync(T3ChatSettings);

const DRIVER_KIND = ProviderDriverKind.make("t3chat");
const SNAPSHOT_REFRESH_INTERVAL = Duration.minutes(10);

const withInstanceIdentity =
  (input: {
    readonly instanceId: ProviderInstance["instanceId"];
    readonly displayName: string | undefined;
    readonly accentColor: string | undefined;
  }) =>
  (snapshot: ServerProviderDraft): ServerProvider => ({
    ...snapshot,
    instanceId: input.instanceId,
    driver: DRIVER_KIND,
    ...(input.displayName ? { displayName: input.displayName } : {}),
    ...(input.accentColor ? { accentColor: input.accentColor } : {}),
  });

const makeT3ChatTextGeneration = (): TextGenerationShape => ({
  generateCommitMessage: (_input) =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateCommitMessage",
        detail: "T3 Chat does not support commit message generation.",
      }),
    ),
  generatePrContent: (_input) =>
    Effect.fail(
      new TextGenerationError({
        operation: "generatePrContent",
        detail: "T3 Chat does not support PR content generation.",
      }),
    ),
  generateBranchName: (_input) =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateBranchName",
        detail: "T3 Chat does not support branch name generation.",
      }),
    ),
  generateThreadTitle: (_input) =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateThreadTitle",
        detail: "T3 Chat does not support thread title generation.",
      }),
    ),
});

export type T3ChatDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | ProviderEventLoggers
  | ServerConfig
  | T3ChatRuntime;

export const T3ChatDriver: ProviderDriver<T3ChatSettings, T3ChatDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "T3 Chat",
    supportsMultipleInstances: true,
  },
  configSchema: T3ChatSettings,
  defaultConfig: (): T3ChatSettings => decodeT3ChatSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const t3ChatRuntime = yield* T3ChatRuntime;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const effectiveConfig = { ...config, enabled } satisfies T3ChatSettings;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });

      const stampIdentity = withInstanceIdentity({
        instanceId,
        displayName,
        accentColor,
      });

      const adapter = yield* makeT3ChatAdapter(effectiveConfig, {
        instanceId,
        environment: processEnv,
      }).pipe(
        Effect.provideService(T3ChatRuntime, t3ChatRuntime),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to create T3 Chat adapter: ${cause.detail ?? cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );
      const textGeneration = makeT3ChatTextGeneration();

      const checkProvider = checkT3ChatProviderStatus(effectiveConfig).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(T3ChatRuntime, t3ChatRuntime),
      );

      const snapshot = yield* makeManagedServerProvider<T3ChatSettings>({
        maintenanceCapabilities: {
          provider: DRIVER_KIND,
          packageName: null,
          update: null,
        },
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.never,
        haveSettingsChanged: () => false,
        initialSnapshot: (settings) =>
          makePendingT3ChatProvider(settings).pipe(Effect.map(stampIdentity)),
        checkProvider,
        refreshInterval: SNAPSHOT_REFRESH_INTERVAL,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build T3 Chat snapshot: ${cause.message ?? String(cause)}`,
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
