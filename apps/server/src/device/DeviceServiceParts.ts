import {
  type DeviceActionInput,
  type DeviceCloseInput,
  type DeviceConfigureInput,
  type DeviceDetail,
  type DeviceDetailInput,
  type DeviceError,
  DeviceHostId,
  DeviceId,
  DeviceHostUnavailableError,
  DeviceNotFoundError,
  DeviceOperationError,
  type DeviceOpenInput,
  type DevicePlatform,
  DevicePlatformUnavailableError,
  type DeviceServiceState,
  type DeviceSession,
  type DeviceShutdownInput,
  type DeviceSummary,
  type DeviceEasAccount,
  DeviceEasAccountError,
  type DeviceEasAccountInput,
  type DeviceSimlockIdentity,
  DeviceSimlockIdentityError,
  type DeviceSimlockIdentityInput,
  type DeviceHostConfig,
  type EasDeviceHostConfig,
  type SimlockDeviceHostConfig,
  type SshDeviceHostConfig,
  type DeviceHostSummary,
  LOCAL_DEVICE_HOST_ID,
  LOCAL_DEVICE_HOST_LABEL,
  type ThreadId,
} from "@t3tools/contracts";
import { SshCommandError } from "@t3tools/ssh/errors";
import * as FileSystem from "effect/FileSystem";
import { resolveNodeExecutable, nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";
import * as Path from "effect/Path";
import { ensureAgentDevice, ensureDeviceHub } from "./DeviceToolchain.ts";
import {
  agentDeviceCloseOutcome,
  bindAgentDeviceLauncher,
  ensureAgentDeviceShim,
  pruneAgentDeviceLaunchers,
} from "./AgentDeviceShim.ts";
import * as ServerConfig from "../config.ts";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClient from "effect/http/HttpClient";

import * as ServerSettings from "../serverSettings.ts";
import { isLocalSshDeviceHost, remoteSshDeviceHosts } from "./localSshDeviceHost.ts";

import { readDeviceDetail, runDeviceAction } from "./DeviceActions.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as SecretResolverLayer from "../secrets/SecretResolver.ts";
import * as DeviceHost from "./DeviceHost.ts";
import * as SshDeviceHost from "./SshDeviceHost.ts";
import * as EasDeviceHost from "./EasDeviceHost.ts";
import * as SimlockDeviceHost from "./SimlockDeviceHost.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { makeExpoApi } from "./ExpoApi.ts";
import * as Exit from "effect/Exit";
import * as LocalDeviceHost from "./LocalDeviceHost.ts";
import type { AgentDeviceLaunchers } from "./DeviceService.ts";
import { DeviceService, makeWithHosts } from "./DeviceService.ts";

export const make = Effect.gen(function* () {
  const localHost = yield* DeviceHost.DeviceHost;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const runner = yield* ProcessRunner.ProcessRunner;
  const settings = yield* ServerSettings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;
  const scope = yield* Scope.Scope;
  const hosts = new Map<DeviceHostId, DeviceHost.DeviceHost["Service"]>([
    [localHost.id, localHost],
  ]);
  const digest = yield* Digest.Digest;
  const configPath = (hostId: DeviceHostId, deviceId?: DeviceId) =>
    agentDeviceConfigPath(config.stateDir, hostId, path, deviceId).pipe(
      Effect.provideService(Digest.Digest, digest),
    );
  const configureAgent = Effect.fn("DeviceService.configureAgent")(
    function* (
      hostId: DeviceHostId,
      endpoint: DeviceHost.AgentDaemonEndpoint & { readonly stateDir?: string | undefined },
      deviceId?: DeviceId,
    ) {
      const file = yield* configPath(hostId, deviceId);
      yield* writeAgentDeviceConfig(file, endpoint);
      return file;
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.mapError(
      (cause) =>
        new DeviceOperationError({
          operation: "configure agent",
          reason: "settings_failed",
          cause,
        }),
    ),
  );
  const agentCli = resolveNodeExecutable("Device automation").pipe(
    Effect.andThen(ensureAgentDevice(config.baseDir)),
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
    Effect.map((tool) => tool.entryPath),
    Effect.mapError((error) =>
      error._tag === "NodeRuntimeUnavailableError"
        ? new DeviceHostUnavailableError({
            hostId: LOCAL_DEVICE_HOST_ID,
            hostLabel: LOCAL_DEVICE_HOST_LABEL,
            reason: nodeRuntimeUnavailableMessage("Device automation"),
            cause: error,
          })
        : new DeviceOperationError({
            operation: "install agent CLI",
            reason: "command_failed",
            cause: error,
          }),
    ),
  );
  const launchers: AgentDeviceLaunchers = {
    bind: Effect.fn("DeviceService.bindLauncher")(
      function* (input) {
        const entryPath = yield* agentCli;
        // The unbound launcher stays current for agents that still call it with flags.
        yield* ensureAgentDeviceShim({ entryPath, stateDir: config.stateDir });
        return yield* bindAgentDeviceLauncher({ entryPath, stateDir: config.stateDir, ...input });
      },
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.provideService(Path.Path, path),
      Effect.catchTags({
        NodeRuntimeUnavailableError: (cause) =>
          Effect.fail(
            new DeviceHostUnavailableError({
              hostId: LOCAL_DEVICE_HOST_ID,
              hostLabel: LOCAL_DEVICE_HOST_LABEL,
              reason: nodeRuntimeUnavailableMessage("Device automation"),
              cause,
            }),
          ),
        PlatformError: (cause) =>
          Effect.fail(
            new DeviceHostUnavailableError({
              hostId: LOCAL_DEVICE_HOST_ID,
              hostLabel: LOCAL_DEVICE_HOST_LABEL,
              reason: "Could not prepare the agent-device launcher.",
              cause,
            }),
          ),
      }),
    ),
    prune: (live) =>
      pruneAgentDeviceLaunchers({ stateDir: config.stateDir, live }).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
      ),
    // Best effort: an unreachable host fails fast in the launcher's connection check, and the
    // launcher goes either way. Only a failed or timed-out close can leave the device claimed.
    release: (launcher) =>
      resolveNodeExecutable("Device automation").pipe(
        Effect.flatMap((node) =>
          runner.run({
            command: node,
            args: [path.join(path.dirname(launcher), "agent-device-launcher.mjs"), "close"],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            timeout: "15 seconds",
            timeoutBehavior: "timedOutResult",
          }),
        ),
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.flatMap((result) => {
          const outcome = agentDeviceCloseOutcome(result);
          return outcome === "failed" || outcome === "timed-out"
            ? Effect.logWarning("Could not end the agent-device session", {
                launcher,
                outcome,
                stderr: result.stderr.slice(-500),
              })
            : Effect.void;
        }),
        Effect.tapError((cause) =>
          Effect.logWarning("Could not end the agent-device session", { launcher, cause }),
        ),
        Effect.ignore,
      ),
  };
  const probeContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof SshDeviceHost.probe>>>();
  const localTargetContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof isLocalSshDeviceHost>>>();
  const service = yield* makeWithHosts(
    hosts,
    (host) =>
      Effect.gen(function* () {
        if (yield* isLocalSshDeviceHost(host).pipe(Effect.provide(localTargetContext))) {
          return yield* localHost.summary;
        }
        return yield* SshDeviceHost.probe(host).pipe(Effect.provide(probeContext));
      }).pipe(
        Effect.mapError(
          (error) =>
            new DeviceOperationError({
              operation: "probe host",
              reason: "request_failed",
              cause: error,
            }),
        ),
      ),
    configureAgent,
    (tool) =>
      (tool === "hub" ? ensureDeviceHub(config.baseDir) : ensureAgentDevice(config.baseDir)).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
        Effect.provideService(Path.Path, path),
        Effect.provideService(ProcessRunner.ProcessRunner, runner),
        Effect.mapError(
          (cause) =>
            new DeviceOperationError({
              operation: "update device tool",
              reason: "command_failed",
              // Only the exit code goes into the shown message; npm's stderr can carry registry credentials.
              ...(cause.exitCode !== undefined ? { exitCode: cause.exitCode } : {}),
              cause,
            }),
        ),
      ),
    launchers,
  );
  const hostContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof SshDeviceHost.make>>>();
  const easContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof EasDeviceHost.make>>>();
  const simlockContext =
    yield* Effect.context<Effect.Services<ReturnType<typeof SimlockDeviceHost.make>>>();
  const simlockAgentCli = Effect.fn("DeviceService.simlockAgentCli")(
    function* (hostId: string) {
      const nodePath = yield* resolveNodeExecutable("Device automation");
      const tool = yield* ensureAgentDevice(config.baseDir).pipe(
        Effect.mapError(
          (cause) =>
            new DeviceHost.DeviceHostError({ hostId, step: "installing agent tools", cause }),
        ),
      );
      return { nodePath, entryPath: tool.entryPath };
    },
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.provideService(ProcessRunner.ProcessRunner, runner),
  );
  const configured = new Map<string, { config: DeviceHostConfig; scope: Scope.Closeable }>();
  const unchanged = (current: DeviceHostConfig, previous: DeviceHostConfig) =>
    current.kind === "ssh" && previous.kind === "ssh"
      ? current.label === previous.label &&
        current.target === previous.target &&
        current.port === previous.port &&
        current.identityFile === previous.identityFile
      : JSON.stringify(current) === JSON.stringify(previous);
  const reconcile = Effect.fn("DeviceService.reconcile")(function* (
    configuredHosts: ReadonlyArray<DeviceHostConfig>,
  ) {
    const next = yield* remoteSshDeviceHosts(configuredHosts).pipe(
      Effect.provide(localTargetContext),
    );
    const removed = yield* service.withLifecycleLock(
      Effect.gen(function* () {
        const removed: Array<{ id: string; scope: Scope.Closeable }> = [];
        for (const [id, previous] of configured) {
          if (next.some((host) => host.id === id && unchanged(host, previous.config))) continue;
          hosts.delete(id);
          configured.delete(id);
          removed.push({ id, scope: previous.scope });
        }
        if (removed.length > 0) yield* service.refreshHosts;
        return removed;
      }),
    );
    // Stop old writers before deleting config files or publishing replacements, without blocking healthy hosts.
    yield* Effect.forEach(
      removed,
      ({ id, scope }) =>
        Effect.gen(function* () {
          yield* Scope.close(scope, Exit.void);
          yield* fs.remove(yield* configPath(id), { force: true }).pipe(Effect.ignore);
        }),
      { concurrency: 4, discard: true },
    );
    yield* service.withLifecycleLock(
      Effect.gen(function* () {
        let added = false;
        for (const host of next) {
          if (configured.has(host.id)) continue;
          added = true;
          const hostScope = yield* Scope.fork(scope);
          if (host.kind === "simlock") {
            // Closing this scope releases the host's leases back to the pool.
            const instance = yield* SimlockDeviceHost.make(host, simlockAgentCli(host.id)).pipe(
              Effect.provideService(Scope.Scope, hostScope),
              Effect.provide(simlockContext),
            );
            hosts.set(host.id, instance);
            configured.set(host.id, { config: host, scope: hostScope });
            // Ask the gateway now, so a refused token shows in Settings before anyone opens a device.
            if ((yield* settings.getSettings).enableDeviceSupport)
              yield* instance
                .platformAvailability("ios")
                .pipe(
                  Effect.andThen(service.withLifecycleLock(service.refreshHosts)),
                  Effect.forkIn(hostScope),
                );
            continue;
          }
          if (host.kind === "eas") {
            // Closing this scope stops the host's running sessions, so a changed
            // limit or token never leaves a billed session behind.
            const instance = yield* EasDeviceHost.make(host).pipe(
              Effect.provideService(Scope.Scope, hostScope),
              Effect.provide(easContext),
            );
            hosts.set(host.id, instance);
            configured.set(host.id, { config: host, scope: hostScope });
            continue;
          }
          const instance = yield* SshDeviceHost.make(
            host,
            (ready) =>
              (ready.agentDevice
                ? configureAgent(host.id, ready.agentDevice).pipe(Effect.asVoid)
                : Effect.void
              ).pipe(
                Effect.mapError(
                  (error) =>
                    new DeviceHost.DeviceHostError({
                      hostId: host.id,
                      step: "configuring agent access",
                      cause: error,
                    }),
                ),
              ),
            (status, detail) =>
              service
                .setHostStatus(host.id, { status, ...(detail ? { detail } : {}) })
                .pipe(Effect.asVoid),
          ).pipe(Effect.provideService(Scope.Scope, hostScope), Effect.provide(hostContext));
          hosts.set(host.id, instance);
          configured.set(host.id, { config: host, scope: hostScope });
        }
        // Refresh again after removed scopes closed so a late status write from an old host cannot linger.
        if (added || removed.length > 0) yield* service.refreshHosts;
      }),
    );
  });
  const changes = yield* settings.subscribeChanges;
  // Each kind has its own settings list; an id two lists share stays the first one's.
  const configuredHosts = (value: {
    readonly deviceHosts: ReadonlyArray<SshDeviceHostConfig>;
    readonly easDeviceHosts: ReadonlyArray<EasDeviceHostConfig>;
    readonly simlockDeviceHosts: ReadonlyArray<SimlockDeviceHostConfig>;
    readonly simlockDeviceHostsEnabled: boolean;
  }): ReadonlyArray<DeviceHostConfig> => {
    const hosts: Array<DeviceHostConfig> = [...value.deviceHosts];
    for (const host of [
      ...value.easDeviceHosts,
      ...(value.simlockDeviceHostsEnabled ? value.simlockDeviceHosts : []),
    ]) {
      if (!hosts.some((existing) => existing.id === host.id)) hosts.push(host);
    }
    return hosts;
  };
  yield* reconcile(configuredHosts(yield* settings.getSettings));
  yield* changes.pipe(
    Stream.runForEach((value) => reconcile(configuredHosts(value))),
    Effect.forkIn(scope),
  );
  yield* Effect.addFinalizer(() =>
    Effect.forEach(configured.values(), (value) => Scope.close(value.scope, Exit.void), {
      discard: true,
      concurrency: 4,
    }),
  );
  const easAccount: DeviceService["Service"]["easAccount"] = Effect.fn("DeviceService.easAccount")(
    function* (input) {
      const saved =
        input.hostId === undefined
          ? ""
          : ((yield* settings.getSettings).easDeviceHosts.find((host) => host.id === input.hostId)
              ?.accessToken ?? "");
      const credential = yield* EasDeviceHost.resolveSavedExpoCredential(
        secrets,
        input.accessToken ?? saved,
      );
      const viewer = yield* makeExpoApi(yield* HttpClient.HttpClient, credential).viewer;
      return { signedInAs: viewer.name, credentialSource: credential.source, apps: viewer.apps };
    },
    Effect.provide(easContext),
    // Only bounded text reaches the browser: the credential errors' own
    // guidance, or a category for what Expo answered, never Expo's text.
    Effect.mapError(
      (cause) =>
        new DeviceEasAccountError({
          reason:
            cause._tag === "ExpoApiError"
              ? cause.status === 401 || cause.status === 403
                ? `Expo rejected the credential (HTTP ${cause.status}).`
                : cause.rejected
                  ? "Expo refused the account check."
                  : "Could not complete the Expo account check."
              : cause.message,
        }),
    ),
  );

  const simlockIdentity: DeviceService["Service"]["simlockIdentity"] = Effect.fn(
    "DeviceService.simlockIdentity",
  )(
    function* (input) {
      const environment = yield* HostProcess.Environment;
      const gatewayUrl = (
        input.gatewayUrl || SimlockDeviceHost.machineSimlockToken(environment)?.gatewayUrl
      )?.replace(/\/$/, "");
      if (!gatewayUrl)
        return yield* new DeviceSimlockIdentityError({
          reason: "This machine's agent-device does not point at a Simlock gateway.",
        });
      const savedHost =
        input.hostId === undefined
          ? undefined
          : (yield* settings.getSettings).simlockDeviceHosts.find(
              (host) => host.id === input.hostId,
            );
      const token = input.agentToken
        ? { agentToken: input.agentToken, source: "entered" as const }
        : SimlockDeviceHost.resolveSimlockToken(gatewayUrl, savedHost, environment);
      if (!token)
        return yield* new DeviceSimlockIdentityError({
          reason: savedHost?.agentToken
            ? "The saved token is for another gateway. Enter one for this gateway."
            : "No agent token for this gateway on this machine.",
        });
      const identity = yield* SimlockDeviceHost.simlockIdentity(gatewayUrl, token.agentToken).pipe(
        Effect.mapError(
          (cause) =>
            new DeviceSimlockIdentityError({
              reason: SimlockDeviceHost.describeGatewayFailure(
                cause,
                gatewayUrl,
                token.source === "env" ? "this machine" : "this environment",
              ),
            }),
        ),
      );
      if (identity.role !== "agent")
        return yield* new DeviceSimlockIdentityError({
          reason: `That is a ${identity.role} token. Create one with --role agent.`,
        });
      return { gatewayUrl, signedInAs: identity.name, tokenSource: token.source };
    },
    Effect.catchTags({
      ServerSettingsError: () =>
        Effect.fail(new DeviceSimlockIdentityError({ reason: "Could not read the saved token." })),
    }),
    Effect.provide(simlockContext),
  );

  return {
    ...service,
    easAccount,
    simlockIdentity,
  };
});

