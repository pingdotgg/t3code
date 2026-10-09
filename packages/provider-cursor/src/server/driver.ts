/**
 * CursorDriver — `ProviderDriver` for the Cursor Agent SDK runtime.
 *
 * Provider status, model discovery, orchestration, and text generation use the
 * official Cursor SDK with an instance browser login or CURSOR_API_KEY.
 *
 * @module provider/Drivers/CursorDriver
 */
import { ProviderDriverKind, ProviderSetupError } from "@t3tools/contracts";
import { CursorSettings } from "../settings.ts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import { readCursorUsageLimits } from "./usageLimits.ts";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import { makeCursorTextGeneration } from "./textGeneration.ts";
import { CursorAdapterV2Driver, type CursorAdapterV2DriverEnv } from "./adapter.ts";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { buildInitialCursorProviderSnapshot, checkCursorProviderStatus } from "./status.ts";
import * as CursorSdkCatalog from "./CursorSdkCatalog.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "@t3tools/provider-core/server/snapshotSettings";
import { probeCursorSkills } from "./skills.ts";
import { makeCursorAuth } from "./auth.ts";
import * as CursorCredentialStore from "./credentialStore.ts";
import * as CursorAgentSdk from "./CursorAgentSdk.ts";
import * as CursorSdk from "./CursorSdk.ts";
import * as CursorKeychain from "./CursorKeychain.ts";
import * as CursorUsageAccounts from "./CursorUsageAccounts.ts";

const decodeCursorSettings = Schema.decodeSync(CursorSettings);
const isSdkRunnerError = Schema.is(CursorAgentSdk.CursorAgentSdkRunnerError);

const DRIVER_KIND = ProviderDriverKind.make("cursor");
const MAINTENANCE_CAPABILITIES = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER_KIND,
  packageName: null,
});

export type CursorDriverEnv =
  | CursorAdapterV2DriverEnv
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | CursorSdk.CursorSdk
  | ProviderHost.ProviderHost
  | CursorKeychain.CursorKeychain;

export const CursorDriver: ProviderDriver<
  CursorSettings,
  CursorDriverEnv,
  CursorUsageAccounts.CursorUsageAccounts
> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Cursor",
    supportsMultipleInstances: true,
  },
  configSchema: CursorSettings,
  defaultConfig: (): CursorSettings => decodeCursorSettings({}),
  // One account source per environment: the host's Cursor CLI login.
  usage: {
    kind: "scan",
    provider: "cursor",
    scan: ({ settings, windowStartMs, retentionCutoffMs, awaitRefresh }) =>
      CursorUsageAccounts.CursorUsageAccounts.pipe(
        Effect.flatMap((accounts) =>
          accounts.scan({
            keychainUsageEnabled: settings.cursorKeychainUsageEnabled,
            windowStartMs,
            retentionCutoffMs,
            awaitRefresh,
          }),
        ),
      ),
  },
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const host = yield* ProviderHost.ProviderHost;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const keychain = yield* CursorKeychain.CursorKeychain;
      const sdkRunner = yield* CursorAgentSdk.CursorAgentSdkRunner;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER_KIND,
        displayName: displayName ?? "Cursor",
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const effectiveConfig = { ...config, enabled } satisfies CursorSettings;
      const credentials = yield* CursorCredentialStore.makeCursorCredentialStore(
        instanceId,
        path.join(
          host.paths.stateDir,
          "provider-auth",
          encodeURIComponent(instanceId),
          "cursor.json",
        ),
      ).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Could not open the Cursor credential store.",
              cause,
            }),
        ),
      );
      const auth = yield* makeCursorAuth({
        instanceId,
        displayName: displayName ?? "Cursor",
        enabled,
        ...(processEnv.CURSOR_API_KEY ? { apiKey: processEnv.CURSOR_API_KEY } : {}),
        store: credentials.store,
        credentialBinding: credentials.binding,
        onChanged: (signedIn): Effect.Effect<void, ProviderSetupError> =>
          snapshot.refresh.pipe(
            Effect.flatMap((provider) =>
              !signedIn || provider.auth.status === "authenticated"
                ? Effect.void
                : Effect.fail(
                    new ProviderSetupError({
                      instanceId,
                      operation: "start",
                      detail: provider.message ?? "Could not verify the Cursor sign-in. Try again.",
                    }),
                  ),
            ),
          ),
      });
      const stampSnapshot: typeof stampIdentity = (draft) =>
        stampIdentity({
          ...draft,
          setup: { canAuthenticate: !auth.usesApiKey, canInstall: false },
          auth: {
            ...draft.auth,
            canLogout: !auth.usesApiKey,
          },
        });

      const orchestrationAdapter = yield* CursorAdapterV2Driver.create({
        instanceId,
        displayName,
        accentColor,
        environment,
        enabled,
        config,
      }).pipe(
        Effect.provideService(CursorAgentSdk.CursorAgentSdkRunner, {
          ...sdkRunner,
          open: (input) =>
            auth.requireApiKey.pipe(
              Effect.flatMap((apiKey) =>
                Effect.acquireRelease(
                  sdkRunner
                    .open({ ...input, options: { ...input.options, apiKey } })
                    .pipe(
                      Effect.flatMap((session) =>
                        Effect.cached(session.close).pipe(
                          Effect.map((close) => ({ ...session, close })),
                        ),
                      ),
                    ),
                  (session) => session.close.pipe(Effect.ignore),
                ),
              ),
              auth.withAccess,
              Effect.mapError((cause) =>
                isSdkRunnerError(cause)
                  ? cause
                  : new CursorAgentSdk.CursorAgentSdkRunnerError({ method: "open", cause }),
              ),
            ),
        }),
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Cursor orchestration adapter.",
              cause,
            }),
        ),
      );
      const textGeneration = yield* makeCursorTextGeneration(
        effectiveConfig,
        processEnv,
        auth.requireApiKey,
        auth.withAccess,
      );

      const checkProvider = auth.readApiKey.pipe(
        Effect.orElseSucceed(() => undefined),
        Effect.flatMap((apiKey) =>
          checkCursorProviderStatus(
            effectiveConfig,
            {
              ...processEnv,
              CURSOR_API_KEY: apiKey,
            },
            auth.usesApiKey ? "api-key" : "browser",
          ).pipe(
            Effect.flatMap((snapshot) =>
              effectiveConfig.enabled &&
              snapshot.installed &&
              snapshot.auth.status === "authenticated"
                ? host.settings.get.pipe(
                    Effect.flatMap((settings) =>
                      readCursorUsageLimits(
                        effectiveConfig,
                        { ...processEnv, CURSOR_API_KEY: apiKey },
                        settings.cursorKeychainUsageEnabled,
                      ),
                    ),
                    Effect.map((usageLimits) => ({ ...snapshot, usageLimits })),
                  )
                : Effect.succeed(snapshot),
            ),
          ),
        ),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(CursorKeychain.CursorKeychain, keychain),
        Effect.map(stampSnapshot),
        Effect.provide(CursorSdkCatalog.layer),
      );

      const snapshotSettings = yield* makeProviderSnapshotSettingsSource(effectiveConfig);
      const snapshot = yield* makeManagedServerProvider<ProviderSnapshotSettings<CursorSettings>>({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE_CAPABILITIES),
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (settings) =>
          buildInitialCursorProviderSnapshot(settings.provider).pipe(Effect.map(stampSnapshot)),
        checkProvider,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: "Failed to build Cursor snapshot.",
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
        auth: auth.controller,
        snapshot,
        snapshotForCwd: (cwd) =>
          !effectiveConfig.enabled
            ? snapshot.getSnapshot
            : Effect.all([
                snapshot.getSnapshot,
                probeCursorSkills(cwd, processEnv).pipe(
                  Effect.provideService(FileSystem.FileSystem, fileSystem),
                  Effect.provideService(Path.Path, path),
                  Effect.mapError(
                    (cause) =>
                      new ProviderDriverError({
                        driver: DRIVER_KIND,
                        instanceId,
                        detail: `Failed to discover Cursor skills for '${cwd}'`,
                        cause,
                      }),
                  ),
                ),
              ]).pipe(Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills }))),
        orchestrationAdapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
