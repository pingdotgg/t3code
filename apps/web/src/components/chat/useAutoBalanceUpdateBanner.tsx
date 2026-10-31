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
    const mismatch = resolveServerConfigVersionMismatch(environment.serverConfig);
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
    ? "Updating"
    : failed
      ? "Could not update"
      : manual === machines.length
        ? "Manual update required"
        : "Update available for";
  const listed = running
    ? machines.filter((machine) => machine.state.status === "running")
    : failed
      ? machines.filter((machine) => machine.state.status === "failed")
      : machines;
  const machineNames = listed.map((machine) => machine.serverLabel).join(", ");
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
      manual > 0 && manual < machines.length
        ? `${machineNames} · ${manual} ${manual === 1 ? "needs" : "need"} a manual update`
        : machineNames,
    actions: (
      <>
        {showMachineList ? (
          <Popover>
            <PopoverTrigger
              render={<Button size="xs" variant="secondary" />}
              aria-label={`${title} ${machineNames}. View machines`}
            >
              View machines
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
                        <div className="text-muted-foreground">Manual update required</div>
                        <ServerUpdateAction {...machine} />
                      </>
                    ) : (
                      <div className="text-muted-foreground">
                        {machine.connected
                          ? `Ready to update to ${machine.targetVersion}`
                          : "Reconnect this machine to update"}
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
                ? "Retry"
                : targets.length === machines.length
                  ? "Update all"
                  : `Update ${targets.length} ${targets.length === 1 ? "machine" : "machines"}`
            }
          />
        ) : null}
      </>
    ),
    dismissLabel: "Dismiss update notice",
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
