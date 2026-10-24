import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import {
  PROVIDER_DISPLAY_NAMES,
  type EnvironmentId,
  type ServerConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { APP_VERSION } from "~/branding";
import {
  canOneClickUpdateProviderCandidate,
  collectProviderUpdateCandidates,
} from "../ProviderUpdateLaunchNotification.logic";
import type { UpdatePlanItem } from "./updateEverythingPlan";
import { exactUpdateVersion } from "./updateEverythingPlan";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";

import {
  resolveServerSelfUpdateCapability,
  resolveVersionMismatch,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "~/versionSkew";
import type { ServerUpdateTarget } from "../ServerUpdateAction";

export type UpdateItemKey = string;

export interface UpdatePickerItem {
  readonly key: UpdateItemKey;
  readonly kind: "app" | "server" | "provider";
  readonly label: string;
  readonly context: string | null;
  readonly fromVersion: string | null;
  readonly toVersion: string | null;
  readonly note: string | null;
  readonly disabledReason: string | null;
  readonly restarts: readonly RestartingMachine[];
  readonly canDisableAutoResume?: boolean;
}

export interface UpdatePickerDevice {
  readonly id: string;
  readonly label: string;
  readonly unavailableReason: string | null;
  readonly items: readonly UpdatePickerItem[];
}

export type UpdatePlanPausedReason =
  | "later"
  | "download-failed"
  | "install-refused"
  | "wrong-version"
  | "not-applied"
  | "expired"
  | "storage"
  | "unknown";

export interface UpdateEverythingMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: {
    readonly environment: ServerConfig["environment"];
    readonly settings: Pick<ServerConfig["settings"], "continueThreadsAfterServerUpdate">;
  } | null;
  readonly connected: boolean;
  readonly hostedByThisApp: boolean;
  readonly canMaintain: boolean;
  readonly updateState: ServerUpdateState;
}

export interface RestartingMachine {
  readonly environmentId: EnvironmentId;
  readonly continuesThreads: boolean;
}

export function collectRestartingMachines(
  machines: ReadonlyArray<UpdateEverythingMachine>,
  servers: ReadonlyArray<Pick<ServerUpdateTarget, "environmentId">>,
  installsLocal: boolean,
): RestartingMachine[] {
  const updated = new Set(servers.map((server) => server.environmentId));
  return machines.flatMap((machine) => {
    const config = machine.serverConfig;
    if (
      config === null ||
      !machine.connected ||
      !(updated.has(machine.environmentId) || (installsLocal && machine.hostedByThisApp))
    ) {
      return [];
    }
    return [
      {
        environmentId: machine.environmentId,
        continuesThreads:
          config.environment.capabilities.threadRestartContinuation === true &&
          config.settings.continueThreadsAfterServerUpdate === true,
      },
    ];
  });
}

export interface SkippedMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly reason: string;
}

/**
 * Two kinds are in neither list: servers already on the target, and servers this app hosts,
 * which would relaunch the app mid-run and update with the app's own install anyway. A
 * desktop-managed server follows its own app's update feed, so the channel rule does not apply
 * to it.
 */
export function collectServerUpdateTargets(
  machines: ReadonlyArray<UpdateEverythingMachine>,
  targetVersion: string,
  retryCurrent = false,
): { readonly targets: ServerUpdateTarget[]; readonly skipped: SkippedMachine[] } {
  const targets: ServerUpdateTarget[] = [];
  const skipped: SkippedMachine[] = [];
  for (const machine of machines) {
    const config = machine.serverConfig;
    if (machine.hostedByThisApp) continue;
    if (
      config !== null &&
      resolveVersionMismatch(config.environment.serverVersion, targetVersion) === null &&
      !(retryCurrent && exactUpdateVersion(config.environment.serverVersion, targetVersion))
    ) {
      continue;
    }
    const skip = (reason: string) =>
      skipped.push({ environmentId: machine.environmentId, label: machine.label, reason });
    if (config === null || !machine.connected) {
      skip("not connected");
      continue;
    }
    if (!machine.canMaintain) {
      skip("no permission");
      continue;
    }
    if (machine.updateState.status === "running") {
      skip("already updating");
      continue;
    }
    const selfUpdate = resolveServerSelfUpdateCapability(config);
    const desktopAppUpdate = supportsDesktopAppUpdate(config);
    if (selfUpdate === null) {
      skip("needs a manual update");
      continue;
    }
    if (selfUpdate === "desktop-managed" && !desktopAppUpdate) {
      skip("needs a newer desktop app");
      continue;
    }
    const serverVersion = config.environment.serverVersion;
    if (
      selfUpdate !== "desktop-managed" &&
      cliReleaseChannelOf(serverVersion) !== cliReleaseChannelOf(targetVersion)
    ) {
      skip(`on the ${cliReleaseChannelOf(serverVersion)} channel`);
      continue;
    }
    targets.push({
      environmentId: machine.environmentId,
      serverLabel: machine.label,
      selfUpdate,
      installation: config.environment.capabilities.serverInstallation,
      desktopAppUpdate,
      threadContinuation: supportsServerUpdateThreadContinuation(config),
      continueThreadsAfterServerUpdate: config.settings.continueThreadsAfterServerUpdate ?? false,
      targetVersion,
    });
  }
  return { targets, skipped };
}

export type UpdateRunMachineStatus =
  | "providers"
  | "waiting"
  | "waiting-dependency"
  | "downloading"
  | "restarting"
  | "done"
  | "failed";

export interface UpdateRunMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly updatesProviders: boolean;
  readonly server: ServerUpdateTarget | null;
  readonly handedOffVersion: string | null;
  readonly startedAt: number;
  readonly result: "done" | "failed" | null;
  readonly failure: string | null;
}

export interface UpdateEverythingRun {
  readonly localVersion: string | null;
  readonly phase:
    | "local"
    | "providers"
    | "servers"
    | "countdown"
    | "installing"
    | "paused"
    | "complete";
  readonly pausedReason?: UpdatePlanPausedReason | null;
  readonly restartAt: number | null;
  readonly machines: ReadonlyArray<UpdateRunMachine>;
}

export function resolveUpdateRunMachineStatus(
  machine: UpdateRunMachine,
  phase: UpdateEverythingRun["phase"],
  serverState: ServerUpdateState,
): UpdateRunMachineStatus {
  if (machine.result !== null) return machine.result;
  if (machine.handedOffVersion !== null) return "restarting";
  if (
    (phase === "local" || phase === "countdown" || phase === "installing" || phase === "servers") &&
    machine.server === null &&
    machine.updatesProviders
  )
    return "waiting-dependency";
  if (phase === "providers" && machine.updatesProviders) return "providers";
  if (machine.server !== null && serverState.status === "running") {
    return serverState.stage === "resuming" ? "restarting" : "downloading";
  }
  return "waiting";
}

export function closeFinishedUpdateRun(run: UpdateEverythingRun): UpdateEverythingRun | null {
  return run.phase === "servers" &&
    run.localVersion === null &&
    run.machines.every((machine) => machine.result === "done")
    ? null
    : run;
}

const UPDATE_SLOW_AFTER_MS = 3 * 60 * 1000;

export function formatUpdateElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export interface UpdateRunMachineView {
  readonly machine: UpdateRunMachine;
  readonly status: UpdateRunMachineStatus;
}

export type UpdateRunLocalState =
  | { readonly status: "downloading"; readonly percent: number | null }
  | { readonly status: "waiting" }
  | null;

export interface UpdateCapsuleView {
  readonly tone: "default" | "slow" | "failed";
  readonly label: string;
  readonly slow?: { readonly status: string; readonly elapsed: string };
  readonly action: "later" | "retry" | "dismiss" | "restart" | "continue-without-app" | null;
}

const isActive = (status: UpdateRunMachineStatus) => status !== "done" && status !== "failed";

export function describeUpdateCapsule(
  run: UpdateEverythingRun,
  machines: ReadonlyArray<UpdateRunMachineView>,
  local: UpdateRunLocalState,
  now: number,
): UpdateCapsuleView {
  if (run.phase === "paused") {
    const reason = run.pausedReason;
    if (reason === "later" || reason === "install-refused")
      return { tone: "default", label: "Restart to continue", action: "restart" };
    if (reason === "wrong-version" || reason === "not-applied")
      return { tone: "failed", label: "App update did not apply", action: "continue-without-app" };
    if (reason === "download-failed")
      return { tone: "failed", label: "App download failed", action: "retry" };
    if (reason === "expired")
      return {
        tone: "failed",
        label: "Update plan expired. Review updates again.",
        action: "dismiss",
      };
    if (reason === "storage")
      return { tone: "failed", label: "Could not save update plan", action: "dismiss" };
    return { tone: "failed", label: "Check update results before retry", action: "retry" };
  }
  if (run.phase === "local")
    return {
      tone: "default",
      label:
        local?.status === "downloading"
          ? `Downloading${local.percent === null ? "" : ` ${Math.floor(local.percent)}%`}`
          : "Preparing this device",
      action: null,
    };
  if (run.phase === "complete")
    return {
      tone: machines.some((machine) => machine.status === "failed") ? "failed" : "default",
      label: machines.some((machine) => machine.status === "failed")
        ? "Some updates need attention"
        : "Selected updates finished",
      action: machines.some((machine) => machine.status === "failed") ? "retry" : "dismiss",
    };
  if (run.phase === "countdown" && run.restartAt !== null) {
    const seconds = Math.max(0, Math.ceil((run.restartAt - now) / 1000));
    return { tone: "default", label: `Restart in ${seconds}s`, action: "later" };
  }
  if (run.phase === "installing") {
    return { tone: "default", label: "Restarting…", action: null };
  }
  const active = machines.filter(({ status }) => isActive(status) && status !== "waiting");
  const slowest = active.toSorted((a, b) => a.machine.startedAt - b.machine.startedAt)[0];
  if (slowest && now - slowest.machine.startedAt >= UPDATE_SLOW_AFTER_MS) {
    return {
      tone: "slow",
      label: slowest.machine.label,
      slow: {
        status: RUN_STATUS_LABELS[slowest.status],
        elapsed: formatUpdateElapsed(now - slowest.machine.startedAt),
      },
      action: null,
    };
  }
  const done = machines.filter(({ status }) => status === "done").length;
  if (machines.some(({ status }) => isActive(status))) {
    return { tone: "default", label: `${done} of ${machines.length} updated`, action: null };
  }
  if (local?.status === "downloading") {
    return {
      tone: "default",
      label: `Downloading${local.percent === null ? "" : ` ${Math.floor(local.percent)}%`}`,
      action: null,
    };
  }
  const failed = machines.filter(({ status }) => status === "failed");
  if (failed.length > 0) {
    return {
      tone: "failed",
      label: failed.length === 1 ? `${failed[0]!.machine.label} failed` : `${failed.length} failed`,
      action: failed.some(({ machine }) => machine.server !== null) ? "retry" : "dismiss",
    };
  }
  return { tone: "default", label: `${done} of ${machines.length} updated`, action: null };
}

export const RUN_STATUS_LABELS: Record<UpdateRunMachineStatus, string> = {
  providers: "updating providers",
  waiting: "waiting",
  "waiting-dependency": "waiting for T3",
  downloading: "downloading",
  restarting: "restarting",
  done: "done",
  failed: "failed",
};

export interface UpdateEverythingResult {
  readonly localVersion: string | null;
  readonly updatedServers: number;
  readonly updatedProviders: number;
  readonly failures: ReadonlyArray<string>;
  readonly restarting: ReadonlyArray<string>;
}

export function getUpdateEverythingToastView(
  result: UpdateEverythingResult,
  appVersion: string,
): {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description?: string;
} | null {
  const parts = [
    result.localVersion !== null && result.localVersion === appVersion ? "this app" : null,
    countLabel(result.updatedServers, "server"),
    countLabel(result.updatedProviders, "provider"),
  ].filter((part) => part !== null);
  const restarting =
    result.restarting.length === 0
      ? []
      : [
          `${joinList(result.restarting)} ${result.restarting.length === 1 ? "is" : "are"} still restarting.`,
        ];
  if (result.failures.length === 0) {
    if (parts.length === 0) return null;
    return {
      type: "success",
      title: `Updated ${joinList(parts)}`,
      ...(restarting.length === 0 ? {} : { description: restarting.join("\n") }),
    };
  }
  return {
    type: "error",
    title: parts.length === 0 ? "Update failed" : `Updated ${joinList(parts)}`,
    description: [...result.failures, ...restarting].join("\n"),
  };
}

function countLabel(count: number, noun: string): string | null {
  return count === 0 ? null : `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function joinList(parts: ReadonlyArray<string>): string {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

export interface UpdateOptionMachine extends UpdateEverythingMachine {
  readonly connectionPhase: EnvironmentPresentation["connection"]["phase"];
  readonly enabled: boolean;
  readonly sessionReady: boolean;
  readonly sessionInitialized: boolean;
  readonly providers: readonly ServerProvider[];
  readonly canManageProviders: boolean;
}

export const updateItemKey = (
  kind: UpdatePlanItem["kind"],
  environmentId: EnvironmentId,
  driver?: string,
  instanceId?: string,
) => JSON.stringify([kind, environmentId, ...(kind === "provider" ? [driver, instanceId] : [])]);

export function collectUpdateOptions(input: {
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly machines: readonly UpdateOptionMachine[];
  readonly localVersion: string | null;
  readonly npmPublished: boolean;
  readonly autoResume?: boolean | undefined;
  readonly canDisableLocalAutoResume?: boolean;
}) {
  const { machines, primaryEnvironmentId, localVersion, npmPublished } = input;
  const autoResume = input.autoResume !== false;
  const targetVersion = localVersion ?? APP_VERSION;
  const serverTargets = collectServerUpdateTargets(machines, targetVersion);
  const targets = new Map(serverTargets.targets.map((target) => [target.environmentId, target]));
  const skips = new Map(serverTargets.skipped.map((skip) => [skip.environmentId, skip.reason]));
  const devices: UpdatePickerDevice[] = [];
  const operations = new Map<string, UpdatePlanItem>();
  const hosted = machines.filter((machine) => machine.hostedByThisApp);
  const currentItems: UpdatePickerItem[] = [];
  const add = (items: UpdatePickerItem[], item: UpdatePickerItem, operation: UpdatePlanItem) => {
    items.push(item);
    if (item.disabledReason === null) operations.set(item.key, operation);
  };
  const operation = (
    key: string,
    kind: UpdatePlanItem["kind"],
    machine: UpdateOptionMachine,
    version: string,
  ): UpdatePlanItem => ({
    key,
    kind,
    environmentId: machine.environmentId,
    label: machine.label,
    fromVersion: machine.serverConfig?.environment.serverVersion ?? null,
    targetVersion: version,
    driver: null,
    instanceId: null,
    continueThreads: false,
    autoResume,
    status: "pending",
    claimId: null,
    message: null,
  });
  const primary = hosted.find((machine) => machine.environmentId === primaryEnvironmentId);
  if (localVersion && primary) {
    const key = updateItemKey("app", primary.environmentId);
    const canDisableAutoResume =
      input.canDisableLocalAutoResume === true &&
      hosted.every(
        (machine) =>
          machine.serverConfig?.environment.capabilities.threadRestartContinuationControl === true,
      );
    add(
      currentItems,
      {
        key,
        kind: "app",
        label: "T3 Code",
        context: null,
        fromVersion: APP_VERSION,
        toVersion: localVersion,
        note: "Updates and restarts this device first",
        disabledReason:
          primary.enabled &&
          primary.connected &&
          primary.sessionReady &&
          primary.serverConfig?.environment.environmentId === primary.environmentId
            ? !autoResume && !canDisableAutoResume
              ? "This app cannot disable thread resume for an update"
              : null
            : "Local connection is not ready",
        restarts: collectRestartingMachines(machines, [], true),
        canDisableAutoResume,
      },
      { ...operation(key, "app", primary, localVersion), fromVersion: APP_VERSION },
    );
  }
  for (const machine of machines) {
    const items = machine.hostedByThisApp ? currentItems : [];
    const unavailableReason =
      machine.serverConfig !== null &&
      machine.serverConfig.environment.environmentId !== machine.environmentId
        ? "Environment identity changed"
        : !machine.enabled
          ? "Connection disabled"
          : !machine.connected
            ? "Not connected"
            : null;
    const target = targets.get(machine.environmentId);
    const skip = skips.get(machine.environmentId);
    if (!machine.hostedByThisApp && (target || skip)) {
      const key = updateItemKey("server", machine.environmentId);
      const disabledReason =
        unavailableReason ??
        skip ??
        (!autoResume &&
        machine.serverConfig?.environment.capabilities.threadRestartContinuationControl !== true
          ? "This version cannot disable thread resume for an update"
          : null) ??
        (target?.selfUpdate !== "desktop-managed" && !npmPublished ? "Not on npm yet" : null);
      add(
        items,
        {
          key,
          kind: "server",
          label: "T3 Code",
          context: null,
          fromVersion: machine.serverConfig?.environment.serverVersion ?? null,
          toVersion: target?.selfUpdate === "desktop-managed" ? null : targetVersion,
          note: target?.selfUpdate === "desktop-managed" ? "Uses that device's update feed" : null,
          canDisableAutoResume:
            machine.serverConfig?.environment.capabilities.threadRestartContinuationControl ===
            true,
          disabledReason,
          restarts: collectRestartingMachines(
            machines,
            [{ environmentId: machine.environmentId }],
            false,
          ),
        },
        {
          ...operation(key, "server", machine, targetVersion),
          ...(target?.selfUpdate ? { selfUpdate: target.selfUpdate } : {}),
          continueThreads:
            target?.threadContinuation === true && target.continueThreadsAfterServerUpdate === true,
        },
      );
    }
    for (const candidate of collectProviderUpdateCandidates(machine.providers)) {
      const key = updateItemKey(
        "provider",
        machine.environmentId,
        candidate.driver,
        candidate.instanceId,
      );
      const disabledReason =
        unavailableReason ??
        (!machine.canManageProviders
          ? "No permission"
          : !canOneClickUpdateProviderCandidate(candidate, machine.providers)
            ? "Needs a manual update or is already updating"
            : null);
      add(
        items,
        {
          key,
          kind: "provider",
          label: PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
          context: machine.hostedByThisApp && hosted.length > 1 ? machine.label : null,
          fromVersion: candidate.version,
          toVersion: null,
          note: "Installer chooses the latest version",
          disabledReason,
          restarts: [],
        },
        {
          ...operation(key, "provider", machine, "latest"),
          fromVersion: candidate.version,
          driver: candidate.driver,
          instanceId: candidate.instanceId,
        },
      );
    }
    if (!machine.hostedByThisApp && (items.length > 0 || unavailableReason))
      devices.push({
        id: machine.environmentId,
        label: machine.label,
        unavailableReason,
        items,
      });
  }
  if (currentItems.length > 0 && primaryEnvironmentId)
    devices.unshift({
      id: updateItemKey("app", primaryEnvironmentId),
      label: "This device",
      unavailableReason: null,
      items: currentItems,
    });
  return { devices, operations };
}
