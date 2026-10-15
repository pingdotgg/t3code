import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";

import {
  resolveServerSelfUpdateCapability,
  resolveVersionMismatch,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "~/versionSkew";
import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";

export interface UpdateEverythingMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: {
    readonly environment: ServerConfig["environment"];
    readonly settings: Pick<ServerConfig["settings"], "continueThreadsAfterServerUpdate">;
  } | null;
  readonly connected: boolean;
  /** Served by the desktop app this client runs in (the primary backend or a
      local WSL backend). Its server updates when the app installs. */
  readonly hostedByThisApp: boolean;
  /** The session holds the scope a server update needs. */
  readonly canMaintain: boolean;
  readonly updateState: ServerUpdateState;
}

/** A server that restarts during a run. */
export interface RestartingMachine {
  readonly environmentId: EnvironmentId;
  /** The server resumes interrupted threads after it restarts. */
  readonly continuesThreads: boolean;
}

/**
 * The servers a run restarts: each server it updates, and the servers this app
 * hosts when this app installs. Provider updates restart nothing.
 */
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

/** A machine the run leaves alone, with a short reason such as "not connected". */
export interface SkippedMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly reason: string;
}

/**
 * The servers that "update everything" moves to `targetVersion`: connected,
 * permitted, able to update over RPC, behind the target, and on its release
 * channel. Every other behind server comes back in `skipped` with a reason for
 * the confirmation; a machine that never connected has an unknown version, so
 * it counts as skipped. Two kinds are in neither list: servers already on the
 * target, and servers this app hosts, which would relaunch the app mid-run
 * and update with the app's own install anyway. A desktop-managed server
 * follows its own app's update feed, so the channel rule does not apply to it.
 */
export function collectServerUpdateTargets(
  machines: ReadonlyArray<UpdateEverythingMachine>,
  targetVersion: string,
): { readonly targets: ServerUpdateTarget[]; readonly skipped: SkippedMachine[] } {
  const targets: ServerUpdateTarget[] = [];
  const skipped: SkippedMachine[] = [];
  for (const machine of machines) {
    const config = machine.serverConfig;
    if (machine.hostedByThisApp) continue;
    if (
      config !== null &&
      resolveVersionMismatch(config.environment.serverVersion, targetVersion) === null
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

export interface UpdateEverythingSteps<Providers, Servers> {
  /** Downloads this app's update. Resolves true when it is ready to install.
      Without it, `localReady` is true: there is nothing to download. */
  readonly downloadLocal?: () => Promise<boolean>;
  readonly updateProviders: () => Promise<Providers>;
  readonly updateServers: () => Promise<Servers>;
}

/**
 * Runs the remote half of one "update everything" pass and returns each
 * step's results. Providers finish before any server restarts, so no install
 * is cut off. The local download runs alongside the remote work. The caller
 * installs this app afterwards when `localReady`, because the relaunch ends
 * the run; a failed download skips only that install.
 */
export async function runUpdateEverything<Providers, Servers>(
  steps: UpdateEverythingSteps<Providers, Servers>,
): Promise<{
  readonly localReady: boolean;
  readonly providers: Providers;
  readonly servers: Servers;
}> {
  const [localReady, remote] = await Promise.all([
    steps.downloadLocal?.() ?? Promise.resolve(true),
    steps
      .updateProviders()
      .then(async (providers) => ({ providers, servers: await steps.updateServers() })),
  ]);
  return { localReady, ...remote };
}

/** The current state of one machine in a running pass. */
export type UpdateRunMachineStatus =
  | "providers"
  | "waiting"
  | "downloading"
  | "restarting"
  | "done"
  | "failed";

/** One machine in a running "update everything" pass. */
export interface UpdateRunMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly updatesProviders: boolean;
  /** The server update this machine runs, kept so a failure can be retried.
      Null for a provider-only machine, or a server this app handed off before
      it relaunched. */
  readonly server: ServerUpdateTarget | null;
  /** The version a handed-off server comes back on. This app relaunched while
      that server restarted, so its version is the only signal left. */
  readonly handedOffVersion: string | null;
  /** When its current update started, for the elapsed time. */
  readonly startedAt: number;
  /** Set when every update for this machine has finished. */
  readonly result: "done" | "failed" | null;
  /** Why it failed, when `result` is "failed". */
  readonly failure: string | null;
  /** This machine's provider failure, kept apart so a server retry does not clear it. */
  readonly providerFailure: string | null;
}

/**
 * A running "update everything" pass, kept until every machine finished. A
 * failed machine keeps it open, so the sidebar can offer a retry.
 */
export interface UpdateEverythingRun {
  /** The version this app installs, or null when it does not install (or the
      user chose to restart later). */
  readonly localVersion: string | null;
  /** Providers update first, then servers. "countdown" waits `restartAt` to
      relaunch this app, which can still be postponed. */
  readonly phase: "providers" | "servers" | "countdown" | "installing";
  readonly restartAt: number | null;
  readonly machines: ReadonlyArray<UpdateRunMachine>;
}

/** Status of one machine, from the run and that server's own update state. */
export function resolveUpdateRunMachineStatus(
  machine: UpdateRunMachine,
  phase: UpdateEverythingRun["phase"],
  serverState: ServerUpdateState,
): UpdateRunMachineStatus {
  if (machine.result !== null) return machine.result;
  if (machine.handedOffVersion !== null) return "restarting";
  if (phase === "providers" && machine.updatesProviders) return "providers";
  if (machine.server !== null && serverState.status === "running") {
    return serverState.stage === "resuming" ? "restarting" : "downloading";
  }
  return "waiting";
}

/** A server is handed off once it restarts into its update: it finishes
    without this app, so this app can relaunch. */
export function isServerUpdateHandedOff(state: ServerUpdateState): boolean {
  return state.status === "running" && state.stage === "resuming";
}

/** Ends the run once nothing is left to show: every machine done and this
    app not installing. Failures keep it open. */
export function closeFinishedUpdateRun(run: UpdateEverythingRun): UpdateEverythingRun | null {
  return run.phase === "servers" &&
    run.localVersion === null &&
    run.machines.every((machine) => machine.result === "done")
    ? null
    : run;
}

/** An update this long is slower than usual, so the sidebar points it out. */
export const UPDATE_SLOW_AFTER_MS = 3 * 60 * 1000;

/** Elapsed time in whole minutes, such as "6m" or "1h 4m". */
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

/** This app's own part of a run, for the sidebar. */
export type UpdateRunLocalState =
  | { readonly status: "downloading"; readonly percent: number | null }
  | { readonly status: "waiting" }
  | null;

/** What the expanded sidebar update button says, and its inline action. */
export interface UpdateCapsuleView {
  readonly tone: "default" | "slow" | "failed";
  readonly label: string;
  /** For a slow machine, its status and elapsed time, such as "restarting" and "6m". */
  readonly slow?: { readonly status: string; readonly elapsed: string };
  readonly action: "later" | "retry" | "dismiss" | null;
}

const isActive = (status: UpdateRunMachineStatus) => status !== "done" && status !== "failed";

/**
 * The one line the expanded update button shows for a run, most urgent
 * first: this app's restart countdown, a slow machine, overall progress, and
 * last any failure once nothing else is running.
 */
export function describeUpdateCapsule(
  run: UpdateEverythingRun,
  machines: ReadonlyArray<UpdateRunMachineView>,
  local: UpdateRunLocalState,
  now: number,
): UpdateCapsuleView {
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
  downloading: "downloading",
  restarting: "restarting",
  done: "done",
  failed: "failed",
};

/** What one pass did. It is saved before this app installs, so it outlives the relaunch. */
export interface UpdateEverythingResult {
  /** The version this app installed last, or null when it did not install. */
  readonly localVersion: string | null;
  readonly updatedServers: number;
  readonly updatedProviders: number;
  /** One line per failure, each naming its machine. */
  readonly failures: ReadonlyArray<string>;
  /** Servers still restarting into their update when this app relaunched. */
  readonly restarting: ReadonlyArray<string>;
}

/** Counts what a pass updated and lists each failure with its machine. */
export function collectUpdateEverythingResult(input: {
  readonly localVersion: string | null;
  /** This app's own download or install failures. */
  readonly localFailures: ReadonlyArray<string>;
  readonly servers: ReadonlyArray<{
    readonly label: string;
    readonly outcome: ServerUpdateOutcome;
  }>;
  readonly providers: ReadonlyArray<
    | { readonly status: "interrupted" | "updated" }
    | { readonly status: "failed"; readonly line: string }
  >;
}): UpdateEverythingResult {
  return {
    localVersion: input.localVersion,
    updatedServers: input.servers.filter(({ outcome }) => outcome.status === "updated").length,
    updatedProviders: input.providers.filter((outcome) => outcome.status === "updated").length,
    restarting: [],
    failures: [
      ...input.localFailures.map((failure) => `This app: ${failure}`),
      ...input.servers.flatMap(({ label, outcome }) =>
        outcome.status === "failed" ? [`${label}: ${outcome.message}`] : [],
      ),
      ...input.providers.flatMap((outcome) => (outcome.status === "failed" ? [outcome.line] : [])),
    ],
  };
}

/**
 * The one toast for a finished pass, such as "Updated this app, 8 servers,
 * and 3 providers" with a line per failure. `appVersion` is the version this
 * app runs now: after the relaunch it tells whether the local install
 * applied. Null when nothing finished, for example every request was
 * interrupted.
 */
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

export interface UpdateEverythingPlan {
  /** The version this desktop app installs, or null when it is not updating. */
  readonly localVersion: string | null;
  readonly servers: ReadonlyArray<
    Pick<ServerUpdateTarget, "environmentId" | "serverLabel" | "selfUpdate" | "targetVersion">
  >;
  readonly providerMachines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    /** Display names of the outdated providers on that machine. */
    readonly providers: ReadonlyArray<string>;
  }>;
}

function countLabel(count: number, noun: string): string | null {
  return count === 0 ? null : `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function joinList(parts: ReadonlyArray<string>): string {
  if (parts.length <= 2) return parts.join(" and ");
  return `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;
}

/**
 * Text for the sidebar tooltip and the confirmation. `summary` reads like
 * "Update this app, 2 servers, and 3 providers". `lines` has one entry per
 * machine, this app first, such as "alvin: server to 0.0.50, Codex, Claude".
 */
export function describeUpdateEverything(plan: UpdateEverythingPlan): {
  readonly summary: string;
  readonly lines: ReadonlyArray<string>;
} {
  const providerCount = plan.providerMachines.reduce(
    (count, machine) => count + machine.providers.length,
    0,
  );
  const summary = `Update ${joinList(
    [
      plan.localVersion ? "this app" : null,
      countLabel(plan.servers.length, "server"),
      countLabel(providerCount, "provider"),
    ].filter((part) => part !== null),
  )}`;

  const machines = new Map<EnvironmentId, { label: string; items: string[] }>();
  const itemsFor = (environmentId: EnvironmentId, label: string) => {
    const existing = machines.get(environmentId);
    if (existing) return existing.items;
    const items: string[] = [];
    machines.set(environmentId, { label, items });
    return items;
  };
  for (const server of plan.servers) {
    // A desktop-managed server installs whatever its own app's update feed
    // offers, so it has no target version to show.
    itemsFor(server.environmentId, server.serverLabel).push(
      server.selfUpdate === "desktop-managed"
        ? "desktop app update"
        : `server to ${server.targetVersion}`,
    );
  }
  for (const machine of plan.providerMachines) {
    itemsFor(machine.environmentId, machine.label).push(...machine.providers);
  }

  return {
    summary,
    lines: [
      ...(plan.localVersion ? [`This app: ${plan.localVersion}, restarts last`] : []),
      ...Array.from(machines.values(), ({ label, items }) => `${label}: ${items.join(", ")}`),
    ],
  };
}
