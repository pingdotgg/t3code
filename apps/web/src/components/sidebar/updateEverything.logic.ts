import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { cliReleaseChannelOf } from "@t3tools/shared/cliRelease";

import {
  resolveServerSelfUpdateCapability,
  resolveVersionMismatch,
  supportsDesktopAppUpdate,
  supportsServerUpdateThreadContinuation,
} from "~/versionSkew";
import type { ServerUpdateTarget } from "../ServerUpdateAction";

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

/**
 * The servers that "update everything" moves to `targetVersion`: connected,
 * permitted, able to update over RPC, and behind the target. Two kinds stay
 * out. Servers this app hosts would relaunch the app mid-run, and the app's
 * own install updates them anyway. A service on another release channel
 * stays there; a desktop-managed server follows its own app's update feed, so
 * the channel rule does not apply to it.
 */
export function collectServerUpdateTargets(
  machines: ReadonlyArray<UpdateEverythingMachine>,
  targetVersion: string,
): ServerUpdateTarget[] {
  return machines.flatMap((machine) => {
    const config = machine.serverConfig;
    if (
      config === null ||
      !machine.connected ||
      machine.hostedByThisApp ||
      !machine.canMaintain ||
      machine.updateState.status === "running"
    ) {
      return [];
    }
    const selfUpdate = resolveServerSelfUpdateCapability(config);
    const desktopAppUpdate = supportsDesktopAppUpdate(config);
    if (selfUpdate === null || (selfUpdate === "desktop-managed" && !desktopAppUpdate)) {
      return [];
    }
    const serverVersion = config.environment.serverVersion;
    if (resolveVersionMismatch(serverVersion, targetVersion) === null) return [];
    if (
      selfUpdate !== "desktop-managed" &&
      cliReleaseChannelOf(serverVersion) !== cliReleaseChannelOf(targetVersion)
    ) {
      return [];
    }
    return [
      {
        environmentId: machine.environmentId,
        serverLabel: machine.label,
        selfUpdate,
        installation: config.environment.capabilities.serverInstallation,
        desktopAppUpdate,
        threadContinuation: supportsServerUpdateThreadContinuation(config),
        continueThreadsAfterServerUpdate: config.settings.continueThreadsAfterServerUpdate ?? false,
        targetVersion,
      },
    ];
  });
}

export interface UpdateEverythingSteps {
  /** Downloads this app's update. Resolves true when it is ready to install. */
  readonly downloadLocal?: () => Promise<boolean>;
  readonly updateProviders: () => Promise<void>;
  readonly updateServers: () => Promise<void>;
  /** Installs this app's update. The relaunch ends the run. */
  readonly installLocal?: () => Promise<void>;
}

/**
 * Runs one "update everything" pass. Providers finish before any server
 * restarts, so no install is cut off. The local download runs alongside the
 * remote work. This app installs last because its relaunch ends the run; a
 * failed download skips only that install. Steps report their own results.
 */
export async function runUpdateEverything(steps: UpdateEverythingSteps): Promise<void> {
  const [localReady] = await Promise.all([
    steps.downloadLocal?.() ?? Promise.resolve(true),
    steps.updateProviders().then(steps.updateServers),
  ]);
  if (localReady) await steps.installLocal?.();
}
