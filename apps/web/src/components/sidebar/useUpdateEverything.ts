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
import {
  collectServerUpdateTargets,
  describeUpdateEverything,
  runUpdateEverything,
} from "./updateEverything.logic";

/**
 * The remote half of the sidebar update button: outdated providers on every
 * connected machine, and servers behind the version this client runs or is
 * about to install (`localUpdateVersion`). Server targets appear only once npm
 * confirms that version. `run` performs the whole pass, including this app's
 * own download and install when given.
 */
export function useUpdateEverything(localUpdateVersion: string | null) {
  const targetVersion = localUpdateVersion ?? APP_VERSION;
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

  const { summary, lines } = describeUpdateEverything({
    localVersion: localUpdateVersion,
    servers,
    providerMachines: providers.machines.map((machine) => ({
      environmentId: machine.environmentId,
      label: machine.label,
      providers: machine.candidates.map(
        (candidate) => PROVIDER_DISPLAY_NAMES[candidate.driver] ?? candidate.driver,
      ),
    })),
  });

  return {
    hasUpdates: servers.length > 0 || providers.machines.length > 0,
    /** Short label for the tooltip and the confirmation title. */
    summary,
    /** One line per machine, for the confirmation. */
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
