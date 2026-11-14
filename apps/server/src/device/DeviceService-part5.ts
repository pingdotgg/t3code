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
import {
  agentDeviceConfigPath,
  agentDeviceSession,
  writeAgentDeviceConfig,
} from "./AgentDeviceTarget.ts";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { DeviceService } from "./DeviceService.ts";

import * as ServerSettings from "../serverSettings.ts";

import { readDeviceDetail, runDeviceAction } from "./DeviceActions.ts";

import type { makeDeviceStage2 } from "./DeviceService-part4.ts";

type State = Effect.Success<ReturnType<typeof makeDeviceStage2>>;

export const makeDeviceFlows = Effect.fn("makeDeviceFlows")(function* (state: State) {
  const {
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
    ensurePlatform,
    open,
    refreshAfterShutdown,
    shutdownDevice,
    close,
    shutdown,
    screenshot,
    resolveDevice,
    detail,
    action,
    sessionsForThread,
    locate,
  } = state;
  const locateDevice: DeviceService["Service"]["locateDevice"] = Effect.fn(
    "DeviceService.locateDevice",
  )(function* (input) {
    const { state } = yield* SynchronizedRef.get(stateRef);
    return yield* locate(
      state,
      input,
      state.devices.filter((device) => device.id === input.deviceId),
    );
  });

  const locateSession: DeviceService["Service"]["locateSession"] = Effect.fn(
    "DeviceService.locateSession",
  )(function* (input) {
    const { state } = yield* SynchronizedRef.get(stateRef);
    return yield* locate(
      state,
      input,
      state.sessions.filter(
        (session) => session.threadId === input.threadId && session.deviceId === input.deviceId,
      ),
    );
  });

  // Sessions live in memory, so this removes every launcher a previous run left behind.
  yield* pruneLaunchers;

  return {
    ...DeviceService.of({
      testHost,
      updateTool: Effect.fn("DeviceService.updateTool")(function (tool) {
        return lifecycleLock.withPermit(
          Effect.gen(function* () {
            if (!installTool)
              return yield* new DeviceOperationError({
                operation: "update device tool",
                reason: "request_failed",
                cause: new Error("Tool installation is unavailable in this device service."),
              });
            yield* installTool(tool);
            return yield* inspect;
          }),
        );
      }),
      retryHost,
      inspect,
      easAccount: Effect.fn("DeviceService.easAccount")(function () {
        return Effect.fail(
          new DeviceEasAccountError({
            reason: "EAS accounts are unavailable in this device service.",
          }),
        );
      }),
      simlockIdentity: Effect.fn("DeviceService.simlockIdentity")(function () {
        return Effect.fail(
          new DeviceSimlockIdentityError({
            reason: "Simlock hosts are unavailable in this device service.",
          }),
        );
      }),
      agentTarget: Effect.fn("DeviceService.agentTarget")(function* (input) {
        const host = yield* resolveHost(input.hostId);
        const ready = yield* agentReadinessIfSupported(input.hostId);
        if (!ready)
          return yield* new DeviceHostUnavailableError({
            hostId: host.id,
            hostLabel: host.label,
            reason:
              "Agent device access requires enabled device support, agent access, and an available simulator platform on this host.",
          });
        const { configPath, agentDeviceId, boundSession, installDirectory } =
          yield* lifecycleLock.withPermit(
            Effect.gen(function* () {
              if (hosts.get(host.id) !== host)
                return yield* new DeviceHostUnavailableError({
                  hostId: host.id,
                  hostLabel: host.label,
                  reason: "Host configuration changed. Retry the operation.",
                });
              if (ready.devices.agentEndpoint) {
                const endpoint = yield* ready.devices.agentEndpoint(input.deviceId);
                return {
                  configPath: yield* configureAgent(input.hostId, endpoint, input.deviceId),
                  agentDeviceId: endpoint.agentDeviceId,
                  boundSession: endpoint.session,
                  installDirectory: endpoint.installDirectory,
                };
              }
              if (!ready.agentDevice)
                return yield* new DeviceHostUnavailableError({
                  hostId: host.id,
                  hostLabel: host.label,
                  reason: "This host has no agent-device daemon.",
                });
              return {
                configPath: yield* configureAgent(input.hostId, ready.agentDevice),
                agentDeviceId: input.deviceId,
                boundSession: undefined,
                installDirectory: undefined,
              };
            }),
          );
        const ownSession = yield* agentDeviceSession(
          input.threadId,
          input.hostId,
          input.deviceId,
        ).pipe(Effect.provideService(Digest.Digest, digest));
        if (boundSession) hostSessionLaunchers.add(ownSession);
        const session = boundSession ?? ownSession;
        return {
          agentDeviceId,
          session,
          args: ["--config", configPath, "--session", session],
          installDirectory,
        };
      }),
      agentLauncher: Effect.fn("DeviceService.agentLauncher")(function* ({
        targetArgs,
        ...target
      }) {
        if (!launchers)
          return yield* new DeviceHostUnavailableError({
            hostId: target.hostId,
            reason: "Agent launchers are unavailable in this device service.",
          });
        const session = yield* agentDeviceSession(
          target.threadId,
          target.hostId,
          target.deviceId,
        ).pipe(Effect.provideService(Digest.Digest, digest));
        return yield* launcherLock.withPermit(
          Effect.gen(function* () {
            const { state } = yield* SynchronizedRef.get(stateRef);
            if (
              !state.sessions.some(
                (live) =>
                  live.threadId === target.threadId &&
                  live.hostId === target.hostId &&
                  live.deviceId === target.deviceId,
              )
            )
              return Option.none();
            const launcher = yield* launchers.bind({ session, targetArgs });
            boundLaunchers.set(session, launcher);
            return Option.some(launcher);
          }),
        );
      }),
      state: SynchronizedRef.get(stateRef).pipe(Effect.map(({ state }) => state)),
      subscribe: PubSub.subscribe(statePubSub),
      configure,
      list,
      open,
      close,
      shutdown,
      detail,
      action,
      screenshot,
      locateDevice,
      locateSession,
      readiness,
      readinessIfSupported,
      agentReadinessIfSupported,
      currentReadiness,
      sessionsForThread,
    }),
    setHostStatus,
    withLifecycleLock: lifecycleLock.withPermit,
    refreshHosts: Effect.gen(function* () {
      const summaries = yield* Effect.forEach(hosts.values(), (host) => host.summary);
      const unchanged = (id: DeviceHostId) =>
        hosts.has(id) && hosts.get(id) === publishedHostsCell.hosts.get(id);
      yield* publish((state) => ({
        ...state,
        hosts: summaries,
        hostStatuses: Object.fromEntries(
          Object.entries(state.hostStatuses).filter(([id]) => unchanged(id)),
        ),
        devices: state.devices.filter((device) => unchanged(device.hostId)),
        sessions: state.sessions.filter((session) => unchanged(session.hostId)),
      }));
      publishedHostsCell.hosts = new Map(hosts);
    }),
  };
});
