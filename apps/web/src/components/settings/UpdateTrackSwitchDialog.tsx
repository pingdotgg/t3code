import { thrownErrorMessage } from "@t3tools/client-runtime/errors";
import { m as resolveMessage } from "~/i18n/messages";
import { useAtomValue } from "@effect/atom-react";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DesktopUpdateChannel } from "@t3tools/contracts";
import { acceptsTrackSwitchRelease, desktopUpdateChannelOf } from "@t3tools/shared/cliRelease";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";
import { AsyncResult } from "effect/reactivity";

import { APP_VERSION } from "~/branding";
import { isLocalEnvironmentDisabled } from "~/localEnvironment";
import { useDesktopUpdateState } from "~/state/desktopUpdate";
import { useEnvironments } from "~/state/environments";
import { npmReleaseAtom, npmReleaseFailureMessage } from "~/state/npmRelease";
import { downloadLocalUpdate, installLocalUpdate } from "../sidebar/SidebarUpdatePill";
import { UpdateEverythingDialog } from "../sidebar/UpdateEverythingDialog";
import {
  channelSwitchLabel,
  localSwitchBlockReason,
  type ChannelSwitchRelease,
} from "../sidebar/updateEverything.logic";
import { isHostedByThisApp, useUpdateEverything } from "../sidebar/useUpdateEverything";
import {
  localUpdaterStaysPut,
  nothingToMove,
  prepareLocalTrackSwitch,
} from "./updateTrackSwitch.logic";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Moves this app and every connected machine to `channel`. */
export function UpdateTrackSwitchDialog({
  channel,
  onClose,
}: {
  readonly channel: DesktopUpdateChannel;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  // npm dist-tags match the desktop channel names.
  const release = useAtomValue(npmReleaseAtom(channel));
  if (AsyncResult.isSuccess(release) && release.value !== null) {
    return <SwitchPlan release={{ channel, ...release.value }} onClose={onClose} />;
  }
  const label = channelSwitchLabel(channel, m);
  return (
    <AlertDialog open onOpenChange={(open) => !open && onClose()}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            <T>
              Switch to <Var>{label}</Var>
            </T>
          </AlertDialogTitle>
          <AlertDialogDescription>
            {AsyncResult.isFailure(release)
              ? npmReleaseFailureMessage(release.cause, m)
              : AsyncResult.isSuccess(release)
                ? gt(
                    "Could not find the latest {label} release in this environment's npm registry.",
                    {
                      label,
                    },
                  )
                : gt("Checking releases…")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="secondary" />}>
            <T>Cancel</T>
          </AlertDialogClose>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

function SwitchPlan({
  release,
  onClose,
}: {
  readonly release: ChannelSwitchRelease;
  readonly onClose: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const updateState = useDesktopUpdateState();
  const { environments } = useEnvironments();
  const crossesLocal = desktopUpdateChannelOf(APP_VERSION) !== release.channel;
  const updatesOff = localUpdaterStaysPut(updateState, release.channel);
  // After a partial switch this app may already be on the track; then only remotes move.
  const switchesLocal = crossesLocal && !updatesOff;
  const [checking, setChecking] = useState(false);
  const everything = useUpdateEverything(switchesLocal ? release.version : null, release);
  const label = channelSwitchLabel(release.channel, m);
  const idle = nothingToMove(
    {
      label,
      channel: release.channel,
      savedChannel: updateState?.channel ?? null,
      switchesLocal,
      crossesLocal,
      rows: everything.rows,
      hasTargets: everything.hasUpdates,
    },
    m,
  );
  // This app's reinstall restarts every server it hosts, so each of their databases must allow it.
  const localBlocked = localSwitchBlockReason(
    APP_VERSION,
    release,
    environments.filter(isHostedByThisApp).map((environment) => ({
      connected: environment.connection.phase === "connected",
      databaseMigration: environment.serverConfig?.environment.databaseMigration,
    })),
    window.desktopBridge?.getLocalEnvironmentBootstraps().length ?? 0,
    !isLocalEnvironmentDisabled(),
    m,
  );

  const run = async () => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    // Stay open while the feed is checked; the run's own progress takes over after.
    setChecking(true);
    const fail = (description: string) =>
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: gt("Could not switch to {label}", { label }),
          description,
        }),
      );
    const prepared = await prepareLocalTrackSwitch(bridge, {
      channel: release.channel,
      version: release.version,
      reinstall: switchesLocal,
    });
    onClose();
    if (!prepared.ok) {
      fail(prepared.message);
      return;
    }
    const { local } = prepared;
    const result = await settlePromise(() =>
      everything.run(
        local === null
          ? {}
          : {
              ...(local.status === "available"
                ? {
                    downloadLocal: (reportError) =>
                      downloadLocalUpdate(bridge, { notifyDownloaded: false, reportError }),
                  }
                : {}),
              // Install only a build the database check covers, pinned so nothing replaces it.
              installLocal: async (reportError) => {
                const { downloadedVersion } = await bridge.getUpdateState();
                if (
                  downloadedVersion === null ||
                  !acceptsTrackSwitchRelease(downloadedVersion, release.channel, release.version)
                ) {
                  reportError(
                    gt("Could not install update"),
                    downloadedVersion === null
                      ? gt("This app downloaded nothing, not {version} or newer.", {
                          version: release.version,
                        })
                      : gt("This app downloaded {downloaded}, not {version} or newer.", {
                          downloaded: downloadedVersion,
                          version: release.version,
                        }),
                  );
                  return false;
                }
                return installLocalUpdate(bridge, reportError, downloadedVersion);
              },
            },
      ),
    );
    if (result._tag === "Failure") {
      const error = squashAtomCommandFailure(result);
      fail(
        error instanceof Error
          ? (thrownErrorMessage(error, resolveMessage) ?? error.message)
          : gt("An unexpected error occurred."),
      );
    }
  };

  return (
    <UpdateEverythingDialog
      open
      onOpenChange={(open) => !open && !checking && onClose()}
      title={gt("Switch to {label}?", { label })}
      version={release.version}
      providerCount={0}
      rows={everything.rows}
      notes={[
        ...(idle.note === null ? [] : [idle.note]),
        ...(crossesLocal && updatesOff
          ? [gt("This app's updates are off here, so reinstall it yourself to switch.")]
          : []),
        ...(switchesLocal && isMacPlatform(navigator.platform)
          ? [gt("If T3 Code does not reopen after it restarts, open it again.")]
          : []),
      ]}
      restarts={everything.restarts}
      confirmLabel={checking ? gt("Checking…") : gt("Switch to {label}", { label })}
      busy={checking}
      disabledReason={switchesLocal && localBlocked !== null ? localBlocked : idle.disabledReason}
      onConfirm={() => void run()}
    />
  );
}
