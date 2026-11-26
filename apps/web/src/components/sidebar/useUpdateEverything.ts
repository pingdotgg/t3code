import { useContext, useEffect } from "react";
import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { AuthProvidersManageScope, PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import { msg, useMessages } from "gt-react";
import { connectionErrorText } from "@t3tools/client-runtime/connection";

import { APP_VERSION } from "~/branding";
import { isDesktopLocalConnectionTarget } from "~/connection/desktopLocal";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { environmentAtomList, environmentIdsKey } from "~/state/environmentAtomList";
import { environmentUpdateStatesAtom, serverEnvironment } from "~/state/server";
import { environmentSessionStatesAtom, useEnvironmentsWithScope } from "~/state/session";
import { useAtomCommand } from "~/state/use-atom-command";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { getProviderUpdateRunOutcome } from "../ProviderUpdateLaunchNotification.logic";
import { useProviderUpdates } from "../ProviderUpdatesAction";
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

const proxyUpdateAtom = (environmentId: UpdateRunMachine["environmentId"]) =>
  serverEnvironment.inferenceProxy.updates({ environmentId, input: { operation: "checkUpdate" } });
const proxyUpdatesByEnvironment = environmentAtomList("web-inference-updates", proxyUpdateAtom);
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
    connectionError: connectionErrorText(environment.connection, resolve),
    turnedOff: !environment.entry.enabled,
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
  const providerUpdates = useProviderUpdates();
  // A track switch moves app and servers only; provider updates stay a separate choice.
  const providers = channelSwitch ? { machines: [], updateAll: async () => [] } : providerUpdates;
  const manageable = useEnvironmentsWithScope(environments, AuthProvidersManageScope);
  const proxyHosts = environments.filter(
    (e) =>
      !channelSwitch &&
      e.connection.phase === "connected" &&
      e.serverConfig?.environment.capabilities.inferenceProxy &&
      manageable.has(e.environmentId),
  );
  const proxyIds = environmentIdsKey(proxyHosts.map((e) => e.environmentId));
  const checks = useAtomValue(proxyUpdatesByEnvironment(proxyIds));
  const registry = useContext(RegistryContext);
  const refreshProxyUpdates = () =>
    proxyHosts.forEach((e) => registry.refresh(proxyUpdateAtom(e.environmentId)));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refresh upstream releases while the desktop remains open
  useEffect(() => {
    if (!proxyIds) return;
    const timer = window.setInterval(
      () => {
        for (const key of proxyIds.split("\n"))
          registry.refresh(proxyUpdateAtom(key as UpdateRunMachine["environmentId"]));
      },
      60 * 60 * 1000,
    );
    return () => window.clearInterval(timer);
  }, [registry, proxyIds]);
  const proxyTargets = proxyHosts.filter((_e, i) => {
    const result = checks[i];
    return result?._tag === "Success" && result.value.update?.available;
  });
  const manageProxy = useAtomCommand(serverEnvironment.inferenceProxy.manageInference, {
    reportFailure: false,
  });
  const providerMachines = machines.flatMap((m) => {
    const names =
      providers.machines
        .find((p) => p.environmentId === m.environmentId)
        ?.candidates.map((c) => PROVIDER_DISPLAY_NAMES[c.driver] ?? c.driver) ?? [];
    if (proxyTargets.some((p) => p.environmentId === m.environmentId)) names.push("CLIProxyAPI");
    return names.length
      ? [{ environmentId: m.environmentId, label: m.label, providers: names }]
      : [];
  });
  const updateServer = useServerUpdate();
  const stageServerUpdate = useAtomCommand(serverEnvironment.stageServerUpdate, {
    reportFailure: false,
  });

  const view = describeUpdateEverything(
    {
      localVersion: localUpdateVersion,
      localMachines: machines.filter((machine) => machine.hostedByThisApp),
      servers: moving,
      skipped,
      providerMachines,
    },
    resolve,
  );

  return {
    hasUpdates: servers.length > 0 || providerMachines.length > 0,
    refreshProxyUpdates,
    machines,
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
      const machinesById = new Map<UpdateRunMachine["environmentId"], UpdateRunMachine>();
      for (const machine of providerMachines) {
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
        ...(channelSwitch ? { trackSwitch: true } : {}),
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
              if (runOutcome.status !== "updated") {
                providerFailures.set(
                  run.environmentId,
                  runOutcome.status === "failed"
                    ? runOutcome.line
                    : resolve(msg("Provider update interrupted")),
                );
              }
              return runOutcome;
            });
            for (const target of proxyTargets) {
              const result = await manageProxy({
                environmentId: target.environmentId,
                input: { operation: "update" },
              });
              if (result._tag === "Success") outcomes.push({ status: "updated", message: null });
              else {
                const line = `${target.label} · CLIProxyAPI: ${String(squashAtomCommandFailure(result))}`;
                providerFailures.set(target.environmentId, line);
                outcomes.push({ status: "failed", line });
              }
            }
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
          ...(providers.machines.length > 0
            ? {
                stageServers: () =>
                  new Map(
                    servers
                      .filter(
                        (server) =>
                          machines.find((machine) => machine.environmentId === server.environmentId)
                            ?.serverConfig?.environment.capabilities.serverUpdateStaging === true,
                      )
                      .map((server) => [
                        server.environmentId,
                        stageServerUpdate({
                          environmentId: server.environmentId,
                          input: { targetVersion: server.targetVersion, stageOnly: true },
                        }),
                      ]),
                  ),
              }
            : {}),
          updateServers: async (staged) => {
            const runs = servers.map(async (server) => {
              await staged.get(server.environmentId);
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
