import {
  OrchestratorMcpFailure,
  type HostResourcesSnapshot,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as HostResources from "../../../resourceTelemetry/HostResources.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const MAX_DISKS = 6;
const gib = (bytes: number) => Math.round((bytes / 1024 ** 3) * 10) / 10;
const percent = (share: number) => Math.round(share * 100);

function machineResources(snapshot: HostResourcesSnapshot) {
  const { storage, gpu, swap, loadAverage } = snapshot;
  return {
    cpu: {
      usedPercent: snapshot.cpuUtilization === null ? null : percent(snapshot.cpuUtilization),
      cores: snapshot.cpuCount,
      ...(snapshot.cpuModel ? { model: snapshot.cpuModel } : {}),
      ...(loadAverage ? { load1m: Math.round(loadAverage.one * 10) / 10 } : {}),
    },
    memory: {
      availableGiB: gib(snapshot.availableMemoryBytes),
      totalGiB: gib(snapshot.totalMemoryBytes),
    },
    ...(swap && swap.totalBytes > 0
      ? { swap: { usedGiB: gib(swap.usedBytes), totalGiB: gib(swap.totalBytes) } }
      : {}),
    // HostStorage lists T3's own volumes first.
    ...(storage
      ? {
          disks: storage.volumes.slice(0, MAX_DISKS).map((volume) => ({
            mount: volume.mountPoint,
            freeGiB: gib(volume.availableBytes),
            totalGiB: gib(volume.totalBytes),
            ...(volume.roles.length > 0 ? { holds: volume.roles } : {}),
          })),
        }
      : {}),
    ...(storage?.unavailableReason ? { disksUnavailable: storage.unavailableReason } : {}),
    ...(gpu && gpu.gpus.length > 0
      ? {
          gpus: gpu.gpus.map(({ name, utilization, memoryTotalBytes, memoryUsedBytes }) => ({
            name,
            ...(utilization === undefined ? {} : { usedPercent: percent(utilization) }),
            ...(memoryTotalBytes === undefined
              ? {}
              : {
                  memoryFreeGiB: gib(Math.max(0, memoryTotalBytes - (memoryUsedBytes ?? 0))),
                  memoryTotalGiB: gib(memoryTotalBytes),
                }),
          })),
        }
      : {}),
    ...(gpu?.unavailableReason ? { gpusUnavailable: gpu.unavailableReason } : {}),
  };
}

const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      // Bounded: storage answers within its 3 s deadline, with its last reading after that.
      const machine = yield* (yield* HostResources.HostResources).readMachine;
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
        machine: machineResources(machine),
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
