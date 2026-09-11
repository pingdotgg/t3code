import {
  DevinSettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeDevinAdapter } from "../Layers/DevinAdapter.ts";
import { checkDevinProviderStatus, initialDevinProviderSnapshot } from "../Layers/DevinProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";
import { discoverDevinSkills } from "./DevinSkills.ts";

const DRIVER = ProviderDriverKind.make("devin");
const unsupportedTextGeneration = (operation: keyof ProviderInstance["textGeneration"]) =>
  Effect.fail(
    new TextGenerationError({
      operation,
      detail:
        "Devin does not support background text generation. Choose another provider in Settings → General.",
    }),
  );
const decodeSettings = Schema.decodeSync(DevinSettings);
const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
  provider: DRIVER,
  packageName: null,
});

export type DevinDriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

export const DevinDriver: ProviderDriver<DevinSettings, DevinDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "Devin", supportsMultipleInstances: true },
  configSchema: DevinSettings,
  defaultConfig: () => decodeSettings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const processEnv = mergeProviderInstanceEnvironment(environment);
      const settings = { ...config, enabled };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId,
      });
      const stamp = withInstanceIdentity({
        instanceId,
        driverKind: DRIVER,
        displayName,
        accentColor,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const metadataChanges = yield* Effect.acquireRelease(
        PubSub.unbounded<void>(),
        PubSub.shutdown,
      );
      const commandsByCwd = new Map<string, ReadonlyArray<ServerProviderSlashCommand>>();
      const skillsByCwd = new Map<string, ReadonlyArray<ServerProviderSkill>>();
      const probeSkills = (cwd: string) =>
        discoverDevinSkills(settings, processEnv, cwd).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(Path.Path, path),
          Effect.tap((skills) => Effect.sync(() => skillsByCwd.set(cwd, skills))),
          Effect.mapError(
            (cause) =>
              new ProviderDriverError({
                driver: DRIVER,
                instanceId,
                detail: `Could not discover Devin skills for '${cwd}'.`,
                cause,
              }),
          ),
        );
      let lastKnownModels: ReadonlyArray<ServerProviderModel> = [];
      const adapter = yield* makeDevinAdapter(settings, {
        instanceId,
        environment: processEnv,
        nativeEventLogger: eventLoggers.native,
        onAvailableCommands: (commands, cwd) =>
          Effect.gen(function* () {
            const next = commands.map((command) => ({
              name: command.name,
              description: command.description,
              ...(command.input ? { input: command.input } : {}),
            }));
            if (Equal.equals(commandsByCwd.get(cwd), next)) return;
            commandsByCwd.set(cwd, next);
            yield* PubSub.publish(metadataChanges, undefined);
          }),
      });
      const snapshotSettings = makeProviderSnapshotSettingsSource(settings, serverSettings);
      const managed = yield* makeManagedServerProvider({
        resolveMaintenance: () => Effect.succeed(maintenance),
        ...snapshotSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        initialSnapshot: (current) =>
          initialDevinProviderSnapshot(current.provider).pipe(Effect.map(stamp)),
        checkProvider: Effect.suspend(() =>
          checkDevinProviderStatus(settings, processEnv, lastKnownModels),
        ).pipe(
          Effect.tap((snapshot) =>
            Effect.sync(() => {
              lastKnownModels =
                snapshot.auth.status === "authenticated"
                  ? snapshot.models.filter((model) => !model.isCustom)
                  : [];
              if (snapshot.auth.status !== "authenticated") {
                commandsByCwd.clear();
                skillsByCwd.clear();
              }
            }),
          ),
          Effect.map(stamp),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER,
              instanceId,
              detail: "Could not initialize Devin provider status.",
              cause,
            }),
        ),
      );
      const withWorkspaceMetadata = (snapshot: Parameters<typeof stamp>[0]) => ({
        ...stamp(snapshot),
        // A workspace snapshot marks discovery complete in ProviderRegistry.
        // ACP commands can arrive first; don't cache an unprobed empty skill list.
        workspaceSnapshots: (snapshot.auth.status === "authenticated"
          ? [...skillsByCwd.keys()]
          : []
        ).map((cwd) => ({
          cwd,
          slashCommands: commandsByCwd.get(cwd) ?? snapshot.slashCommands,
          skills: skillsByCwd.get(cwd) ?? [],
          checkedAt: snapshot.checkedAt,
        })),
      });
      const getSnapshot = managed.getSnapshot.pipe(Effect.map(withWorkspaceMetadata));
      return {
        instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        adapter,
        textGeneration: {
          generateCommitMessage: () => unsupportedTextGeneration("generateCommitMessage"),
          generatePrContent: () => unsupportedTextGeneration("generatePrContent"),
          generateBranchName: () => unsupportedTextGeneration("generateBranchName"),
          generateThreadTitle: () => unsupportedTextGeneration("generateThreadTitle"),
        },
        snapshot: {
          ...managed,
          getSnapshot,
          refresh: managed.refresh.pipe(
            Effect.tap((snapshot) =>
              snapshot.auth.status === "authenticated"
                ? Effect.forEach(
                    [...skillsByCwd.keys()],
                    (cwd) =>
                      probeSkills(cwd).pipe(
                        Effect.catch((cause) => Effect.logWarning(cause.message)),
                      ),
                    { discard: true },
                  )
                : Effect.void,
            ),
            Effect.map(withWorkspaceMetadata),
          ),
          streamChanges: Stream.merge(
            managed.streamChanges.pipe(Stream.map(withWorkspaceMetadata)),
            Stream.fromPubSub(metadataChanges).pipe(Stream.mapEffect(() => getSnapshot)),
          ),
        },
        snapshotForCwd: (cwd) =>
          Effect.gen(function* () {
            const snapshot = yield* getSnapshot;
            if (!enabled || snapshot.auth.status !== "authenticated") return snapshot;
            const skills = yield* probeSkills(cwd);
            return {
              ...withWorkspaceMetadata(snapshot),
              skills,
              slashCommands: commandsByCwd.get(cwd) ?? snapshot.slashCommands,
            };
          }),
      } satisfies ProviderInstance;
    }),
};
