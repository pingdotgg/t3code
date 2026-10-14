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
  readonly updatesServer: boolean;
  /** Set when every update for this machine has finished. */
  readonly result: "done" | "failed" | null;
}

/** A running "update everything" pass, kept while it runs. */
export interface UpdateEverythingRun {
  /** The version this app installs last, or null when it does not install. */
  readonly localVersion: string | null;
  /** Providers update first. Servers update after every provider finished. */
  readonly phase: "providers" | "servers" | "installing";
  readonly machines: ReadonlyArray<UpdateRunMachine>;
}

/** Status of one machine, from the run and that server's own update state. */
export function resolveUpdateRunMachineStatus(
  machine: UpdateRunMachine,
  phase: UpdateEverythingRun["phase"],
  serverState: ServerUpdateState,
): UpdateRunMachineStatus {
  if (machine.result !== null) return machine.result;
  if (phase === "providers" && machine.updatesProviders) return "providers";
  if (machine.updatesServer && serverState.status === "running") {
    return serverState.stage === "resuming" ? "restarting" : "downloading";
  }
  return "waiting";
}

const RUN_STATUS_LABELS: Record<UpdateRunMachineStatus, string> = {
  providers: "updating providers",
  waiting: "waiting",
  downloading: "downloading",
  restarting: "restarting",
  done: "done",
  failed: "failed",
};

/**
 * Tooltip lines for a running pass, such as "alvin: restarting". `local` is
 * this app's own state, such as "downloading 40%", or null when it does not
 * install.
 */
export function describeUpdateRun(
  machines: ReadonlyArray<{ readonly label: string; readonly status: UpdateRunMachineStatus }>,
  local: string | null,
): ReadonlyArray<string> {
  return [
    "Updating…",
    ...(local === null ? [] : [`This app: ${local}`]),
    ...machines.map((machine) => `${machine.label}: ${RUN_STATUS_LABELS[machine.status]}`),
  ];
}

/** What one pass did. It is saved before this app installs, so it outlives the relaunch. */
export interface UpdateEverythingResult {
  /** The version this app installed last, or null when it did not install. */
  readonly localVersion: string | null;
  readonly updatedServers: number;
  readonly updatedProviders: number;
  /** One line per failure, each naming its machine. */
  readonly failures: ReadonlyArray<string>;
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
  if (result.failures.length === 0) {
    return parts.length === 0 ? null : { type: "success", title: `Updated ${joinList(parts)}` };
  }
  return {
    type: "error",
    title: parts.length === 0 ? "Update failed" : `Updated ${joinList(parts)}`,
    description: result.failures.join("\n"),
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
