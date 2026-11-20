import { useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";

import { APP_VERSION } from "~/branding";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom } from "~/state/server";
import { environmentSessionStatesAtom } from "~/state/session";
import { canUpdateServer, type ServerUpdateOutcome, useServerUpdate } from "../ServerUpdateAction";
import {
  type ChannelSwitchRelease,
  closeFinishedUpdateRun,
  collectChannelSwitchTargets,
  collectRestartingMachines,
  collectServerUpdateTargets,
  collectUpdateEverythingResult,
  describeUpdateEverything,
  runUpdateEverything,
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

const UPDATE_RESTART_DELAY_MS = 5_000;

/** Servers this desktop app runs; they update with it. */
export function isHostedByThisApp(
  environment: ReturnType<typeof useEnvironments>["environments"][number],
) {
  return (
    isElectron &&
    (environment.entry.target._tag === "PrimaryConnectionTarget" ||
      isDesktopLocalConnectionTarget(environment.entry.target))
  );
}

export type ReportLocalUpdateError = (title: string, description: string) => void;

/** `channelSwitch` makes the run move the fleet to that release's track instead of updating it. */
export function useUpdateEverything(
  localUpdateVersion: string | null,
  channelSwitch?: ChannelSwitchRelease,
) {
  const targetVersion = localUpdateVersion ?? APP_VERSION;
  const { environments } = useEnvironments();
  const resolve = useMessages();
  const environmentIds = environmentIdsKey(environments.map(({ environmentId }) => environmentId));
  const sessionStates = useAtomValue(environmentSessionStatesAtom(environmentIds));
  const updateStates = useAtomValue(environmentUpdateStatesAtom(environmentIds));
  const machines = environments.map((environment, index) => ({
    environmentId: environment.environmentId,
    label: environment.label,
    serverConfig: environment.serverConfig,
    connected: environment.connection.phase === "connected",
    hostedByThisApp: isHostedByThisApp(environment),
    canMaintain: canUpdateServer(sessionStates[index]!),
    updateState: updateStates[index]!,
  }));
  const { targets: servers, skipped } = channelSwitch
    ? collectChannelSwitchTargets(machines, channelSwitch, resolve)
    : collectServerUpdateTargets(machines, targetVersion, resolve);
  // Track-only hosts save a setting and restart nothing, so they are neither listed nor counted.
  const moving = servers.filter((server) => server.trackOnly !== true);
  const restarts = collectRestartingMachines(machines, moving, localUpdateVersion !== null);
  const updateServer = useServerUpdate();

  const view = describeUpdateEverything(
    {
      localVersion: localUpdateVersion,
      localMachines: machines.filter((machine) => machine.hostedByThisApp),
      servers: moving,
      skipped,
    },
    resolve,
  );

  return {
    hasUpdates: servers.length > 0,
    ...view,
    restarts,
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
      const runMachines: Array<UpdateRunMachine> = servers.map((server) => ({
        environmentId: server.environmentId,
        label: server.serverLabel,
        server,
        handedOffVersion: null,
        startedAt,
        result: null,
        failure: null,
      }));
      const localVersion = installLocal ? localUpdateVersion : null;
      setUpdateEverythingRun(() => ({
        ...(channelSwitch ? { trackSwitch: true } : {}),
        localVersion,
        phase: "servers",
        restartAt: null,
        machines: runMachines,
      }));
      const finishedServers: Array<{ label: string; outcome: ServerUpdateOutcome }> = [];
      try {
        const outcome = await runUpdateEverything({
          ...(downloadLocal ? { downloadLocal: () => downloadLocal(reportLocalError) } : {}),
          updateServers: async () => {
            const runs = servers.map(async (server) => {
              const serverOutcome = await updateServer(server, { quiet: true });
              settleUpdateRunMachine(
                server.environmentId,
                serverOutcome.status === "failed" ? serverOutcome.message : null,
                { serverUpdated: serverOutcome.status !== "failed" },
              );
              const finished = { label: server.serverLabel, outcome: serverOutcome };
              finishedServers.push(finished);
              return finished;
            });
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
