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
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { DeviceHostAmbiguousError, DeviceOnOtherHostError, DeviceService } from "./DeviceService.ts";
import type { DeviceReadiness } from "./DeviceService.ts";

import * as ServerSettings from "../serverSettings.ts";

import { readDeviceDetail, runDeviceAction } from "./DeviceActions.ts";
import * as DeviceHost from "./DeviceHost.ts";

import type { makeDeviceState } from "./DeviceService-part3.ts";

type State = Effect.Success<ReturnType<typeof makeDeviceState>>;

export const makeDeviceStage2 = Effect.fn("makeDeviceStage2")(function* (state: State) {
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
  } = state;
  const ensurePlatform = Effect.fn("DeviceService.ensurePlatform")(function* (
    host: DeviceHost.DeviceHost["Service"],
    platform: DevicePlatform,
  ) {
    const availability = yield* host.platformAvailability(platform);
    if (!availability.available) {
      return yield* new DevicePlatformUnavailableError({
        hostId: host.id,
        platform,
        reason: availability.reason ?? "Platform toolchain missing.",
      });
    }
  });

  const open: DeviceService["Service"]["open"] = Effect.fn("DeviceService.open")(
    function* (input, context) {
      const host = yield* resolveHost(input.hostId);
      yield* ensurePlatform(host, input.platform);
      const ready = yield* readiness(host.id);
      let state = yield* refresh(ready);
      let device = findDevice(state, host.id, input.deviceId);
      if (!device) {
        return yield* new DeviceNotFoundError({ hostId: host.id, deviceId: input.deviceId });
      }
      // Hosts that route their own streams never encode emulator video with serve-emu's ffmpeg.
      if (device.platform === "android" && !device.physical && !ready.upstream) {
        // Resolve the override on the device host the way its hub does.
        const encoders = yield* ready.run(ready.nodePath, [
          "-e",
          `const { spawnSync } = require("node:child_process");
  const result = spawnSync(process.env.SERVE_EMU_FFMPEG?.trim() || "ffmpeg", ["-hide_banner", "-encoders"], {
    stdio: "inherit", timeout: 10000, killSignal: "SIGKILL",
  });
  process.exitCode = result.error ? 1 : (result.status ?? 1);`,
        ]);
        if (encoders.code !== 0) {
          return yield* new DevicePlatformUnavailableError({
            hostId: host.id,
            platform: "android",
            reason:
              "Android emulator video needs working ffmpeg with the libx264 encoder. Install it on the device host's PATH or set SERVE_EMU_FFMPEG there, then retry opening the emulator. After changing PATH or SERVE_EMU_FFMPEG, turn device support off and on for SSH hosts, or restart the local environment server.",
          });
        }
        if (!/^\s*V\S*[ \t]+libx264(?:[ \t]|$)/m.test(`${encoders.stdout}\n${encoders.stderr}`)) {
          return yield* new DevicePlatformUnavailableError({
            hostId: host.id,
            platform: "android",
            reason:
              "Android emulator video needs the libx264 encoder. Install an ffmpeg build that includes libx264 on the device host, then retry opening the emulator. After changing PATH or SERVE_EMU_FFMPEG, turn device support off and on for SSH hosts, or restart the local environment server.",
          });
        }
      }
      if (!device.booted && input.boot !== false) {
        const booting = { ...device, threadId: input.threadId };
        yield* publish((current) => ({
          ...current,
          bootingDevices: [
            ...(current.bootingDevices ?? []).filter(
              (entry) => entry.hostId !== booting.hostId || entry.id !== booting.id,
            ),
            booting,
          ],
        }));
        const bootedId = yield* ready.devices.boot(device, context).pipe(
          Effect.ensuring(
            publish((current) => ({
              ...current,
              bootingDevices: (current.bootingDevices ?? []).filter(
                (entry) => entry.hostId !== booting.hostId || entry.id !== booting.id,
              ),
            })),
          ),
        );
        state = yield* refresh(ready);
        device = findDevice(state, host.id, bootedId) ?? findDevice(state, host.id, device.id);
        if (!device) {
          return yield* new DeviceNotFoundError({ hostId: host.id, deviceId: bootedId });
        }
      } else if (device.booted) {
        yield* ready.devices.attach(device);
      }
      if (hosts.get(host.id) !== host)
        return yield* new DeviceHostUnavailableError({
          hostId: host.id,
          hostLabel: host.label,
          reason: "Host configuration changed. Retry the operation.",
        });
      const openedAt = DateTime.formatIso(yield* DateTime.now);
      const session: DeviceSession = {
        threadId: input.threadId,
        hostId: host.id,
        deviceId: device.id,
        platform: device.platform,
        openedAt,
      };
      yield* lifecycleLock.withPermit(
        Effect.gen(function* () {
          if (!(yield* readDeviceSettings).enabled)
            return yield* new DeviceHostUnavailableError({
              hostId: host.id,
              hostLabel: host.label,
              reason: "Device support was turned off while the device was opening.",
            });
          yield* publish((current) => ({
            ...current,
            sessions: [
              ...current.sessions.filter(
                (existing) =>
                  !(
                    existing.threadId === session.threadId &&
                    existing.hostId === session.hostId &&
                    existing.deviceId === session.deviceId
                  ),
              ),
              session,
            ],
          }));
        }),
      );
      return session;
    },
  );

  const refreshAfterShutdown = (ready: DeviceReadiness) =>
    refresh(ready).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Device discovery unavailable after shutdown", { cause }),
      ),
    );

  const shutdownDevice = Effect.fn("DeviceService.shutdownDevice")(function* (
    ready: DeviceReadiness,
    deviceId: DeviceId,
    platform: DevicePlatform,
  ) {
    yield* ready.devices.shutdown({ id: deviceId, platform });
    yield* publish((state) => ({
      ...state,
      devices: state.devices.map((device) =>
        device.hostId === ready.hostId && device.id === deviceId
          ? { ...device, booted: false }
          : device,
      ),
    }));
  });

  const close: DeviceService["Service"]["close"] = Effect.fn("DeviceService.close")(
    function* (input) {
      // Open publishes under the same lock; an old close must not release a reopened claim.
      const closing = yield* lifecycleLock.withPermit(
        Effect.gen(function* () {
          const { state } = yield* SynchronizedRef.get(stateRef);
          const closing = state.sessions.filter(
            (session) =>
              session.threadId === input.threadId &&
              (input.hostId === undefined || session.hostId === input.hostId) &&
              (input.deviceId === undefined || session.deviceId === input.deviceId),
          );
          const ending = input.shutdown
            ? state.sessions.filter((session) =>
                closing.some(
                  (closed) =>
                    closed.hostId === session.hostId && closed.deviceId === session.deviceId,
                ),
              )
            : closing;
          for (const session of ending) {
            const host = yield* resolveHost(session.hostId);
            const ready = yield* host.current;
            // A lost SSH tunnel does not establish that the remote daemon stopped.
            if (!ready && (yield* host.summary).kind === "ssh")
              return yield* new DeviceHostUnavailableError({
                hostId: session.hostId,
                hostLabel: host.label,
                reason: "Device host is reconnecting. Retry close after it reconnects.",
              });
            if (ready?.releaseAgentSession) {
              const name = yield* agentDeviceSession(
                session.threadId,
                session.hostId,
                session.deviceId,
              ).pipe(Effect.provideService(Digest.Digest, digest));
              yield* ready.releaseAgentSession(name, session.deviceId);
            }
          }
          if (input.shutdown) yield* releaseLaunchers(ending);
          if (input.shutdown) {
            for (const session of closing) {
              const ready = yield* currentReadiness(session.hostId);
              if (!ready)
                return yield* new DeviceHostUnavailableError({
                  hostId: session.hostId,
                  reason: "Device host is not running. Reconnect before retrying close.",
                });
              yield* shutdownDevice(ready, session.deviceId, session.platform);
            }
          }
          yield* publish((current) => ({
            ...current,
            sessions: current.sessions.filter((session) => !ending.includes(session)),
          }));
          return closing;
        }),
      );
      if (input.shutdown)
        yield* Effect.forEach(
          closing,
          (session) =>
            currentReadiness(session.hostId).pipe(
              Effect.flatMap((ready) => (ready ? refreshAfterShutdown(ready) : Effect.void)),
            ),
          { discard: true },
        );
    },
  );

  // Sessions retire before the power-off, while their agent-device sessions can still close the app;
  // agent-device keeps a claim whose app close fails.
  const shutdown: DeviceService["Service"]["shutdown"] = Effect.fn("DeviceService.shutdown")(
    function* (input) {
      const host = yield* resolveHost(input.hostId);
      yield* publish((current) => ({
        ...current,
        sessions: current.sessions.filter(
          (session) => !(session.hostId === host.id && session.deviceId === input.deviceId),
        ),
      }));
      const ready = yield* readiness(host.id);
      yield* shutdownDevice(ready, input.deviceId, input.platform);
      yield* refreshAfterShutdown(ready);
    },
  );

  const screenshot: DeviceService["Service"]["screenshot"] = Effect.fn("DeviceService.screenshot")(
    function* (input) {
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId);
      return { device, png: yield* ready.devices.screenshot(device) };
    },
  );

  const resolveDevice = Effect.fn("DeviceService.resolveDevice")(function* (
    hostId: DeviceHostId | undefined,
    deviceId: DeviceId,
  ) {
    const host = yield* resolveHost(hostId);
    const ready = yield* readiness(host.id);
    const { state } = yield* SynchronizedRef.get(stateRef);
    const device =
      findDevice(state, host.id, deviceId) ?? findDevice(yield* refresh(ready), host.id, deviceId);
    if (!device) return yield* new DeviceNotFoundError({ hostId: host.id, deviceId });
    return { ready, device };
  });

  const detail: DeviceService["Service"]["detail"] = Effect.fn("DeviceService.detail")(
    function* (input) {
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId);
      const read = yield* readDeviceDetail(ready, device.platform, device.id);
      return {
        hostId: ready.hostId,
        deviceId: device.id,
        settings: read.settings,
        foregroundApp: read.foregroundApp,
        readAt: DateTime.formatIso(yield* DateTime.now),
      };
    },
  );

  const action: DeviceService["Service"]["action"] = Effect.fn("DeviceService.action")(
    function* (input) {
      const { ready, device } = yield* resolveDevice(input.hostId, input.deviceId);
      yield* runDeviceAction(ready, device.platform, input);
      return yield* detail({ hostId: ready.hostId, deviceId: device.id });
    },
  );

  const sessionsForThread: DeviceService["Service"]["sessionsForThread"] = (threadId) =>
    SynchronizedRef.get(stateRef).pipe(
      Effect.map(({ state }) => state.sessions.filter((session) => session.threadId === threadId)),
    );

  const locate = <T extends { readonly hostId: DeviceHostId }>(
    state: DeviceServiceState,
    input: { readonly hostId?: DeviceHostId | undefined; readonly deviceId: DeviceId },
    matches: ReadonlyArray<T>,
  ): Effect.Effect<Option.Option<T>, DeviceHostAmbiguousError | DeviceOnOtherHostError> => {
    const named = (id: DeviceHostId) => ({
      id,
      label: state.hosts.find((host) => host.id === id)?.label,
    });
    const onHost = matches.filter(
      (match) => input.hostId === undefined || match.hostId === input.hostId,
    );
    const hostIds = [...new Set(onHost.map((match) => match.hostId))];
    if (hostIds.length === 1) return Effect.succeedSome(onHost.at(-1)!);
    if (hostIds.length > 1) {
      return Effect.fail(
        new DeviceHostAmbiguousError({ deviceId: input.deviceId, hosts: hostIds.map(named) }),
      );
    }
    const elsewhere = [...new Set(matches.map((match) => match.hostId))];
    return input.hostId !== undefined && elsewhere.length > 0
      ? Effect.fail(
          new DeviceOnOtherHostError({
            deviceId: input.deviceId,
            host: named(input.hostId),
            hosts: elsewhere.map(named),
          }),
        )
      : Effect.succeedNone;
  };

  return {
    ...state,
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
  };
});
