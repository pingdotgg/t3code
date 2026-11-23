import { type DeviceToolVersions, WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";

export function createDeviceEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { environmentId: string }) => environmentId,
  };
  // Starting an Expo Simulator can take minutes; it must not hold up powering off
  // another device or turning device support off, so each device opens in its
  // own lane. Every Expo start opens the same catalog device, so the thread is
  // part of the lane too.
  const openConcurrency = {
    mode: "serial" as const,
    key: ({
      environmentId,
      input,
    }: {
      environmentId: string;
      input: {
        readonly threadId: string;
        readonly hostId?: string | undefined;
        readonly deviceId: string;
      };
    }) =>
      JSON.stringify([environmentId, "open", input.threadId, input.hostId ?? null, input.deviceId]),
  };
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:device:state",
      tag: WS_METHODS.subscribeDeviceState,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:configure",
      tag: WS_METHODS.deviceConfigure,
      scheduler,
      concurrency,
    }),
    testHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:test-host",
      tag: WS_METHODS.deviceTestHost,
    }),
    easAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:eas-account",
      tag: WS_METHODS.deviceEasAccount,
    }),
    list: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:list",
      tag: WS_METHODS.deviceList,
      scheduler,
      concurrency,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:open",
      tag: WS_METHODS.deviceOpen,
      scheduler,
      concurrency: openConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:close",
      tag: WS_METHODS.deviceClose,
      scheduler,
      concurrency,
    }),
    shutdown: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:shutdown",
      tag: WS_METHODS.deviceShutdown,
      scheduler,
      concurrency,
    }),
    detail: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:detail",
      tag: WS_METHODS.deviceDetail,
      scheduler,
      concurrency,
    }),
    action: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:device:action",
      tag: WS_METHODS.deviceAction,
      scheduler,
      concurrency,
    }),
  };
}

export function deviceToolVersionLabels(
  tools: DeviceToolVersions | undefined,
  resolve: MFunctionType = mFallback,
) {
  if (!tools) return [resolve(msg("Device tool versions have not been checked."))];
  return (
    [
      [resolve(msg("Device hub")), tools.hub],
      [resolve(msg("Agent tools")), tools.agent],
    ] as const
  ).map(([name, tool]) => {
    const installed = tool.installedVersions.length
      ? tool.installedVersions.join(", ")
      : resolve(msg("none", { $context: "no installed versions" }));
    return tool.runningVersion
      ? resolve(
          msg("{name}: installed {installed}; required {required}; running {running}.", {
            name,
            installed,
            required: tool.requiredVersion,
            running: tool.runningVersion,
          }),
        )
      : resolve(
          msg("{name}: installed {installed}; required {required}.", {
            name,
            installed,
            required: tool.requiredVersion,
          }),
        );
  });
}

export function deviceToolUpdatePolicy(
  tools: DeviceToolVersions | undefined,
  resolve: MFunctionType = mFallback,
) {
  if (!tools)
    return resolve(msg("Versions have not been checked. Reconnect the host and check versions."));
  const outdated = [tools.hub, tools.agent].filter(
    (tool) =>
      tool.installedVersions.length > 0 && !tool.installedVersions.includes(tool.requiredVersion),
  );
  return outdated.length > 0
    ? resolve(
        msg(
          "Update pending. Required tools will install automatically when next used. The host needs network access; an older install is not used as a fallback.",
        ),
      )
    : resolve(
        msg(
          "Required tools are installed automatically when needed. Checking versions does not install or start anything.",
        ),
      );
}
export const deviceToolUpdateOwnership = msg(
  "This environment's T3 server chooses device tool versions for itself and its SSH hosts. Update that server to receive newer tool versions; updating only your browser or mobile app does not update a remote server.",
);
