/**
 * OpenCode2Driver — `ProviderDriver` for the OpenCode 2 (`opencode2`) runtime.
 *
 * Snapshot path mirrors `OpenCodeDriver`: a managed server provider over
 * `checkOpenCode2ProviderStatus`, maintenance resolution, and version
 * advisory enrichment — but with the standalone `opencode2` slug, its own
 * settings schema, and the v2 version probe + `OpenCode2Server` connection
 * (one verified server per instance, shared by status checks and the
 * adapter). The adapter is the real `makeOpenCode2Adapter` facade with the
 * Effect-SDK binding (`createClient` adapts `connection.client` via
 * `makeOpenCode2SessionClient` inside `server.withConnection`); text
 * generation runs over the same server through
 * `makeOpenCode2TextGeneration` with a thin `OpenCodeClient` →
 * `OpenCode2TextGenerationClient` bridge.
 *
 * @module provider/Drivers/OpenCode2Driver
 */
import type { OpenCodeClient } from "@opencode/client/effect";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import {
  makeOpenCode2TextGeneration,
  type OpenCode2TextGenerationClient,
} from "../../textGeneration/OpenCode2TextGeneration.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeOpenCode2Adapter } from "../Layers/OpenCode2Adapter.ts";
import {
  buildInitialOpenCode2ProviderSnapshot,
  checkOpenCode2ProviderStatus,
  enrichOpenCode2Snapshot,
  makeOpenCode2RuntimeProbe,
  toOpenCode2InventoryClient,
} from "../Layers/OpenCode2Provider.ts";
import {
  openCodeCommandsToServerProviderSlashCommands,
  openCodeSkillsToServerProviderSkills,
} from "../Layers/OpenCodeProvider.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { makeManagedServerProvider } from "../makeManagedServerProvider.ts";
import * as OpenCode2ClientModule from "../opencode2/OpenCode2Client.ts";
import {
  makeOpenCode2SessionClient,
  type OpenCode2SessionClient,
} from "../opencode2/OpenCode2SessionStore.ts";
import * as OpenCode2Server from "../opencode2/OpenCode2Server.ts";
import { loadOpenCode2Inventory } from "../opencode2/OpenCode2Inventory.ts";
import {
  openCode2RequestError,
  type OpenCode2AdapterError,
} from "../opencode2/OpenCode2Protocol.ts";
import { COMPACT_SLASH_COMMAND } from "../providerSnapshot.ts";
import {
  OpenCodeRuntime,
  openCodeRuntimeErrorDetail,
  OpenCodeRuntimeError,
} from "../opencodeRuntime.ts";
import { probeOpenCodeRuntime } from "../opencodeVersionProbe.ts";
import { OPENCODE2_DRIVER_KIND, OpenCode2Settings } from "../OpenCode2Settings.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import {
  makeCachedProviderMaintenanceResolution,
  makePackageManagedProviderMaintenanceResolver,
  normalizeCommandPath,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "../providerMaintenance.ts";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
  type ProviderSnapshotSettings,
} from "../providerUpdateSettings.ts";
import { withInstanceIdentity } from "./instanceIdentity.ts";

const decodeOpenCode2Settings = Schema.decodeSync(OpenCode2Settings);

const DRIVER_KIND = OPENCODE2_DRIVER_KIND;

function isOpenCode2NativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

const UPDATE = makePackageManagedProviderMaintenanceResolver({
  provider: DRIVER_KIND,
  // OpenCode 2 ships on npm as `@opencode/cli`; the legacy `opencode-ai`
  // package tracks the v1 line.
  npmPackageName: "@opencode/cli",
  nativeUpdate: {
    args: ["upgrade"],
    isCommandPath: isOpenCode2NativeCommandPath,
  },
});

export type OpenCode2DriverEnv =
  | BackgroundPolicy.BackgroundPolicy
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | HttpClient.HttpClient
  | OpenCodeRuntime
  | Path.Path
  | ProviderEventLoggers
  | ServerConfig
  | ServerSettingsService;

/**
 * Narrow bridge from a connected `OpenCodeClient` (Effect SDK) to the
 * promise-returning {@link OpenCode2TextGenerationClient} surface. Single
 * HTTP round trips run through `Effect.runPromise` (no scope needed); the
 * server borrow in `server.withConnection` outlives each call, so the client
 * never escapes the connection it was built from.
 */
const toTextGenerationClient = (sdk: OpenCodeClient): OpenCode2TextGenerationClient => ({
  session: {
    create: (createInput) =>
      Effect.runPromise(
        sdk.session.create({
          ...(createInput.title !== undefined ? { title: createInput.title } : {}),
          ...(createInput.directory !== undefined
            ? { location: { directory: createInput.directory } as never }
            : {}),
          permissions: createInput.permissions.map((rule) => ({
            action: rule.action,
            resource: rule.resource,
            effect: rule.effect,
          })) as never,
        }),
      ).then((info) => ({ id: info.id })),
    switchModel: (switchInput) =>
      Effect.runPromise(
        sdk.session.switchModel({
          sessionID: switchInput.sessionID as never,
          model: {
            id: switchInput.model.id as never,
            providerID: switchInput.model.providerID as never,
            ...(switchInput.model.variant !== undefined
              ? { variant: switchInput.model.variant as never }
              : {}),
          } as never,
        }),
      ),
    switchAgent: (switchInput) =>
      Effect.runPromise(
        sdk.session.switchAgent({
          sessionID: switchInput.sessionID as never,
          agent: switchInput.agent as never,
        }),
      ),
    prompt: (promptInput) =>
      Effect.runPromise(
        sdk.session.prompt({
          sessionID: promptInput.sessionID as never,
          text: promptInput.text,
        }),
      ),
    wait: (waitInput) =>
      Effect.runPromise(sdk.session.wait({ sessionID: waitInput.sessionID as never })),
    context: (contextInput) =>
      Effect.runPromise(sdk.session.context({ sessionID: contextInput.sessionID as never })).then(
        (messages) =>
          [...(messages as ReadonlyArray<never>)].map((message) => {
            const record = message as unknown as Record<string, unknown>;
            const content = Array.isArray(record["content"])
              ? (record["content"] as ReadonlyArray<{
                  readonly type: string;
                  readonly text?: string;
                }>)
              : [];
            return {
              id: typeof record["id"] === "string" ? record["id"] : "",
              type: typeof record["type"] === "string" ? record["type"] : "assistant",
              content,
              ...(record["error"] !== undefined
                ? { error: record["error"] as { readonly message?: string } }
                : {}),
            };
          }),
      ),
  },
});

export const OpenCode2Driver: ProviderDriver<OpenCode2Settings, OpenCode2DriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "OpenCode 2",
    supportsMultipleInstances: true,
  },
  configSchema: OpenCode2Settings,
  defaultConfig: (): OpenCode2Settings => decodeOpenCode2Settings({}),
  create: ({ instanceId, displayName, accentColor, environment, enabled, config }) =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const pathService = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const serverSettings = yield* ServerSettingsService;
      const eventLoggers = yield* ProviderEventLoggers;
      const openCodeRuntime = yield* OpenCodeRuntime;
      const serverConfig = yield* ServerConfig;
      const processEnv = mergeProviderInstanceEnvironment(environment);
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
      // `config` is the registry-decoded payload; `enabled` arrives
      // separately on the envelope (see `ProviderDriverCreateInput`), so
      // fold it in here. The snapshot source rebuilds from this same
      // object, which keeps the stored snapshot and the status check on
      // one config (mirrors the v1 driver's scope ownership).
      const effectiveConfig = { ...config, enabled } satisfies OpenCode2Settings;
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(UPDATE, {
          binaryPath: effectiveConfig.binaryPath,
          env: processEnv,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, pathService),
        ),
      );

      // Real adapter facade. `createClient` adapts the Effect-based
      // `@opencode/client/effect` SDK client (`connection.client`) to the
      // structural Promise-based `OpenCode2SessionClient` (session
      // create/get/fork/move/wait/interrupt/update/abort/switchModel/
      // switchAgent/promptAsync/command/messages + permission/question
      // replies + event subscription) and runs it inside
      // `server.withConnection`. The client's SSE stream (`event.subscribe`)
      // runs inside the per-session `Scope` (finalizers close the pump when
      // the session stops), so a session must never outlive its server
      // borrow: `createClient` forks the `withConnection` borrow into that
      // session scope (`Effect.never` parks it until scope close), and
      // `OpenCode2Server` itself lives in the driver's scope — closing the
      // instance releases the owner and stops a spawned server (mirrors the
      // v1 driver, where `OpenCodeServerOwner` binds spawned-server lifetime
      // to the per-session `Scope`). Shutdown is scope-ordered: the registry
      // closes the driver's child scope, which releases the owner's spawn
      // scope (process-group SIGTERM/SIGKILL), the snapshot fibers, and
      // per-session pump scopes. `stopAll` on the adapter stops sessions
      // (parent + subagent descendants) without touching the server: an
      // external URL is never stopped (no lifetime attached), and a spawned
      // server idles out through the owner after the last borrower releases
      // it — so `stopAll` never strands a live session's server borrow, and
      // a background subagent child keeps no server alive on its own.
      // eventLoggers.native flows into the adapter facade (native
      // frame logging in the session pump).
      const adapter = yield* makeOpenCode2Adapter(
        effectiveConfig,
        {
          instanceId,
          environment: processEnv,
          ...(eventLoggers.native ? { nativeEventLogger: eventLoggers.native } : {}),
        },
        {
          createClient: ({
            directory,
          }): Effect.Effect<OpenCode2SessionClient, OpenCode2AdapterError, Scope.Scope> =>
            Effect.gen(function* () {
              // Hold the borrow for the session scope's lifetime: the forked
              // fiber keeps `withConnection` from completing (so the owner's
              // release — and its idle-TTL arming — runs only when the session
              // scope closes), while the deferred hands the already-verified
              // connection to client construction. Releasing after the await
              // instead would leave the session's client without a borrower
              // and a spawned server could idle-stop mid-session.
              const ready = yield* Deferred.make<
                OpenCode2Server.OpenCode2Connection,
                OpenCodeRuntimeError
              >();
              yield* server
                .withConnection((connection) =>
                  Deferred.succeed(ready, connection).pipe(Effect.andThen(Effect.never)),
                )
                .pipe(
                  Effect.catch((error) => Deferred.fail(ready, error)),
                  Effect.forkScoped,
                );
              const connection = yield* Deferred.await(ready);
              return makeOpenCode2SessionClient(connection.client, { directory });
            }).pipe(
              Effect.mapError((cause) =>
                openCode2RequestError(
                  "session.create",
                  `Failed to connect to the OpenCode 2 server: ${openCodeRuntimeErrorDetail(cause)}`,
                  cause,
                ),
              ),
            ),
        },
      );
      const textGeneration: TextGeneration.TextGeneration["Service"] = makeOpenCode2TextGeneration(
        (use) =>
          server.withConnection((connection) => use(toTextGenerationClient(connection.client))),
      );

      // Memoized per instance: the shared probe checks the local binary
      // or the configured server once and remembers the success, so status
      // checks and (later) the runtime selector share one answer.
      // `checkProvider` below consumes `runtimeProbe.refresh`, so every
      // managed refresh re-probes and an in-place upgrade re-routes.
      // `HttpClient` is provided at use so server probes run against the
      // driver's client.
      const runtimeProbe = yield* makeOpenCode2RuntimeProbe(
        probeOpenCodeRuntime(openCodeRuntime, effectiveConfig, processEnv).pipe(
          Effect.provideService(HttpClient.HttpClient, httpClient),
        ),
      );
      // One verified server per instance, shared by the adapter (client
      // binding + text generation) and `snapshotForCwd`: with a
      // `serverUrl` it connects with the configured password, otherwise
      // it spawns `binaryPath serve` through `OpenCodeServerOwner` (lazy
      // start, shared borrowers, idle stop). Built in the driver's scope
      // so closing the instance stops a spawned server.
      // `OpenCode2Server.make` builds its SDK clients through the
      // `OpenCode2Client` service; provide it here from the driver's
      // `HttpClient` so the registry layer (and bin.ts) never has to.
      // The configured password enters as a labeled `Redacted` and never
      // flows anywhere else: the snapshot source (`snapshotSettings`) only
      // carries it because `effectiveConfig` does, and no snapshot path
      // serializes it (see the redaction assertion in
      // `OpenCode2Provider.test.ts`).
      const server = yield* OpenCode2Server.make({
        binaryPath: effectiveConfig.binaryPath,
        serverUrl: effectiveConfig.serverUrl,
        serverPassword: Redacted.make(effectiveConfig.serverPassword, {
          label: "OPENCODE_PASSWORD",
        }),
        directory: serverConfig.cwd,
        environment: processEnv,
      }).pipe(
        Effect.provideServiceEffect(
          OpenCode2ClientModule.OpenCode2Client,
          OpenCode2ClientModule.make.pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
        ),
      );
      const checkProvider = checkOpenCode2ProviderStatus(
        effectiveConfig,
        serverConfig.cwd,
        runtimeProbe.refresh,
      ).pipe(
        Effect.map(stampIdentity),
        Effect.provideService(OpenCode2Server.OpenCode2Server, server),
      );

      const snapshotSettings = makeProviderSnapshotSettingsSource(effectiveConfig, serverSettings);
      const snapshot = yield* makeManagedServerProvider<
        ProviderSnapshotSettings<OpenCode2Settings>
      >({
        resolveMaintenance,
        getSettings: snapshotSettings.getSettings,
        streamSettings: snapshotSettings.streamSettings,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        checkProviderOnSettingsChange: () => false,
        refreshOnInterval: false,
        initialSnapshot: (settings) =>
          buildInitialOpenCode2ProviderSnapshot(settings.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
        enrichSnapshot: ({ settings, snapshot: currentSnapshot, publishSnapshot }) =>
          resolveMaintenance().pipe(
            Effect.flatMap((maintenanceCapabilities) =>
              enrichOpenCode2Snapshot({
                snapshot: currentSnapshot,
                maintenanceCapabilities,
                enableProviderUpdateChecks: settings.enableProviderUpdateChecks,
                publishSnapshot,
                httpClient,
              }),
            ),
          ),
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: DRIVER_KIND,
              instanceId,
              detail: `Failed to build OpenCode 2 snapshot: ${cause.message ?? String(cause)}`,
              cause,
            }),
        ),
      );

      // `Crypto` feeds the spawned server's generated password inside
      // `OpenCode2Server.make` (`generatePassword`); it stays declared on
      // `OpenCode2DriverEnv` for that reason.
      const crypto = yield* Crypto.Crypto;
      void crypto;

      // Per-workspace inventory for the `$` picker: the registry calls
      // this after the machine snapshot (see v1's `snapshotForCwd` +
      // `ProviderRegistry.upsertProviderWorkspaceSnapshot`). Disabled
      // instances reuse the stored snapshot so no server is touched;
      // inventory failures yield the machine snapshot — the registry
      // drops `error` results, so surfacing one here would lose the
      // provider instead of just its workspace skills.
      const loadWorkspaceInventoryForCwd = (cwd: string) =>
        server
          .withConnection((connection) =>
            loadOpenCode2Inventory(toOpenCode2InventoryClient(connection.client), cwd),
          )
          .pipe(Effect.provideService(OpenCode2Server.OpenCode2Server, server));
      const snapshotForCwd = (cwd: string) =>
        !effectiveConfig.enabled
          ? snapshot.getSnapshot
          : Effect.all([snapshot.getSnapshot, loadWorkspaceInventoryForCwd(cwd)]).pipe(
              Effect.map(([machineSnapshot, inventory]) => ({
                ...machineSnapshot,
                skills: openCodeSkillsToServerProviderSkills(inventory.skills),
                slashCommands: [
                  COMPACT_SLASH_COMMAND,
                  ...openCodeCommandsToServerProviderSlashCommands(inventory.commands).filter(
                    (command) => command.name !== COMPACT_SLASH_COMMAND.name,
                  ),
                ],
              })),
              Effect.catch(() => snapshot.getSnapshot),
            );

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        snapshotForCwd,
        // `makeOpenCode2RuntimeProbe` forgets failures (zero TTL), so the
        // next refresh re-probes on its own — no separate invalidation
        // hook is needed (contrast Claude's capability-probe cache).
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
