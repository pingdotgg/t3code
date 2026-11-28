import {
  managedNightlyDeniedMessage,
  managedUpdatesDenial,
} from "@t3tools/client-runtime/contract-labels";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import {
  type DesktopUpdateChannel,
  type EnvironmentId,
  type ServerConfig,
  type ServerSelfUpdateCapability,
} from "@t3tools/contracts";
import { cliReleaseChannelOf, desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";
import {
  resolveServerSelfUpdateCapability,
  resolveVersionMismatch,
  supportsDesktopAppUpdate,
} from "~/versionSkew";
import type { ServerUpdateOutcome, ServerUpdateTarget } from "../ServerUpdateAction";

export interface UpdateEverythingMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: {
    readonly environment: ServerConfig["environment"];
    readonly settings: Pick<ServerConfig["settings"], "continueThreadsAfterServerUpdate">;
    readonly managedPolicy?: ServerConfig["managedPolicy"];
  } | null;
  readonly connected: boolean;
  /** Why the connection is down, when it says, in the active language. */
  readonly connectionError?: string | null;
  /** The saved connection is switched off in Settings, so it never connects. */
  readonly turnedOff?: boolean;
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
        continuesThreads: config.settings.continueThreadsAfterServerUpdate === true,
      },
    ];
  });
}

export interface SkippedMachine {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly reason: string;
}

// Desktop servers without the desktop control fd (older apps, WSL backends: wsl.exe cannot pass
// fds) cannot be updated from here, and their desktop app is not necessarily the stale part.
const UPDATE_ON_THAT_MACHINE = msg("update Hyakki on that machine");

/** Skip current and app-hosted servers; the latter update with the app and would relaunch mid-run.
 * Desktop-managed servers use their own feed. Each server's updater checks that it can install the
 * release before it restarts, so no registry precheck runs here. */
export function collectServerUpdateTargets(
  machines: ReadonlyArray<UpdateEverythingMachine>,
  targetVersion: string,
  resolve: MessageResolver = m,
): {
  readonly targets: ServerUpdateTarget[];
  readonly skipped: SkippedMachine[];
} {
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
    const unavailable = unavailableReason(machine, resolve);
    if (config === null || unavailable !== null) {
      skip(unavailable ?? resolve(msg("not connected")));
      continue;
    }
    const selfUpdate = resolveServerSelfUpdateCapability(config);
    const managedDenial = managedMachineUpdateDenial(
      config,
      selfUpdate === "desktop-managed" ? undefined : targetVersion,
      resolve,
    );
    if (managedDenial !== undefined) {
      skip(managedDenial);
      continue;
    }
    const desktopAppUpdate = supportsDesktopAppUpdate(config);
    if (selfUpdate === null) {
      skip(resolve(msg("needs a manual update")));
      continue;
    }
    if (selfUpdate === "desktop-managed" && !desktopAppUpdate) {
      skip(resolve(UPDATE_ON_THAT_MACHINE));
      continue;
    }
    const serverChannel = cliReleaseChannelOf(config.environment.serverVersion);
    // A desktop app installs its own track's newest release. Nightly builds run ahead of Stable, so a
    // Nightly host behind a Stable target has something newer; a Stable host may not.
    if (
      serverChannel !== cliReleaseChannelOf(targetVersion) &&
      (selfUpdate !== "desktop-managed" || serverChannel === "stable")
    ) {
      skip(resolve(msg("on the {channel} channel", { channel: serverChannel })));
      continue;
    }
    const target: ServerUpdateTarget = {
      environmentId: machine.environmentId,
      serverLabel: machine.label,
      selfUpdate,
      installation: config.environment.capabilities.serverInstallation,
      desktopAppUpdate,
      targetVersion,
    };
    targets.push(target);
  }
  return { targets, skipped };
}

function unavailableReason(
  machine: UpdateEverythingMachine,
  resolve: MessageResolver,
): string | null {
  if (machine.turnedOff === true) {
    return resolve(
      msg("turned off", {
        $context: "why a server update was skipped: its saved connection is off",
      }),
    );
  }
  if (!machine.connected) return machine.connectionError ?? resolve(msg("not connected"));
  if (machine.serverConfig === null)
    return resolve(
      msg("still loading", {
        $context: "why a server update was skipped: its settings have not arrived yet",
      }),
    );
  if (!machine.canMaintain) return resolve(msg("no permission"));
  if (machine.updateState.status === "running") return resolve(msg("already updating"));
  return null;
}

/** The latest release on the track a fleet switches to, as npm reports it. */
export interface ChannelSwitchRelease {
  readonly channel: DesktopUpdateChannel;
  readonly version: string;
  readonly databaseMigration: number | undefined;
}

/** Components pass `useMessages()` so labels follow a language switch. */
export const channelSwitchLabel = (channel: DesktopUpdateChannel, resolve: MessageResolver = m) =>
  channel === "nightly"
    ? resolve(msg("Nightly", { $context: "release track" }))
    : resolve(msg("Stable", { $context: "release track" }));

/** Stable and Nightly each build their own commits, so either can hold migrations the other lacks.
 * Crossing tracks needs proof that the target release knows every migration the database holds. */
const crossesTrack = (fromVersion: string, release: ChannelSwitchRelease) =>
  desktopUpdateChannelOf(fromVersion) !== release.channel;

type ChannelSwitchBlock = "server-predates-checks" | "release-predates-checks" | "unsupported";

function channelSwitchBlock(
  fromVersion: string,
  release: ChannelSwitchRelease,
  currentMigration: number | undefined,
): ChannelSwitchBlock | null {
  if (!crossesTrack(fromVersion, release)) return null;
  // Servers and releases from before this check report no migration number.
  if (currentMigration === undefined) return "server-predates-checks";
  if (release.databaseMigration === undefined) return "release-predates-checks";
  return currentMigration > release.databaseMigration ? "unsupported" : null;
}

function channelSwitchBlockReason(
  fromVersion: string,
  release: ChannelSwitchRelease,
  currentMigration: number | undefined,
  resolve: MessageResolver,
): string | null {
  const block = channelSwitchBlock(fromVersion, release, currentMigration);
  if (block === null) return null;
  const from = channelSwitchLabel(desktopUpdateChannelOf(fromVersion), resolve);
  const to = channelSwitchLabel(release.channel, resolve);
  const version = release.version;
  switch (block) {
    case "server-predates-checks":
      return resolve(
        msg("its server predates database checks; update it on {from} first", { from }),
      );
    case "release-predates-checks":
      return resolve(
        msg("{version} predates database checks; wait for a newer {to} release", { version, to }),
      );
    case "unsupported":
      return resolve(
        msg(
          "its database has changes {version} does not support yet; stay on {from} until {to} has them",
          { version, from, to },
        ),
      );
  }
}

function localChannelSwitchBlockReason(
  fromVersion: string,
  release: ChannelSwitchRelease,
  block: ChannelSwitchBlock,
  resolve: MessageResolver,
): string {
  const from = channelSwitchLabel(desktopUpdateChannelOf(fromVersion), resolve);
  const to = channelSwitchLabel(release.channel, resolve);
  const version = release.version;
  switch (block) {
    case "server-predates-checks":
      return resolve(
        msg(
          "This app cannot switch: its server predates database checks; update it on {from} first.",
          { from },
        ),
      );
    case "release-predates-checks":
      return resolve(
        msg(
          "This app cannot switch: {version} predates database checks; wait for a newer {to} release.",
          { version, to },
        ),
      );
    case "unsupported":
      return resolve(
        msg(
          "This app cannot switch: its database has changes {version} does not support yet; stay on {from} until {to} has them.",
          { version, from, to },
        ),
      );
  }
}

/** This app's reinstall restarts every server it hosts, so each of their databases must allow the
 * switch. `backendCount` is the desktop's own inventory: a backend still starting has no client
 * entry yet. A cached config can outlive its connection, so only a connected server's head counts.
 * With Local environment off this app runs no server, so its reinstall restarts none. */
export function localSwitchBlockReason(
  appVersion: string,
  release: ChannelSwitchRelease,
  hosted: ReadonlyArray<{
    readonly connected: boolean;
    readonly databaseMigration: number | undefined;
  }>,
  backendCount: number,
  localEnvironmentEnabled: boolean,
  resolve: MessageResolver = m,
): string | null {
  if (!localEnvironmentEnabled || !crossesTrack(appVersion, release)) return null;
  if (
    hosted.length === 0 ||
    hosted.length < backendCount ||
    hosted.some((server) => !server.connected)
  ) {
    return resolve(
      msg(
        "This app cannot switch: its server is not connected, so its database cannot be checked.",
      ),
    );
  }
  const block = hosted
    .map((server) => channelSwitchBlock(appVersion, release, server.databaseMigration))
    .find((reason): reason is ChannelSwitchBlock => reason !== null);
  return block === undefined
    ? null
    : localChannelSwitchBlockReason(appVersion, release, block, resolve);
}

/**
 * The server refuses these with the same message; say so before the run instead of after.
 * `targetVersion` is undefined when the server picks its own version, as desktop apps do.
 */
function managedMachineUpdateDenial(
  config: NonNullable<UpdateEverythingMachine["serverConfig"]>,
  targetVersion: string | undefined,
  resolve: MessageResolver,
): string | undefined {
  const policy = config.managedPolicy;
  return (
    managedUpdatesDenial(policy, resolve) ??
    (policy !== undefined &&
    policy.limits?.updates?.allowNightly === false &&
    targetVersion !== undefined &&
    cliReleaseChannelOf(targetVersion) !== "stable"
      ? managedNightlyDeniedMessage(policy.organization, resolve)
      : undefined)
  );
}

/** Servers move to the release; desktop-managed hosts reinstall their app on its track. A desktop
 * host already current gets a track-only request, since its saved track may still differ. */
export function collectChannelSwitchTargets(
  machines: ReadonlyArray<UpdateEverythingMachine>,
  release: ChannelSwitchRelease,
  resolve: MessageResolver = m,
): { readonly targets: ServerUpdateTarget[]; readonly skipped: SkippedMachine[] } {
  const targets: ServerUpdateTarget[] = [];
  const skipped: SkippedMachine[] = [];
  for (const machine of machines) {
    const config = machine.serverConfig;
    if (machine.hostedByThisApp) continue;
    const skip = (reason: string) =>
      skipped.push({ environmentId: machine.environmentId, label: machine.label, reason });
    const target = (
      selfUpdate: ServerSelfUpdateCapability,
      targetVersion: string,
    ): ServerUpdateTarget => ({
      environmentId: machine.environmentId,
      serverLabel: machine.label,
      selfUpdate,
      installation: config?.environment.capabilities.serverInstallation,
      desktopAppUpdate: config !== null && supportsDesktopAppUpdate(config),
      targetVersion,
      ...(selfUpdate === "desktop-managed" ? { channel: release.channel } : {}),
      ...(release.databaseMigration === undefined
        ? {}
        : { targetDatabaseMigration: release.databaseMigration }),
    });
    const serverVersion = config?.environment.serverVersion;
    const sameTrack = serverVersion !== undefined && isOnTrack(serverVersion, release.channel);
    if (
      config !== null &&
      sameTrack &&
      resolveVersionMismatch(serverVersion, release.version) === null
    ) {
      const move = trackSwitchMove(config, true, resolve);
      if (
        !("skip" in move) &&
        move.selfUpdate === "desktop-managed" &&
        unavailableReason(machine, resolve) === null &&
        managedMachineUpdateDenial(config, release.version, resolve) === undefined
      ) {
        targets.push({ ...target(move.selfUpdate, serverVersion), trackOnly: true });
      }
      continue;
    }
    const unavailable = unavailableReason(machine, resolve);
    if (config === null || serverVersion === undefined || unavailable !== null) {
      skip(unavailable ?? resolve(msg("not connected")));
      continue;
    }
    const managedDenial = managedMachineUpdateDenial(config, release.version, resolve);
    if (managedDenial !== undefined) {
      skip(managedDenial);
      continue;
    }
    const move = trackSwitchMove(config, sameTrack, resolve);
    if ("skip" in move) {
      skip(move.skip);
      continue;
    }
    const blocked = channelSwitchBlockReason(
      serverVersion,
      release,
      config.environment.databaseMigration,
      resolve,
    );
    if (blocked !== null) {
      skip(blocked);
      continue;
    }
    // Service launchers only accept newer versions, so leaving for an older release is manual.
    if (
      move.selfUpdate === "boot-service" &&
      compareSemverVersions(release.version, serverVersion) <= 0
    ) {
      skip(
        resolve(
          msg("run `{command}` there", {
            command: `hyakki update --channel ${release.channel === "nightly" ? "nightly" : "stable"} --allow-downgrade`,
          }),
        ),
      );
      continue;
    }
    targets.push(target(move.selfUpdate, release.version));
  }
  return { targets, skipped };
}

/** A remote host on the other track that a switch can still move, for retrying a partial switch. */
export function awaitsTrackSwitch(
  machine: Pick<UpdateEverythingMachine, "serverConfig" | "hostedByThisApp">,
  channel: DesktopUpdateChannel,
): boolean {
  const config = machine.serverConfig;
  return (
    !machine.hostedByThisApp &&
    config !== null &&
    !isOnTrack(config.environment.serverVersion, channel) &&
    !("skip" in trackSwitchMove(config, false, m))
  );
}

function isOnTrack(version: string, channel: DesktopUpdateChannel): boolean {
  return cliReleaseChannelOf(version) !== "preview" && desktopUpdateChannelOf(version) === channel;
}

/** How a switch moves a host, or why it never can from here, whatever the release. */
function trackSwitchMove(
  config: NonNullable<UpdateEverythingMachine["serverConfig"]>,
  sameTrack: boolean,
  resolve: MessageResolver,
): { readonly selfUpdate: ServerSelfUpdateCapability } | { readonly skip: string } {
  if (cliReleaseChannelOf(config.environment.serverVersion) === "preview") {
    return { skip: resolve(msg("runs a preview build")) };
  }
  const selfUpdate = resolveServerSelfUpdateCapability(config);
  if (selfUpdate === null) return { skip: resolve(msg("needs a manual update")) };
  if (selfUpdate !== "desktop-managed") return { selfUpdate };
  if (config.environment.capabilities.desktopAppChannelSwitch !== true) {
    return {
      skip: resolve(
        sameTrack ? UPDATE_ON_THAT_MACHINE : msg("change the update track on that machine"),
      ),
    };
  }
  // Squirrel.Mac renames the bundle for the new track and then cannot relaunch it.
  if (!sameTrack && config.environment.platform.os === "darwin") {
    return { skip: resolve(msg("switch the Mac app on that Mac")) };
  }
  return { selfUpdate };
}

export interface UpdateEverythingSteps<Providers, Servers> {
  readonly downloadLocal?: () => Promise<boolean>;
  readonly updateProviders: () => Promise<Providers>;
  readonly stageServers?: () => ReadonlyMap<EnvironmentId, Promise<unknown>>;
  readonly updateServers: (
    staged: ReadonlyMap<EnvironmentId, Promise<unknown>>,
  ) => Promise<Servers>;
}

/** Finish provider installs before server restarts; servers stage meanwhile and each server's
 * update waits only on its own stage. Install this app last when localReady; failed downloads skip
 * only that install. */
export async function runUpdateEverything<Providers, Servers>(
  steps: UpdateEverythingSteps<Providers, Servers>,
): Promise<{
  readonly localReady: boolean;
  readonly providers: Providers;
  readonly servers: Servers;
}> {
  const staged = new Map(
    Array.from(steps.stageServers?.() ?? [], ([id, stage]) => [id, stage.catch(() => undefined)]),
  );
  const [localReady, remote] = await Promise.all([
    steps.downloadLocal?.() ?? Promise.resolve(true),
    steps
      .updateProviders()
      .then(async (providers) => ({ providers, servers: await steps.updateServers(staged) })),
  ]);
  return { localReady, ...remote };
}

export type UpdateRunMachineStatus =
  | "providers"
  | "waiting"
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
  readonly providerFailure: string | null;
}

export interface UpdateEverythingRun {
  /** Track switches retry through their planner, which re-checks each database. */
  readonly trackSwitch?: boolean;
  readonly localVersion: string | null;
  readonly phase: "providers" | "servers" | "countdown" | "installing";
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
  if (phase === "providers" && machine.updatesProviders) return "providers";
  if (machine.server !== null && serverState.status === "running") {
    return serverState.stage === "resuming" ? "restarting" : "downloading";
  }
  return "waiting";
}

/** "current": the server already runs the target, so retrying it only settles the row. */
export type RestoredRetry = ServerUpdateTarget | "current";

/** A row restored after this app relaunched keeps only its target version, so its retry is
 * rebuilt from the server as it is now, as the dialog would. Null when there is nothing to retry. */
export function resolveRestoredRetry(
  machine: UpdateRunMachine,
  machines: ReadonlyArray<UpdateEverythingMachine>,
): RestoredRetry | null {
  const targetVersion = machine.handedOffVersion;
  if (machine.result !== "failed" || machine.server !== null || targetVersion === null) return null;
  const current = machines.find(({ environmentId }) => environmentId === machine.environmentId);
  if (current === undefined) return null;
  const config = current.serverConfig;
  if (
    current.connected &&
    config !== null &&
    resolveVersionMismatch(config.environment.serverVersion, targetVersion) === null
  ) {
    return "current";
  }
  return collectServerUpdateTargets([current], targetVersion).targets[0] ?? null;
}

export function isServerUpdateHandedOff(state: ServerUpdateState): boolean {
  return state.status === "running" && state.stage === "resuming";
}

export function closeFinishedUpdateRun(run: UpdateEverythingRun): UpdateEverythingRun | null {
  return run.phase === "servers" &&
    run.localVersion === null &&
    run.machines.every((machine) => machine.result === "done")
    ? null
    : run;
}

const UPDATE_SLOW_AFTER_MS = 3 * 60 * 1000;

export function formatUpdateElapsed(ms: number, resolve: MessageResolver = m): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return resolve(msg("<1m"));
  if (minutes < 60) return resolve(msg("{minutes}m", { minutes }));
  return resolve(
    msg("{hours}h {minutes}m", { hours: Math.floor(minutes / 60), minutes: minutes % 60 }),
  );
}

export interface UpdateRunMachineView {
  readonly machine: UpdateRunMachine;
  readonly status: UpdateRunMachineStatus;
  readonly restoredRetry: RestoredRetry | null;
}

export type UpdateRunLocalState =
  | { readonly status: "downloading"; readonly percent: number | null }
  | { readonly status: "waiting" }
  | null;

export interface UpdateCapsuleView {
  readonly tone: "default" | "slow" | "failed";
  readonly label: string;
  readonly slow?: { readonly status: string; readonly elapsed: string };
  readonly action: "later" | "retry" | "dismiss" | null;
}

const isActive = (status: UpdateRunMachineStatus) => status !== "done" && status !== "failed";

export function describeUpdateCapsule(
  run: UpdateEverythingRun,
  machines: ReadonlyArray<UpdateRunMachineView>,
  local: UpdateRunLocalState,
  now: number,
  resolve: MessageResolver = m,
): UpdateCapsuleView {
  if (run.phase === "countdown" && run.restartAt !== null) {
    const seconds = Math.max(0, Math.ceil((run.restartAt - now) / 1000));
    return {
      tone: "default",
      label: resolve(msg("Restart in {seconds}s", { seconds })),
      action: "later",
    };
  }
  if (run.phase === "installing") {
    return { tone: "default", label: resolve(msg("Restarting…")), action: null };
  }
  const active = machines.filter(({ status }) => isActive(status) && status !== "waiting");
  const slowest = active.toSorted((a, b) => a.machine.startedAt - b.machine.startedAt)[0];
  if (slowest && now - slowest.machine.startedAt >= UPDATE_SLOW_AFTER_MS) {
    return {
      tone: "slow",
      label: slowest.machine.label,
      slow: {
        status: resolve(RUN_STATUS_LABELS[slowest.status]),
        elapsed: formatUpdateElapsed(now - slowest.machine.startedAt, resolve),
      },
      action: null,
    };
  }
  const done = machines.filter(({ status }) => status === "done").length;
  if (machines.some(({ status }) => isActive(status))) {
    return {
      tone: "default",
      label: resolve(msg("{done} of {total} updated", { done, total: machines.length })),
      action: null,
    };
  }
  if (local?.status === "downloading") {
    return {
      tone: "default",
      label:
        local.percent === null
          ? resolve(msg("Downloading"))
          : resolve(msg("Downloading {percent}%", { percent: Math.floor(local.percent) })),
      action: null,
    };
  }
  const failed = machines.filter(({ status }) => status === "failed");
  if (failed.length > 0) {
    return {
      tone: "failed",
      label:
        failed.length === 1
          ? resolve(msg("{machine} failed", { machine: failed[0]!.machine.label }))
          : resolve(
              msg("{count, plural, one {{count} failed} other {{count} failed}}", {
                count: failed.length,
              }),
            ),
      action:
        !run.trackSwitch &&
        failed.some(
          ({ machine, restoredRetry }) => machine.server !== null || restoredRetry !== null,
        )
          ? "retry"
          : "dismiss",
    };
  }
  return {
    tone: "default",
    label: resolve(msg("{done} of {total} updated", { done, total: machines.length })),
    action: null,
  };
}

/** `msg()` strings: resolve them with `m` or `useMessages()` where they show. */
export const RUN_STATUS_LABELS: Record<UpdateRunMachineStatus, string> = {
  providers: msg("updating providers"),
  waiting: msg("waiting"),
  downloading: msg("downloading"),
  restarting: msg("restarting"),
  done: msg("done"),
  failed: msg("failed"),
};

export interface UpdateEverythingResult {
  readonly localVersion: string | null;
  readonly updatedServers: number;
  readonly updatedProviders: number;
  readonly failures: ReadonlyArray<string>;
  readonly restarting: ReadonlyArray<string>;
}

export function collectUpdateEverythingResult(input: {
  readonly localVersion: string | null;
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
      ...input.localFailures.map((failure) => m(msg("This app: {failure}", { failure }))),
      ...input.servers.flatMap(({ label, outcome }) =>
        outcome.status === "failed" ? [`${label}: ${outcome.message}`] : [],
      ),
      ...input.providers.flatMap((outcome) => (outcome.status === "failed" ? [outcome.line] : [])),
    ],
  };
}

export function getUpdateEverythingToastView(
  result: UpdateEverythingResult,
  appVersion: string,
): {
  readonly type: "success" | "error";
  readonly title: string;
  readonly description?: string;
} | null {
  const updated = updateTargetsSentence(
    "updated",
    {
      app: result.localVersion !== null && result.localVersion === appVersion,
      servers: result.updatedServers,
      providers: result.updatedProviders,
    },
    m,
  );
  const restarting =
    result.restarting.length === 0
      ? []
      : [
          m(
            msg(
              "{count, plural, one {{machines} is still restarting.} other {{machines} are still restarting.}}",
              { count: result.restarting.length, machines: joinList(result.restarting, m) },
            ),
          ),
        ];
  if (result.failures.length === 0) {
    if (updated === null) return null;
    return {
      type: "success",
      title: updated,
      ...(restarting.length === 0 ? {} : { description: restarting.join("\n") }),
    };
  }
  return {
    type: "error",
    title: updated === null ? m(msg("Update failed")) : updated,
    description: [...result.failures, ...restarting].join("\n"),
  };
}

export interface UpdateEverythingPlan {
  readonly localVersion: string | null;
  /** Machines whose servers this app hosts; this app's update restarts them. */
  readonly localMachines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly servers: ReadonlyArray<
    Pick<ServerUpdateTarget, "environmentId" | "serverLabel" | "selfUpdate" | "targetVersion">
  >;
  readonly providerMachines: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly providers: ReadonlyArray<string>;
  }>;
  readonly skipped: ReadonlyArray<SkippedMachine>;
}

export interface UpdateEverythingRow {
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
  readonly app: "this-app" | "server" | "desktop-app" | null;
  readonly skipped: string | null;
  readonly providers: ReadonlyArray<string>;
}

/** "Update this app, 2 servers, and 3 providers" as one sentence per combination; null when nothing. */
function updateTargetsSentence(
  verb: "update" | "updated",
  targets: { readonly app: boolean; readonly servers: number; readonly providers: number },
  resolve: MessageResolver,
): string | null {
  const { app, servers, providers } = targets;
  const values = { servers, providers };
  const update = verb === "update";
  if (app && servers > 0 && providers > 0) {
    return update
      ? resolve(
          msg(
            "Update this app, {servers, plural, one {{servers} server} other {{servers} servers}}, and {providers, plural, one {{providers} provider} other {{providers} providers}}",
            values,
          ),
        )
      : resolve(
          msg(
            "Updated this app, {servers, plural, one {{servers} server} other {{servers} servers}}, and {providers, plural, one {{providers} provider} other {{providers} providers}}",
            values,
          ),
        );
  }
  if (app && servers > 0) {
    return update
      ? resolve(
          msg(
            "Update this app and {servers, plural, one {{servers} server} other {{servers} servers}}",
            values,
          ),
        )
      : resolve(
          msg(
            "Updated this app and {servers, plural, one {{servers} server} other {{servers} servers}}",
            values,
          ),
        );
  }
  if (app && providers > 0) {
    return update
      ? resolve(
          msg(
            "Update this app and {providers, plural, one {{providers} provider} other {{providers} providers}}",
            values,
          ),
        )
      : resolve(
          msg(
            "Updated this app and {providers, plural, one {{providers} provider} other {{providers} providers}}",
            values,
          ),
        );
  }
  if (servers > 0 && providers > 0) {
    return update
      ? resolve(
          msg(
            "Update {servers, plural, one {{servers} server} other {{servers} servers}} and {providers, plural, one {{providers} provider} other {{providers} providers}}",
            values,
          ),
        )
      : resolve(
          msg(
            "Updated {servers, plural, one {{servers} server} other {{servers} servers}} and {providers, plural, one {{providers} provider} other {{providers} providers}}",
            values,
          ),
        );
  }
  if (app) return update ? resolve(msg("Update this app")) : resolve(msg("Updated this app"));
  if (servers > 0) {
    return update
      ? resolve(
          msg("Update {servers, plural, one {{servers} server} other {{servers} servers}}", values),
        )
      : resolve(
          msg(
            "Updated {servers, plural, one {{servers} server} other {{servers} servers}}",
            values,
          ),
        );
  }
  if (providers > 0) {
    return update
      ? resolve(
          msg(
            "Update {providers, plural, one {{providers} provider} other {{providers} providers}}",
            values,
          ),
        )
      : resolve(
          msg(
            "Updated {providers, plural, one {{providers} provider} other {{providers} providers}}",
            values,
          ),
        );
  }
  return null;
}

function joinList(parts: ReadonlyArray<string>, resolve: MessageResolver): string {
  if (parts.length <= 1) return parts.join("");
  if (parts.length === 2) {
    return resolve(msg("{first} and {second}", { first: parts[0], second: parts[1] }));
  }
  return resolve(
    msg("{items}, and {last}", { items: parts.slice(0, -1).join(", "), last: parts.at(-1) }),
  );
}

/** One row per machine: this app's machines first, then servers, provider-only, and skipped. */
export function describeUpdateEverything(
  plan: UpdateEverythingPlan,
  resolve: MessageResolver = m,
): {
  readonly summary: string;
  readonly version: string | null;
  readonly providerCount: number;
  readonly rows: ReadonlyArray<UpdateEverythingRow>;
} {
  const providerCount = plan.providerMachines.reduce(
    (count, machine) => count + machine.providers.length,
    0,
  );
  const summary =
    updateTargetsSentence(
      "update",
      {
        app: Boolean(plan.localVersion),
        servers: plan.servers.length,
        providers: providerCount,
      },
      resolve,
    ) ?? resolve(msg("Update {items}", { items: "" }));

  const rows = new Map<EnvironmentId | null, UpdateEverythingRow>();
  const update = (
    environmentId: EnvironmentId | null,
    label: string,
    change: Partial<UpdateEverythingRow>,
  ) => {
    const row = rows.get(environmentId) ?? {
      environmentId,
      label,
      app: null,
      skipped: null,
      providers: [],
    };
    rows.set(environmentId, { ...row, ...change });
  };
  if (plan.localVersion) {
    if (plan.localMachines.length === 0) {
      update(null, resolve(msg("This app")), { app: "this-app" });
    }
    for (const machine of plan.localMachines) {
      update(machine.environmentId, machine.label, { app: "this-app" });
    }
  }
  for (const server of plan.servers) {
    update(server.environmentId, server.serverLabel, {
      app: server.selfUpdate === "desktop-managed" ? "desktop-app" : "server",
    });
  }
  for (const machine of plan.providerMachines) {
    update(machine.environmentId, machine.label, { providers: machine.providers });
  }
  for (const machine of plan.skipped) {
    update(machine.environmentId, machine.label, { skipped: machine.reason });
  }

  return {
    summary,
    version:
      plan.localVersion ??
      plan.servers.find((server) => server.selfUpdate !== "desktop-managed")?.targetVersion ??
      null,
    providerCount,
    rows: Array.from(rows.values()),
  };
}
