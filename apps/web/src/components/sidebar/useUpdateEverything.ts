import { useAtomValue } from "@effect/atom-react";
import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo } from "react";

import { APP_VERSION } from "~/branding";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { useNpmReleasePublished } from "~/state/npmRelease";
import { serverEnvironment } from "~/state/server";
import { environmentSession } from "~/state/session";
import { useProviderUpdates } from "../ProviderUpdatesAction";
import { canUpdateServer, useServerUpdate } from "../ServerUpdateAction";
import { collectServerUpdateTargets, runUpdateEverything } from "./updateEverything.logic";

/**
 * The remote half of the sidebar update button: servers behind
 * `targetVersion` and outdated providers on every connected machine. Server
 * targets appear only once npm confirms `t3@<targetVersion>`. `run` performs
 * the whole pass, including this app's own download and install when given.
 */
export function useUpdateEverything(targetVersion: string = APP_VERSION) {
  const { environments } = useEnvironments();
  const machinesAtom = useMemo(
    () =>
      Atom.make((get) =>
        environments.map((environment) => ({
          environmentId: environment.environmentId,
          label: environment.label,
          serverConfig: environment.serverConfig,
          connected: environment.connection.phase === "connected",
          hostedByThisApp:
            isElectron &&
            (environment.entry.target._tag === "PrimaryConnectionTarget" ||
              isDesktopLocalConnectionTarget(environment.entry.target)),
          canMaintain: canUpdateServer(
            get(environmentSession.sessionStateAtom(environment.environmentId)),
          ),
          updateState: get(serverEnvironment.updateStateAtom(environment.environmentId)),
        })),
      ),
    [environments],
  );
  const machines = useAtomValue(machinesAtom);
  const behindServers = collectServerUpdateTargets(machines, targetVersion);
  // Ask npm only when a server would download the version.
  const published = useNpmReleasePublished(behindServers.length > 0 ? targetVersion : null);
  const servers = published ? behindServers : [];
  const providers = useProviderUpdates();
  const updateServer = useServerUpdate();

  const providerCount = providers.machines.reduce(
    (count, machine) => count + machine.candidates.length,
    0,
  );
  const lines = [
    servers.length > 0
      ? `Servers to ${targetVersion}: ${servers
          .map((server) =>
            server.selfUpdate === "desktop-managed"
              ? `${server.serverLabel} (desktop app relaunches)`
              : server.serverLabel,
          )
          .join(", ")}`
      : null,
    ...providers.machines.map(
      (machine) =>
        `Providers on ${machine.label}: ${machine.candidates
          .map((candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver)
          .join(", ")}`,
    ),
  ].filter((line) => line !== null);

  return {
    hasUpdates: servers.length > 0 || providerCount > 0,
    serverCount: servers.length,
    providerCount,
    /** One line per server group and provider machine, for confirmations. */
    lines,
    run: (local: { downloadLocal?: () => Promise<boolean>; installLocal?: () => Promise<void> }) =>
      runUpdateEverything({
        ...local,
        updateProviders: providers.updateAll,
        updateServers: async () => {
          await Promise.all(servers.map((server) => updateServer(server)));
        },
      }),
  };
}
