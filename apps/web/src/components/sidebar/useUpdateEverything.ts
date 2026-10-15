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
import { getProviderUpdateRunOutcome } from "../ProviderUpdateLaunchNotification.logic";
import { useProviderUpdates } from "../ProviderUpdatesAction";
import { canUpdateServer, type ServerUpdateOutcome, useServerUpdate } from "../ServerUpdateAction";
import {
  closeFinishedUpdateRun,
  collectRestartingMachines,
  collectServerUpdateTargets,
  collectUpdateEverythingResult,
  describeUpdateEverything,
  runUpdateEverything,
  type SkippedMachine,
  type UpdateRunMachine,
} from "./updateEverything.logic";
import {
  clearSavedUpdateEverythingResult,
  saveUpdateEverythingResult,
  setUpdateEverythingRun,
  settleUpdateRunMachine,
  showUpdateEverythingResult,
  waitForServerUpdateHandoff,
  waitForUpdateRestart,
} from "./updateEverythingRun";

/** How long this app counts down before it relaunches, so the user can postpone it. */
const UPDATE_RESTART_DELAY_MS = 5_000;

/** Where this app's own download or install reports a failure. */
export type ReportLocalUpdateError = (title: string, description: string) => void;

/**
 * The remote half of the sidebar update button: outdated providers on every
 * connected machine, and servers behind the version this client runs or is
 * about to install (`localUpdateVersion`). Servers that install from npm appear
 * only once npm confirms that version. `run` performs the whole pass, including
 * this app's own download and install when given. It updates quietly, tracks
 * each machine in the run state, and reports one summary toast at the end.
 * This app relaunches once every server restarts into its update, after a
 * short countdown the user can postpone. The summary then waits for the
 * relaunch, and servers still restarting are followed after it.
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
  const { targets: behindServers, skipped: unreachable } = collectServerUpdateTargets(
    machines,
    targetVersion,
  );
  // A desktop-managed server installs from its own app's update feed, so only
  // servers that download t3 from npm wait for npm to publish the version.
  const needsNpm = behindServers.some((server) => server.selfUpdate !== "desktop-managed");
  const published = useNpmReleasePublished(needsNpm ? targetVersion : null);
  const servers = published
    ? behindServers
    : behindServers.filter((server) => server.selfUpdate === "desktop-managed");
  const skipped: ReadonlyArray<SkippedMachine> = [
    ...unreachable,
    ...behindServers
      .filter((server) => !servers.includes(server))
      .map((server) => ({
        environmentId: server.environmentId,
        label: server.serverLabel,
        reason: `t3@${targetVersion} is not on npm yet`,
      })),
  ];
  const restarts = collectRestartingMachines(machines, servers, localUpdateVersion !== null);
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
    /** The servers this run restarts, which stops their running threads. */
    restarts,
    /** Behind machines the run leaves alone, with the reason. */
    skipped,
    /** Runs the pass. `installLocal` resolves true when this app is relaunching.
        Both report failures to the pass, which lists them in its summary. */
    run: async ({
      downloadLocal,
      installLocal,
    }: {
      downloadLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
      installLocal?: (reportError: ReportLocalUpdateError) => Promise<boolean>;
    }) => {
      const localFailures: Array<string> = [];
      const reportLocalError: ReportLocalUpdateError = (title, description) => {
        localFailures.push(`${title}: ${description}`);
      };
      const startedAt = Date.now();
      const machinesById = new Map<UpdateRunMachine["environmentId"], UpdateRunMachine>();
      for (const machine of providers.machines) {
        machinesById.set(machine.environmentId, {
          environmentId: machine.environmentId,
          label: machine.label,
          updatesProviders: true,
          server: null,
          handedOffVersion: null,
          startedAt,
          result: null,
          failure: null,
          providerFailure: null,
        });
      }
      for (const server of servers) {
        const existing = machinesById.get(server.environmentId);
        machinesById.set(server.environmentId, {
          environmentId: server.environmentId,
          label: server.serverLabel,
          updatesProviders: existing?.updatesProviders ?? false,
          server,
          handedOffVersion: null,
          startedAt,
          result: null,
          failure: null,
          providerFailure: null,
        });
      }
      const localVersion = installLocal ? localUpdateVersion : null;
      setUpdateEverythingRun(() => ({
        localVersion,
        phase: "providers",
        restartAt: null,
        machines: Array.from(machinesById.values()),
      }));
      const providerFailures = new Map<UpdateRunMachine["environmentId"], string>();
      const finishedServers: Array<{ label: string; outcome: ServerUpdateOutcome }> = [];
      try {
        const outcome = await runUpdateEverything({
          ...(downloadLocal ? { downloadLocal: () => downloadLocal(reportLocalError) } : {}),
          updateProviders: async () => {
            const runs = await providers.updateAll({ quiet: true });
            const outcomes = runs.map((run) => {
              const runOutcome = getProviderUpdateRunOutcome(run);
              // An interrupted update did not finish either, so its row is not "done".
              if (runOutcome.status !== "updated") {
                providerFailures.set(
                  run.environmentId,
                  runOutcome.status === "failed" ? runOutcome.line : "Provider update interrupted",
                );
              }
              return runOutcome;
            });
            for (const machine of machinesById.values()) {
              if (machine.server === null) {
                settleUpdateRunMachine(
                  machine.environmentId,
                  providerFailures.get(machine.environmentId) ?? null,
                );
              }
            }
            const serversStartedAt = Date.now();
            setUpdateEverythingRun(
              (run) =>
                run && {
                  ...run,
                  phase: "servers",
                  machines: run.machines.map((machine) =>
                    machine.server === null ? machine : { ...machine, startedAt: serversStartedAt },
                  ),
                },
            );
            return outcomes;
          },
          updateServers: async () => {
            const runs = servers.map(async (server) => {
              const serverOutcome = await updateServer(server, { quiet: true });
              settleUpdateRunMachine(
                server.environmentId,
                serverOutcome.status === "failed"
                  ? serverOutcome.message
                  : (providerFailures.get(server.environmentId) ?? null),
                {
                  serverUpdated: serverOutcome.status !== "failed",
                  providerFailure: providerFailures.get(server.environmentId) ?? null,
                },
              );
              const finished = { label: server.serverLabel, outcome: serverOutcome };
              finishedServers.push(finished);
              return finished;
            });
            // Once a server restarts into its update it finishes on its own,
            // so this app does not wait for it to come back.
            await Promise.all(
              servers.map((server, index) =>
                waitForServerUpdateHandoff(server.environmentId, runs[index]!),
              ),
            );
            return runs;
          },
        });
        const result = (finished: ReadonlyArray<{ label: string; outcome: ServerUpdateOutcome }>) =>
          collectUpdateEverythingResult({
            localVersion: null,
            localFailures,
            servers: finished,
            providers: outcome.providers,
          });
        if (outcome.localReady && installLocal) {
          if (await waitForUpdateRestart(UPDATE_RESTART_DELAY_MS)) {
            setUpdateEverythingRun(
              (run) => run && { ...run, phase: "installing", restartAt: null },
            );
            saveUpdateEverythingResult({ ...result(finishedServers), localVersion });
            if (await installLocal(reportLocalError)) return;
            clearSavedUpdateEverythingResult();
          }
        }
        // This app is not relaunching, so the pass waits for every server.
        setUpdateEverythingRun(
          (run) =>
            run &&
            closeFinishedUpdateRun({
              ...run,
              phase: "servers",
              restartAt: null,
              localVersion: null,
            }),
        );
        showUpdateEverythingResult(result(await Promise.all(outcome.servers)));
      } catch (error) {
        setUpdateEverythingRun(() => null);
        throw error;
      }
    },
  };
}
