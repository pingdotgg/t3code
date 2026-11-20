import { T, useGT, useMessages } from "gt-react";
import { useAtomValue } from "@effect/atom-react";
import type { ServerUpdateState } from "@t3tools/client-runtime/state/server";
import { useState } from "react";

import { environmentIdsKey } from "~/state/environmentAtomList";
import type { EnvironmentPresentation } from "~/state/environments";
import { environmentUpdateStatesAtom } from "~/state/server";
import {
  buildVersionMismatchDismissalKey,
  dismissServerUpdateFailure,
  dismissVersionMismatch,
  isServerUpdateFailureDismissed,
  isVersionMismatchDismissed,
  resolveServerConfigVersionMismatch,
  resolveServerSelfUpdateCapability,
  supportsDesktopAppUpdate,
} from "~/versionSkew";
import {
  ServerUpdateAction,
  ServerUpdateProgress,
  ServerUpdatesAction,
} from "../ServerUpdateAction";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import { ComposerServerUpdateIcon } from "./ComposerServerUpdateStatus";

export function useAutoBalanceUpdateBanner(
  environments: readonly EnvironmentPresentation[],
): ComposerBannerStackItem | null {
  const gt = useGT();
  const m = useMessages();
  const updateStates = useAtomValue(
    environmentUpdateStatesAtom(
      environmentIdsKey(environments.map(({ environmentId }) => environmentId)),
    ),
  );
  const states = environments.flatMap((environment, index) => {
    const state = updateStates[index];
    return state ? [{ environment, state }] : [];
  });
  const [dismissedNotices, setDismissedNotices] = useState<ReadonlySet<string | ServerUpdateState>>(
    () => new Set(),
  );
  const machines = states.flatMap(({ environment, state }) => {
    const mismatch = resolveServerConfigVersionMismatch(environment.serverConfig, m);
    const dismissKey = mismatch
      ? buildVersionMismatchDismissalKey(environment.environmentId, mismatch)
      : null;
    if (
      state.status === "idle"
        ? !mismatch ||
          (dismissKey !== null && dismissedNotices.has(dismissKey)) ||
          isVersionMismatchDismissed(dismissKey)
        : dismissedNotices.has(state) || isServerUpdateFailureDismissed(state)
    )
      return [];
    const selfUpdate = resolveServerSelfUpdateCapability(environment.serverConfig);
    const desktopAppUpdate = supportsDesktopAppUpdate(environment.serverConfig);
    return [
      {
        environmentId: environment.environmentId,
        serverLabel: environment.label,
        selfUpdate,
        installation: environment.serverConfig?.environment.capabilities.serverInstallation,
        desktopAppUpdate,
        targetVersion: state.status === "idle" ? mismatch!.clientVersion : state.targetVersion,
        connected: environment.connection.phase === "connected",
        remoteUpdate: selfUpdate !== null && (selfUpdate !== "desktop-managed" || desktopAppUpdate),
        state,
        dismissKey,
      },
    ];
  });
  if (machines.length === 0) return null;

  const running = machines.filter((machine) => machine.state.status === "running").length;
  const failed = machines.filter((machine) => machine.state.status === "failed").length;
  const manual = machines.filter((machine) => !machine.remoteUpdate).length;
  const targets = machines.filter(
    (machine) => machine.connected && machine.remoteUpdate && machine.state.status !== "running",
  );
  const status = running ? "running" : failed ? "failed" : "idle";
  const title = running
    ? gt("Updating")
    : failed
      ? gt("Could not update", { $context: "server update banner title, machine names follow" })
      : manual === machines.length
        ? gt("Manual update required")
        : gt("Update available for", {
            $context: "server update banner title, machine names follow",
          });
  const listed = running
    ? machines.filter((machine) => machine.state.status === "running")
    : failed
      ? machines.filter((machine) => machine.state.status === "failed")
      : machines;
  const machineNames = listed.map((machine) => machine.serverLabel).join(", ");
  const viewMachinesLabel = running
    ? gt("Updating {machines}. View machines", { machines: machineNames })
    : failed
      ? gt("Could not update {machines}. View machines", { machines: machineNames })
      : manual === machines.length
        ? gt("Manual update required for {machines}. View machines", { machines: machineNames })
        : gt("Update available for {machines}. View machines", { machines: machineNames });
  // Every machine updates from "Update all" unless some need a manual step or
  // are mid-update; then the per-machine list is one click away.
  const showMachineList =
    running > 0 || failed > 0 || manual > 0 || targets.length < machines.length;
  return {
    id: `auto-balance-server-updates-${dismissedNotices.size}`,
    variant: failed ? "error" : "default",
    group: "environment",
    icon: <ComposerServerUpdateIcon status={status} />,
    title,
    description:
      manual > 0 && manual < machines.length ? (
        <span className="inline-flex flex-col">
          <span>
            {gt(
              "{manual, plural, one {{manual} needs a manual update} other {{manual} need a manual update}}",
              { manual },
            )}
          </span>
          <span>{machineNames}</span>
        </span>
      ) : (
        machineNames
      ),
    actions: (
      <>
        {showMachineList ? (
          <Popover>
            <PopoverTrigger
              render={<Button size="xs" variant="secondary" />}
              aria-label={viewMachinesLabel}
            >
              <T>View machines</T>
            </PopoverTrigger>
            <PopoverPopup side="top" align="start" width="md">
              <div className="space-y-3 text-xs">
                {machines.map((machine) => (
                  <div key={machine.environmentId} className="space-y-1">
                    <div className="font-medium">{machine.serverLabel}</div>
                    {machine.state.status !== "idle" ? (
                      <ServerUpdateProgress state={machine.state} />
                    ) : !machine.remoteUpdate ? (
                      <>
                        <div className="text-muted-foreground">
                          <T>Manual update required</T>
                        </div>
                        <ServerUpdateAction {...machine} />
                      </>
                    ) : (
                      <div className="text-muted-foreground">
                        {machine.connected
                          ? gt("Ready to update to {version}", { version: machine.targetVersion })
                          : gt("Reconnect this machine to update")}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </PopoverPopup>
          </Popover>
        ) : null}
        {running === 0 && targets.length > 0 ? (
          <ServerUpdatesAction
            targets={targets}
            variant="default"
            label={
              failed > 0
                ? gt("Retry", { $context: "verb, retries the server updates" })
                : targets.length === machines.length
                  ? gt("Update all")
                  : gt(
                      "{count, plural, one {Update {count} machine} other {Update {count} machines}}",
                      { count: targets.length },
                    )
            }
          />
        ) : null}
      </>
    ),
    dismissLabel: gt("Dismiss update notice"),
    ...(running
      ? {}
      : {
          onDismiss: () => {
            const next = new Set(dismissedNotices);
            for (const { state, dismissKey } of machines) {
              dismissServerUpdateFailure(state);
              dismissVersionMismatch(dismissKey);
              if (dismissKey) next.add(dismissKey);
              if (state.status === "failed") next.add(state);
            }
            setDismissedNotices(next);
          },
        }),
  };
}
