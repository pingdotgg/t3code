import { ProviderDriverKind } from "@t3tools/contracts";
import { GrokSettings } from "../settings.ts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ProviderLatestVersions from "@t3tools/provider-core/server/ProviderLatestVersions";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { makeGrokTextGeneration } from "./textGeneration.ts";
import { GrokAdapterV2Driver, type GrokAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import {
  buildInitialGrokProviderSnapshot,
  checkGrokProviderStatus,
  enrichGrokSnapshot,
} from "./status.ts";
import { grokUsageReader } from "./usage.ts";
import { readGrokAccount } from "./usageLimits.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { discoverGrokSkills } from "./skills.ts";
import {
  homebrewOwnershipFromCommandPath,
  isNixStoreCommandPath,
  makeCachedProviderMaintenanceResolution,
  makeManualOnlyProviderMaintenanceCapabilities,
  makeProviderMaintenanceCapabilities,
  type ProviderMaintenanceCapabilitiesResolver,
  resolveHomebrewProviderMaintenance,
  resolveMiseProviderMaintenance,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);

const DRIVER_KIND = ProviderDriverKind.make("grok");
// npm latest matches the stable channel installed by grok update.
const GROK_NPM_PACKAGE = "@xai-official/grok";
// npm 12 blocks the postinstall that moves the new binary in, yet exits 0, so allow it by env.
// Mise and Homebrew casks upgrade through their manager; `grok update` would install a second
// copy, so a cask its brew cannot vouch for stays manual, as does a Nix store install.
const UPDATE: ProviderMaintenanceCapabilitiesResolver = {
  resolve: Effect.fn("resolveGrokMaintenance")(function* (context) {
    if (!context) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: GROK_NPM_PACKAGE,
      });
    }
    const mise = yield* resolveMiseProviderMaintenance(
      { provider: DRIVER_KIND, packageName: GROK_NPM_PACKAGE },
      { tool: "grok" },
      context,
    );
    if (mise) return mise;
    if ([context.resolvedCommandPath, context.realCommandPath].some(isNixStoreCommandPath)) {
      return makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: GROK_NPM_PACKAGE,
        installPath: context.realCommandPath,
      });
    }
    const homebrew = homebrewOwnershipFromCommandPath(context.realCommandPath);
    // Only a cask is Grok's: a formula keg such as `node` holding an npm global is not.
    if (homebrew?.kind === "cask") {
      return (
        (yield* resolveHomebrewProviderMaintenance(
          { provider: DRIVER_KIND, packageName: GROK_NPM_PACKAGE },
          homebrew,
          context,
        )) ??
        makeManualOnlyProviderMaintenanceCapabilities({
          provider: DRIVER_KIND,
          packageName: GROK_NPM_PACKAGE,
          installPath: context.realCommandPath,
        })
      );
    }
    const path = yield* Path.Path;
    const fileSystem = yield* FileSystem.FileSystem;
    const name = path.basename(context.realCommandPath).toLowerCase();
    const installDir = path.dirname(context.realCommandPath);
    const installDirName = path.basename(installDir).toLowerCase();
    const home = path.dirname(installDir);
    // `grok update` installs under `$GROK_HOME`, so a script install keeps its own home even if the
    // instance sets another: `<home>/bin/grok` links into `<home>/downloads`, or on Windows is a copy
    // beside it. Only an install script creates `downloads`, so a bare `bin/grok` elsewhere is not one.
    const isScriptInstall =
      (installDirName === "downloads" && name.startsWith("grok-")) ||
      (installDirName === "bin" &&
        (/^grok-\d/.test(name) ||
          ((name === "grok" || name === "grok.exe") &&
            (yield* fileSystem
              .exists(path.join(home, "downloads"))
              .pipe(Effect.orElseSucceed(() => false))))));
    const scriptHome = isScriptInstall ? { GROK_HOME: home } : {};
    return makeProviderMaintenanceCapabilities({
      provider: DRIVER_KIND,
      packageName: GROK_NPM_PACKAGE,
      updateExecutable: context.resolvedCommandPath,
      updateArgs: ["update"],
      updateLockKey: "grok",
      platform: context.platform,
      env: {
        ...context.env,
        ...scriptHome,
        npm_config_allow_scripts: GROK_NPM_PACKAGE,
        // An npx-launched server's npm_config_user_agent outranks Grok's `[cli] installer`, steering
        // a script install to npm. The runner extends process.env; only undefined removes a key.
        npm_config_user_agent: undefined,
      },
    });
  }),
};

export type GrokDriverEnv =
  | GrokAdapterV2DriverEnv
  | ProviderHost.ProviderHost
  | ChildProcessSpawner.ChildProcessSpawner
  | SecureRandom.SecureRandom
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | ProviderLatestVersions.ProviderLatestVersions
  | Path.Path
  | ProviderEventLoggers.ProviderEventLoggers;

export const GrokDriver: ProviderDriver<GrokSettings, GrokDriverEnv, Path.Path> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Grok",
    supportsMultipleInstances: true,
  },
  configSchema: GrokSettings,
  defaultConfig: (): GrokSettings => decodeGrokSettings({}),
  usage: grokUsageReader,
  create: Effect.fn("GrokDriver.create")(function* ({
    instanceId,
    displayName,
    accentColor,
    environment,
    enabled,
    config,
  }) {
    const random = yield* SecureRandom.SecureRandom;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const httpClient = yield* HttpClient.HttpClient;
    const latestVersions = yield* ProviderLatestVersions.ProviderLatestVersions;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const host = yield* ProviderHost.ProviderHost;
    const { cwd } = host.paths;
    const processEnv = yield* mergeProviderInstanceEnvironment(environment);
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId,
      driverKind: DRIVER_KIND,
      displayName,
      accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const effectiveConfig = { ...config, enabled } satisfies GrokSettings;
    const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
      resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
        binaryPath: effectiveConfig.binaryPath,
        env: processEnv,
        npmCacheDir: path.join(host.paths.providerStatusCacheDir, "npm"),
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    );
    const orchestrationAdapter = yield* GrokAdapterV2Driver.create({
      instanceId,
      displayName,
      accentColor,
      environment,
      enabled,
      config,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Grok orchestration adapter.",
            cause,
          }),
      ),
    );
    const textGeneration = yield* makeGrokTextGeneration(effectiveConfig, processEnv);

    const checkProvider = checkGrokProviderStatus(effectiveConfig, processEnv, cwd).pipe(
      Effect.filterOrElse(
        (snapshot) =>
          !(
            effectiveConfig.enabled &&
            snapshot.installed &&
            snapshot.auth.status === "authenticated"
          ),
        (snapshot) =>
          readGrokAccount(processEnv).pipe(
            Effect.map(({ email, usageLimits }) => ({
              ...snapshot,
              auth: email ? { ...snapshot.auth, email } : snapshot.auth,
              usageLimits,
            })),
          ),
      ),
      Effect.map(stampIdentity),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(SecureRandom.SecureRandom, random),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );

    const checkUsageLimits = readGrokAccount(processEnv).pipe(
      Effect.map(({ email, usageLimits }) => ({
        usageLimits,
        ...(email ? { auth: { email } } : {}),
      })),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
    const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<GrokSettings>>({
      resolveMaintenance,
      getSettings: snapshotSettings.getSettings,
      streamSettings: snapshotSettings.streamSettings,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      // Each check starts the Grok CLI four times. A ready instance is rechecked on refresh or a
      // settings change; only an unhealthy one keeps polling until it recovers.
      refreshOnInterval: (snapshot) => snapshot.status !== "ready",
      initialSnapshot: (settings) =>
        buildInitialGrokProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
      checkUsageLimits,
      enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
        resolveMaintenance().pipe(
          Effect.flatMap((maintenanceCapabilities) =>
            enrichGrokSnapshot({
              snapshot: currentSnapshot,
              maintenanceCapabilities,
              enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
              publishSnapshot,
            }),
          ),
          Effect.provideService(HttpClient.HttpClient, httpClient),
          Effect.provideService(ProviderLatestVersions.ProviderLatestVersions, latestVersions),
        ),
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER_KIND,
            instanceId,
            detail: "Failed to build Grok snapshot.",
            cause,
          }),
      ),
    );
    const snapshotForCwd = (workspaceCwd: string) =>
      !effectiveConfig.enabled
        ? snapshot.getSnapshot
        : Effect.all([
            snapshot.getSnapshot,
            discoverGrokSkills(effectiveConfig, processEnv, workspaceCwd).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId,
                    detail: `Failed to discover Grok skills for '${workspaceCwd}'`,
                    cause,
                  }),
              ),
            ),
          ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })));

    return {
      instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName,
      accentColor,
      enabled,
      snapshot,
      snapshotForCwd,
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }),
};
