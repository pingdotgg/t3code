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
import { resolveNodeExecutable, nodeRuntimeUnavailableMessage } from "@t3tools/shared/nodeRuntime";
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Semaphore from "effect/Semaphore";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { DEVICE_HUB_ROUTE_PREFIX, DeviceService } from "./DeviceService.ts";
import type { AgentDeviceLaunchers, DeviceReadiness, ServiceState } from "./DeviceService.ts";

import * as ServerSettings from "../serverSettings.ts";

import { readDeviceDetail, runDeviceAction } from "./DeviceActions.ts";
import * as DeviceHost from "./DeviceHost.ts";
import { make } from "./DeviceServiceParts.ts";
import { sshProbeFailureMessage } from "./DeviceServiceParts2.ts";

export const makeDeviceState = Effect.fn("makeDeviceState")(function* (
  hosts: ReadonlyMap<DeviceHostId, DeviceHost.DeviceHost["Service"]>,
  testHost: DeviceService["Service"]["testHost"] = (host) =>
    Effect.fail(
      new DeviceHostUnavailableError({
        hostId: host.id,
        hostLabel: host.label,
        reason: "SSH probing is unavailable in this device service.",
      }),
    ),
  configureAgent: (
    hostId: DeviceHostId,
    endpoint: DeviceHost.AgentDaemonEndpoint & { readonly stateDir?: string | undefined },
    deviceId?: DeviceId,
  ) => Effect.Effect<string, DeviceError> = (hostId) =>
    Effect.fail(
      new DeviceHostUnavailableError({
        hostId,
        reason: "Agent configuration is unavailable in this device service.",
      }),
    ),
  installTool?: (tool: "hub" | "agent") => Effect.Effect<unknown, DeviceError>,
  launchers?: AgentDeviceLaunchers,
) {
  const settings = yield* ServerSettings.ServerSettingsService;
  const digest = yield* Digest.Digest;
  const lifecycleLock = yield* Semaphore.make(1);
  const readDeviceSettings = settings.getSettings.pipe(
    Effect.map((value) => ({
      enabled: value.enableDeviceSupport,
      agentAccessEnabled: value.enableAgentDeviceAccess,
      onboardingCompleted: value.deviceOnboardingCompleted,
    })),
    Effect.mapError(
      (cause) =>
        new DeviceOperationError({ operation: "settings", reason: "settings_failed", cause }),
    ),
  );
  const initialSettings = yield* readDeviceSettings;

  const statePubSub = yield* PubSub.unbounded<DeviceServiceState>();
  const initialHosts = yield* Effect.forEach(hosts.values(), (host) => host.summary);
  const publishedHostsCell = { hosts: new Map(hosts) };
  const stateRef = yield* SynchronizedRef.make<ServiceState>({
    state: {
      supportsHostRetry: true,
      supportsToolUpdate: installTool !== undefined,
      supportsToolInspection: true,
      supportsEasHosts: true,
      supportsSimlockHosts: true,
      hosts: initialHosts,
      hostStatus: initialSettings.enabled ? "idle" : "disabled",
      hostStatuses: {},
      devices: [],
      sessions: [],
      onboardingCompleted: initialSettings.onboardingCompleted,
      agentAccessEnabled: initialSettings.agentAccessEnabled,
      hubBasePath: DEVICE_HUB_ROUTE_PREFIX,
      revision: 0,
    },
  });

  const launcherLock = yield* Semaphore.make(1);
  /** Launchers bound since startup, by agent-device session. */
  const boundLaunchers = new Map<string, string>();
  /** Launchers on a session the host leases to every thread; the host ends it, not a retiring thread. */
  const hostSessionLaunchers = new Set<string>();
  // Binding and pruning read sessions under the lock, so neither acts on a session list the other has outdated.
  // A retired session's agent-device session ends before its launcher goes, and a reopen of the same
  // device waits for the lock, so the close cannot end the reopened session.
  const pruneLaunchers = launcherLock.withPermit(
    Effect.gen(function* () {
      if (!launchers) return;
      const { state } = yield* SynchronizedRef.get(stateRef);
      const live = new Set(
        yield* Effect.forEach(state.sessions, (session) =>
          agentDeviceSession(session.threadId, session.hostId, session.deviceId),
        ).pipe(Effect.provideService(Digest.Digest, digest)),
      );
      const retired = [...boundLaunchers].filter(([session]) => !live.has(session));
      for (const [session] of retired) boundLaunchers.delete(session);
      const ending = retired.filter(([session]) => !hostSessionLaunchers.delete(session));
      const release = launchers.release;
      if (release)
        yield* Effect.forEach(ending, ([, launcher]) => release(launcher), {
          concurrency: "unbounded",
          discard: true,
        });
      yield* launchers.prune(live);
    }),
  );

  const releaseLaunchers = (sessions: ReadonlyArray<DeviceSession>) =>
    launcherLock.withPermit(
      Effect.forEach(
        sessions,
        (session) =>
          Effect.gen(function* () {
            const name = yield* agentDeviceSession(
              session.threadId,
              session.hostId,
              session.deviceId,
            ).pipe(Effect.provideService(Digest.Digest, digest));
            const launcher = boundLaunchers.get(name);
            if (!launcher || hostSessionLaunchers.has(name) || !launchers?.release) return;
            yield* launchers.release(launcher);
            boundLaunchers.delete(name);
          }),
        { discard: true },
      ),
    );

  // Uninterruptible so a committed retirement always prunes, even if its caller is cancelled.
  const publish = (update: (state: DeviceServiceState) => DeviceServiceState) =>
    SynchronizedRef.modifyEffect(stateRef, ({ state }) => {
      const next = { ...update(state), revision: state.revision + 1 };
      const retired = state.sessions.some((session) => !next.sessions.includes(session));
      return PubSub.publish(statePubSub, next).pipe(
        Effect.as([{ next, retired }, { state: next }] as const),
      );
    }).pipe(
      Effect.tap(({ retired }) => (retired ? pruneLaunchers : Effect.void)),
      Effect.map(({ next }) => next),
      Effect.uninterruptible,
    );

  const resolveHost = Effect.fn("DeviceService.resolveHost")(function* (
    hostId: DeviceHostId | undefined,
  ) {
    const id = hostId ?? LOCAL_DEVICE_HOST_ID;
    const host = hosts.get(id);
    if (!host) {
      return yield* new DeviceHostUnavailableError({ hostId: id, reason: "Unknown host." });
    }
    return host;
  });

  const setHostStatus = (
    hostId: DeviceHostId,
    status: DeviceServiceState["hostStatuses"][string],
  ) =>
    Effect.suspend(() =>
      !hosts.has(hostId)
        ? SynchronizedRef.get(stateRef).pipe(Effect.map(({ state }) => state))
        : publish((state) => ({
            ...state,
            ...(hostId === LOCAL_DEVICE_HOST_ID
              ? { hostStatus: status.status, hostStatusDetail: status.detail }
              : {}),
            hostStatuses: {
              ...state.hostStatuses,
              [hostId]: {
                ...(state.hostStatuses[hostId]?.androidDiscoveryIncomplete
                  ? { androidDiscoveryIncomplete: true }
                  : {}),
                ...status,
              },
            },
          })),
    );

  const readiness: DeviceService["Service"]["readiness"] = Effect.fn("DeviceService.readiness")(
    function* (hostId) {
      const host = yield* resolveHost(hostId);
      if (!(yield* readDeviceSettings).enabled) {
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason:
            "Device support is off. Enable it in the Device panel before installing or starting device tools.",
        });
      }
      const ready = yield* host
        .ensureReady((status, detail) =>
          setHostStatus(host.id, { status, detail }).pipe(Effect.asVoid),
        )
        .pipe(
          Effect.tapError((error) =>
            setHostStatus(host.id, {
              status: "failed",
              detail:
                error._tag === "DeviceHostError" && error.step === "probe"
                  ? sshProbeFailureMessage(error)
                  : error.message,
            }),
          ),
          Effect.mapError(
            (error) =>
              new DeviceHostUnavailableError({
                hostId: host.id,
                hostLabel: host.label,
                reason:
                  error._tag === "NodeRuntimeUnavailableError"
                    ? nodeRuntimeUnavailableMessage("Local device support")
                    : error.step === "probe"
                      ? sshProbeFailureMessage(error)
                      : `Device support failed during ${error.step}.`,
                cause: error,
              }),
          ),
        );
      if (hosts.get(host.id) !== host)
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: "Host configuration changed. Retry the operation.",
        });
      const { state } = yield* SynchronizedRef.get(stateRef);
      if (state.hostStatuses[host.id]?.status !== "ready") {
        yield* setHostStatus(host.id, { status: "ready" });
      }
      return { hostId: host.id, ...ready };
    },
    lifecycleLock.withPermit,
  );

  const readinessIfSupported: DeviceService["Service"]["readinessIfSupported"] = Effect.fn(
    "DeviceService.readinessIfSupported",
  )(function* (hostId) {
    if (!(yield* readDeviceSettings).enabled) return null;
    const host = yield* resolveHost(hostId);
    const summary = yield* host.summary;
    if (summary.kind === "local" && !summary.platforms.some((platform) => platform.available))
      return null;
    return yield* readiness(host.id);
  });

  const agentReadinessIfSupported: DeviceService["Service"]["agentReadinessIfSupported"] =
    Effect.fn("DeviceService.agentReadinessIfSupported")(function* (hostId) {
      const deviceSettings = yield* readDeviceSettings;
      if (!deviceSettings.enabled || !deviceSettings.agentAccessEnabled) return null;
      const host = yield* resolveHost(hostId);
      const summary = yield* host.summary;
      if (summary.kind === "local" && !summary.platforms.some((platform) => platform.available))
        return null;
      const ready = yield* host
        .ensureAgentReady((phase, detail) =>
          setHostStatus(host.id, { status: phase, detail }).pipe(Effect.asVoid),
        )
        .pipe(
          Effect.tapError((error) =>
            setHostStatus(host.id, {
              status: "failed",
              detail:
                error._tag === "DeviceHostError" && error.step === "probe"
                  ? sshProbeFailureMessage(error)
                  : error.message,
            }),
          ),
          Effect.mapError(
            (error) =>
              new DeviceHostUnavailableError({
                hostId: host.id,
                hostLabel: host.label,
                reason:
                  error._tag === "NodeRuntimeUnavailableError"
                    ? nodeRuntimeUnavailableMessage("Local device support")
                    : error._tag === "DeviceHostTimeoutError"
                      ? `Agent tools did not start within ${error.timeoutMs} ms.`
                      : error._tag === "AgentDeviceStartError"
                        ? error.message
                        : error.step === "probe"
                          ? sshProbeFailureMessage(error)
                          : `Device support failed during ${error.step}.`,
                cause: error,
              }),
          ),
        );
      const hostSummaries = yield* Effect.forEach(hosts.values(), (candidate) => candidate.summary);
      yield* publish((state) => ({ ...state, hosts: hostSummaries }));
      yield* setHostStatus(host.id, { status: "ready" });
      return { hostId: host.id, ...ready };
    }, lifecycleLock.withPermit);

  const currentReadiness: DeviceService["Service"]["currentReadiness"] = (hostId) =>
    resolveHost(hostId).pipe(
      Effect.flatMap((host) =>
        host.current.pipe(Effect.map((ready) => (ready ? { hostId: host.id, ...ready } : null))),
      ),
      Effect.orElseSucceed(() => null),
    );

  const fetchDevices = Effect.fn("DeviceService.fetchDevices")(function* (ready: DeviceReadiness) {
    const { devices, detail, androidDiscoveryIncomplete } = yield* ready.devices.list;
    return {
      devices: devices.map((device): DeviceSummary => ({ ...device, hostId: ready.hostId })),
      detail,
      androidDiscoveryIncomplete,
    };
  });

  const refresh = Effect.fn("DeviceService.refresh")(function* (ready: DeviceReadiness) {
    const host = hosts.get(ready.hostId);
    // A session opened while the listing ran is on a device the listing could
    // not have seen yet; only sessions from before it can be pruned by it.
    const sessionKey = (session: DeviceSession) =>
      `${session.hostId}\u0000${session.deviceId}\u0000${session.threadId}\u0000${session.openedAt}`;
    const before = new Set((yield* SynchronizedRef.get(stateRef)).state.sessions.map(sessionKey));
    const { devices, detail, androidDiscoveryIncomplete } = yield* fetchDevices(ready);
    const hostSummaries = yield* Effect.forEach(hosts.values(), (host) => host.summary);
    return yield* lifecycleLock.withPermit(
      Effect.gen(function* () {
        if (!(yield* readDeviceSettings).enabled || !host || hosts.get(ready.hostId) !== host)
          return (yield* SynchronizedRef.get(stateRef)).state;
        return yield* publish((state) => ({
          ...state,
          hosts: hostSummaries,
          ...(ready.hostId === LOCAL_DEVICE_HOST_ID ? { hostStatusDetail: detail } : {}),
          devices: [
            ...state.devices.filter((device) => device.hostId !== ready.hostId),
            ...devices,
          ],
          // A host that ends devices itself (EAS stops sessions at their limits)
          // leaves sessions on devices it no longer lists with nothing to stream.
          // Other hosts can miss a device for one listing, so theirs stay.
          sessions: ready.devices.endsDevices
            ? state.sessions.filter(
                (session) =>
                  session.hostId !== ready.hostId ||
                  !before.has(sessionKey(session)) ||
                  devices.some((device) => device.id === session.deviceId),
              )
            : state.sessions,
          hostStatuses: {
            ...state.hostStatuses,
            [ready.hostId]: {
              status: "ready",
              ...(detail ? { detail } : {}),
              ...(androidDiscoveryIncomplete ? { androidDiscoveryIncomplete } : {}),
            },
          },
        }));
      }),
    );
  });

  const list: DeviceService["Service"]["list"] = Effect.gen(function* () {
    if (!(yield* readDeviceSettings).enabled) return (yield* SynchronizedRef.get(stateRef)).state;
    yield* Effect.forEach(
      hosts.values(),
      (host) =>
        Effect.gen(function* () {
          const ready = yield* readinessIfSupported(host.id);
          if (ready) yield* refresh(ready);
        }).pipe(
          Effect.catch((error) =>
            setHostStatus(host.id, {
              status: "failed",
              detail: error._tag === "DeviceHostUnavailableError" ? error.reason : error.message,
            }),
          ),
        ),
      { concurrency: 4 },
    );
    return (yield* SynchronizedRef.get(stateRef)).state;
  }).pipe(Effect.withSpan("DeviceService.list"));

  const inspect = Effect.gen(function* () {
    yield* Effect.forEach(
      hosts.values(),
      (host) =>
        Effect.gen(function* () {
          const result = yield* (host.inspect ?? host.summary).pipe(Effect.result);
          if (hosts.get(host.id) !== host) return;
          if (result._tag === "Failure") {
            yield* publish((state) => ({
              ...state,
              hosts: state.hosts.map((value) =>
                value.id === host.id
                  ? {
                      ...value,
                      toolInspectionError:
                        "Cannot check versions. Reconnect the host and check again. Installed tools have not been changed.",
                    }
                  : value,
              ),
            }));
            return;
          }
          yield* publish((state) => ({
            ...state,
            hosts: state.hosts.map((value) => (value.id === host.id ? result.success : value)),
          }));
        }),
      { concurrency: 4 },
    );
    return (yield* SynchronizedRef.get(stateRef)).state;
  });

  const retryHost: DeviceService["Service"]["retryHost"] = Effect.fn("DeviceService.retryHost")(
    function* (hostId) {
      yield* resolveHost(hostId);
      if (!(yield* readDeviceSettings).enabled) return (yield* SynchronizedRef.get(stateRef)).state;
      yield* Effect.gen(function* () {
        const ready =
          (yield* agentReadinessIfSupported(hostId)) ?? (yield* readinessIfSupported(hostId));
        if (ready) yield* refresh(ready);
      }).pipe(
        Effect.catch((error) =>
          setHostStatus(hostId, {
            status: "failed",
            detail: error._tag === "DeviceHostUnavailableError" ? error.reason : error.message,
          }),
        ),
      );
      return (yield* SynchronizedRef.get(stateRef)).state;
    },
  );

  const configure: DeviceService["Service"]["configure"] = Effect.fn("DeviceService.configure")(
    function* (input) {
      const currentSettings = yield* readDeviceSettings;
      const nextEnabled = input.enabled ?? currentSettings.enabled;
      const nextAgentAccess = input.agentAccessEnabled ?? currentSettings.agentAccessEnabled;
      yield* lifecycleLock.withPermit(
        Effect.gen(function* () {
          yield* settings
            .updateSettings({
              ...(input.enabled === undefined ? {} : { enableDeviceSupport: input.enabled }),
              ...(input.agentAccessEnabled === undefined
                ? {}
                : { enableAgentDeviceAccess: input.agentAccessEnabled }),
              ...(input.onboardingCompleted === undefined
                ? {}
                : { deviceOnboardingCompleted: input.onboardingCompleted }),
            })
            .pipe(
              Effect.mapError(
                (cause) =>
                  new DeviceOperationError({
                    operation: "configure",
                    reason: "settings_failed",
                    cause,
                  }),
              ),
            );
          if (!nextEnabled) {
            yield* Effect.forEach(hosts.values(), (host) => host.stop, { discard: true });
          } else if (input.agentAccessEnabled === false) {
            yield* Effect.forEach(hosts.values(), (host) => host.stopAgent, { discard: true });
          }
          yield* publish((state) => ({
            ...state,
            hostStatus: nextEnabled ? "idle" : "disabled",
            hostStatusDetail: undefined,
            hostStatuses: {},
            devices: nextEnabled ? state.devices : [],
            sessions: nextEnabled ? state.sessions : [],
            bootingDevices: nextEnabled ? state.bootingDevices : [],
            agentAccessEnabled: nextAgentAccess,
            onboardingCompleted: input.onboardingCompleted ?? state.onboardingCompleted,
          }));
        }),
      );
      if (nextEnabled && nextAgentAccess && input.agentAccessEnabled === true) {
        yield* agentReadinessIfSupported();
      }
      return yield* list;
    },
  );

  const findDevice = (
    state: DeviceServiceState,
    hostId: DeviceHostId,
    deviceId: DeviceId,
  ): DeviceSummary | undefined =>
    state.devices.find((device) => device.hostId === hostId && device.id === deviceId);

  return {
    settings,
    digest,
    lifecycleLock,
    readDeviceSettings,
    initialSettings,
    statePubSub,
    initialHosts,
    publishedHostsCell,
    stateRef,
    launcherLock,
    boundLaunchers,
    hostSessionLaunchers,
    pruneLaunchers,
    releaseLaunchers,
    publish,
    resolveHost,
    setHostStatus,
    readiness,
    readinessIfSupported,
    agentReadinessIfSupported,
    currentReadiness,
    fetchDevices,
    refresh,
    list,
    inspect,
    retryHost,
    configure,
    findDevice,
    hosts,
    testHost,
    configureAgent,
    installTool,
    launchers,
  };
});
