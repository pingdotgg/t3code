import {
  type DeviceError,
  type DeviceHostId,
  type DeviceHostSummary,
  type DeviceId,
  type DevicePlatform,
  type DeviceSummary,
  DeviceToolUnavailableError,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as DeviceService from "../../../device/DeviceService.ts";
import { threadWorkspaceRoot } from "../../../project/threadWorkspaceRoot.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { DeviceScreenshotToolkit, DeviceStandardToolkit, DeviceToolkit } from "./tools.ts";

function agentDeviceTargetArgs(device: DeviceSummary): ReadonlyArray<string> {
  return device.platform === "ios"
    ? ["--platform", "ios", "--udid", device.id]
    : ["--platform", "android", "--serial", device.id];
}

const shellWord = (value: string) =>
  /^[a-zA-Z0-9_./:-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\"'\"'") + "'";

/** `targetArgs` are the flags the command still needs; a bound launcher needs none. */
export function agentDeviceQuickStart(
  device: DeviceSummary,
  targetArgs = agentDeviceTargetArgs(device),
  command = "agent-device",
  cloud = false,
): string {
  const executable = shellWord(command);
  const target = targetArgs.map(shellWord).join(" ");
  const run = (args: string) => [executable, args, target].filter(Boolean).join(" ");
  const platformNotes = cloud
    ? "This is an EAS Simulator session in the cloud. It bills the Expo account per minute until it stops, so call device_close with shutdown: true when you are done. It starts with no apps installed: install-from-source <url> installs a build from a URL (iOS needs a .tar.gz containing a .app), and install uploads one from this machine."
    : device.platform === "ios"
      ? "First use builds an XCTest runner and can take a couple of minutes; later commands are fast."
      : "The Android snapshot helper installs itself on first use.";
  return [
    `The user is watching ${device.name} (${device.version}) in the Device panel.`,
    target === ""
      ? `Drive it with ${executable}. It is bound to this device and session, so it needs no --platform, --udid, --serial, --config or --session flags. Use this exact path; login shells may reset PATH.`
      : `Drive it with ${executable}. Use this exact path; login shells may reset PATH. Always pass ${target}.`,
    // Screenshots and input need the session agent-device's open starts, and an iOS snapshot also
    // needs its app. device_open does not run open itself: on iOS that can start a minutes-long
    // XCTest runner build.
    "Every app launch, deep link, tap, text entry, alert, setting, screenshot and recording on this device goes through it. Run open <bundle-or-package-id> (apps lists them) before snapshots, CLI screenshots or input; it starts the session they need. Use device_screenshot just to look.",
    `  ${run("open <bundle-or-package-id> --relaunch")}  # restarts the app; Expo dev clients connect to their Metro, --metro-port <port> picks it`,
    `  ${run("open <bundle-or-package-id> <deep-link-url>")}`,
    `  ${run("snapshot -i")}  # accessibility tree with @eN refs`,
    `  ${run("press @e3 --settle")}`,
    `  ${run('fill @e5 "text" --settle')}`,
    `  ${run("alert accept")}`,
    `  ${run("settings appearance dark")}  # also text-size, permission grant <name>`,
    `  ${run("screenshot /tmp/shot.png")}  # ${device.platform === "ios" ? "iOS saves 1x points; add --pixel-density <n> (3 on most iPhones) for device resolution, " : ""}or call device_screenshot to look`,
    `  ${run("record start --scope device /tmp/run.mp4")}  # then record stop`,
    `  ${run("install <app> <path-to-.app-or-.apk>")}`,
    `Prefer snapshot refs over coordinates. Run ${executable} help <command> for flags and ${executable} help workflow for guides.`,
    "Do not use simctl, idb, adb or ssh for those actions. They stay fine for builds, installs, code sync, Metro, port forwards, logs, test runners and what this command cannot do; come back to it for every UI action and screenshot so the user can watch.",
    "Each device_open returns its own command; opening another device does not retarget this one.",
    ...(target === ""
      ? [
          "The command is removed when the device closes or T3 Code restarts. If it is missing, call device_open again.",
        ]
      : []),
    platformNotes,
  ].join("\n");
}

const requireDeviceAccess = McpInvocationContext.requireThreadMcpCapability("device").pipe(
  Effect.mapError(
    () =>
      new DeviceToolUnavailableError({
        reason:
          "Agent device access is turned off for this environment. Ask the user to turn on Agent device access in Settings > Integrations > Devices; it applies when the agent session next starts, such as in a new thread.",
      }),
  ),
);

const hostName = (host: { readonly id: DeviceHostId; readonly label?: string | undefined }) =>
  host.label === undefined ? `hostId ${host.id}` : `'${host.label}' (hostId ${host.id})`;

const mapLocateErrors = <A, R>(
  effect: Effect.Effect<
    A,
    DeviceService.DeviceHostAmbiguousError | DeviceService.DeviceOnOtherHostError,
    R
  >,
) =>
  effect.pipe(
    Effect.catchTags({
      DeviceHostAmbiguousError: (error) =>
        Effect.fail(
          new DeviceToolUnavailableError({
            reason: `Device ${error.deviceId} is on more than one host: ${error.hosts.map(hostName).join(", ")}. Pass hostId.`,
          }),
        ),
      DeviceOnOtherHostError: (error) =>
        Effect.fail(
          new DeviceToolUnavailableError({
            reason: `Device ${error.deviceId} is not on ${hostName(error.host)}. It is on ${error.hosts.map(hostName).join(", ")}; pass that hostId.`,
          }),
        ),
    }),
  );

const pickDevice = Effect.fn("handlers.pickDevice")(function* (
  state: {
    readonly hosts: ReadonlyArray<DeviceHostSummary>;
    readonly devices: ReadonlyArray<DeviceSummary>;
  },
  input: {
    readonly deviceId?: DeviceId | undefined;
    readonly platform?: DevicePlatform | undefined;
    readonly hostId?: DeviceHostId | undefined;
  },
): Effect.fn.Return<DeviceSummary, DeviceToolUnavailableError, DeviceService.DeviceService> {
  if (input.deviceId !== undefined) {
    const { deviceId, hostId } = input;
    const devices = yield* DeviceService.DeviceService;
    const located = yield* devices.locateDevice({ deviceId, hostId }).pipe(mapLocateErrors);
    if (Option.isSome(located)) return located.value;
    return yield* new DeviceToolUnavailableError({
      reason: `No device ${deviceId} on ${hostId === undefined ? "any host" : hostName(state.hosts.find((host) => host.id === hostId) ?? { id: hostId })}. Call device_list for current ids.`,
    });
  }
  const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
  const candidates = state.devices.filter(
    (device) =>
      device.hostId === hostId &&
      (input.platform === undefined || device.platform === input.platform),
  );
  if (candidates.length === 0) {
    return yield* new DeviceToolUnavailableError({
      reason:
        input.platform === undefined
          ? "No simulators or emulators were found. Call device_list to see why."
          : `No ${input.platform} devices were found on host ${hostId}. Call device_list to see why.`,
    });
  }
  const platforms = new Set(candidates.map((device) => device.platform));
  if (input.platform === undefined && platforms.size > 1) {
    return yield* new DeviceToolUnavailableError({
      reason: "Both iOS and Android devices are available; pass platform or deviceId.",
    });
  }
  return candidates.find((device) => device.booted) ?? candidates[0]!;
});

const toolError = (error: DeviceError | DeviceToolUnavailableError) => error;

const handlers = {
  device_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      if (state.hostStatus === "disabled") {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const hostId = input?.hostId;
      const open = state.sessions
        .filter((session) => session.threadId === scope.thread.threadId)
        .map((session) => ({ hostId: session.hostId, deviceId: session.deviceId }));
      return {
        hostStatuses: Object.fromEntries(
          Object.entries(state.hostStatuses).filter(([id]) => !hostId || id === hostId),
        ),
        hosts: hostId ? state.hosts.filter((host) => host.id === hostId) : state.hosts,
        devices: hostId
          ? state.devices.filter((device) => device.hostId === hostId)
          : state.devices,
        open,
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_open: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      if (state.hostStatus === "disabled") {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Device support is off. Ask the user to enable it in the Device panel before installing or starting device tools.",
        });
      }
      const target = yield* pickDevice(state, input);
      // Resolve consent and agent connectivity before booting or registering a session.
      if (!(yield* devices.agentReadinessIfSupported(target.hostId))) {
        return yield* new DeviceToolUnavailableError({
          reason:
            "Agent device access requires enabled device support, agent access, and an available simulator platform on this host.",
        });
      }
      const session = yield* devices.open(
        {
          threadId: scope.thread.threadId,
          hostId: target.hostId,
          deviceId: target.id,
          platform: target.platform,
        },
        { workspaceRoot: yield* threadWorkspaceRoot(scope.thread.threadId) },
      );
      const after = yield* devices.state;
      const device =
        after.devices.find(
          (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
        ) ?? target;
      // Target the opened device: an EAS device and its agent-device daemon
      // exist only once its session runs, and Android ids change on boot.
      const opened = {
        threadId: scope.thread.threadId,
        hostId: session.hostId,
        deviceId: session.deviceId,
      };
      const agent = yield* devices.agentTarget(opened);
      const cloud = after.hosts.some((host) => host.id === device.hostId && host.kind === "eas");
      const targetArgs = [
        ...agentDeviceTargetArgs({ ...device, id: agent.agentDeviceId }),
        ...agent.args,
      ];
      const launcher = yield* devices.agentLauncher({ ...opened, targetArgs });
      if (Option.isNone(launcher)) {
        return yield* new DeviceToolUnavailableError({
          reason:
            "The device was closed while device_open was preparing it. Call device_open again only if you still need it.",
        });
      }
      const command = launcher.value;
      return {
        device,
        agentDevice: { command, targetArgs, session: agent.session },
        quickStart: agentDeviceQuickStart(device, [], command, cloud),
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_screenshot: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const threadId = scope.thread.threadId;
      const target =
        input.deviceId === undefined
          ? (yield* devices.sessionsForThread(threadId)).findLast(
              (session) => input.hostId === undefined || session.hostId === input.hostId,
            )
          : Option.getOrUndefined(
              yield* devices
                .locateSession({ threadId, deviceId: input.deviceId, hostId: input.hostId })
                .pipe(mapLocateErrors),
            );
      if (!target) {
        return yield* new DeviceToolUnavailableError({
          reason:
            input.deviceId === undefined
              ? "No device is open in this thread. Call device_open first."
              : `Device ${input.deviceId} is not open in this thread. Call device_open first.`,
        });
      }
      const shot = yield* devices.screenshot(target);
      return {
        device: shot.device,
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(shot.png).toString("base64"),
          ...pngDimensions(shot.png),
        },
      };
    }).pipe(Effect.mapError(toolError)),
  ),
  device_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const deviceId = input.deviceId;
      const open =
        deviceId === undefined
          ? Option.none()
          : yield* devices
              .locateSession({ threadId: scope.thread.threadId, deviceId, hostId: input.hostId })
              .pipe(mapLocateErrors);
      const hostId = Option.isSome(open) ? open.value.hostId : input.hostId;
      yield* devices.close({
        threadId: scope.thread.threadId,
        ...(hostId === undefined ? {} : { hostId }),
        ...(deviceId === undefined ? {} : { deviceId }),
        ...(input.shutdown === undefined ? {} : { shutdown: input.shutdown }),
      });
      return {};
    }).pipe(Effect.mapError(toolError)),
  ),
} satisfies McpToolAccess.Handlers<typeof DeviceToolkit.tools>;

export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const isPng =
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452;
  return isPng
    ? { width: view.getUint32(16), height: view.getUint32(20) }
    : { width: 0, height: 0 };
}

const { device_screenshot, ...standardHandlers } = handlers;

export const layerStandard = McpToolAccess.toLayer(DeviceStandardToolkit, standardHandlers);

export const layerScreenshot = McpToolAccess.toLayer(DeviceScreenshotToolkit, {
  device_screenshot,
});
