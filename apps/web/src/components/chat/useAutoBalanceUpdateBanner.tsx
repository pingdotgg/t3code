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
import { InlineButton } from "../ui/button";
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
  const count = running || failed || machines.length;
  const status = running ? "running" : failed ? "failed" : "idle";
  const title = running
    ? gt("{count, plural, one {Updating {count} machine} other {Updating {count} machines}}", {
        count,
      })
    : failed
      ? gt(
          "{count, plural, one {Could not update {count} machine} other {Could not update {count} machines}}",
          { count },
        )
      : gt(
          "{count, plural, one {Update available for {count} machine} other {Update available for {count} machines}}",
          { count },
        );
  return {
    id: `auto-balance-server-updates-${dismissedNotices.size}`,
    variant: failed ? "error" : "default",
    group: "environment",
    icon: <ComposerServerUpdateIcon status={status} />,
    title: (
      <Popover>
        <PopoverTrigger
          render={<InlineButton />}
          className="max-w-full"
          aria-label={gt("{title}. View machines", { title })}
        >
          <span className="min-w-0 truncate">{title}</span>
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
    ),
    description:
      manual > 0
        ? gt(
            "{manual, plural, one {{manual} needs a manual update} other {{manual} need a manual update}}",
            { manual },
          )
        : undefined,
    actions:
      running === 0 && targets.length > 0 ? (
        <ServerUpdatesAction
          targets={targets}
          variant="ghost"
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
      ) : undefined,
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
