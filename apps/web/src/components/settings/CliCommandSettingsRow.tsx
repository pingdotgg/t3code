import { useState } from "react";

import {
  desktopCliCommandStateAtom,
  getDesktopCliCommandBridge,
  refreshDesktopCliCommandState,
} from "~/state/desktopCliCommand";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function CliCommandSettingsRow() {
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const state = query.data;
  const [pending, setPending] = useState(false);

  const change = (action: "install" | "uninstall" | "installWsl" | "uninstallWsl") => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              action === "install" || action === "installWsl"
                ? "Could not install t3"
                : "Could not remove t3",
            description: error instanceof Error ? error.message : "Something went wrong.",
          }),
        );
      })
      .finally(() => setPending(false));
  };

  if (!bridge || !state?.supported) return null;
  const installed = state.installedPath !== null;
  const wslInstalled = state.wslInstalledPath !== null;
  const description = state.shadowedBy
    ? `Another t3 at ${state.shadowedBy} runs first in a new terminal. Remove it to use T3 Code's.`
    : !installed
      ? "Run T3 Code's CLI as `t3` from any terminal."
      : state.onPath
        ? `Installed at ${state.installedPath}. Open a new terminal to use it.`
        : `Installed at ${state.installedPath}, which is not on your PATH yet. Add its folder to your PATH to run \`t3\`.`;

  return (
    <>
      <SettingsRow
        {...searchableSetting("cli-command")}
        description={description}
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={pending || query.isPending || (!installed && Boolean(state.shadowedBy))}
            onClick={() => change(installed ? "uninstall" : "install")}
          >
            {installed ? "Remove" : "Install"}
          </Button>
        }
      />
      {state.wslSupported ? (
        <SettingsRow
          {...searchableSetting("wsl-cli-command")}
          title="t3 command in WSL"
          description={
            state.wslStatusUnavailable
              ? `Could not check the t3 command in ${state.wslInstalledDistro ?? "WSL"}. Check that the distro is available.`
              : wslInstalled
                ? `Installed at ${state.wslInstalledPath} in ${state.wslInstalledDistro ?? "WSL"}. Ensure ~/.local/bin is on your shell PATH.${state.wslBackendEnabled ? "" : " Enable the WSL backend to open projects."}`
                : !state.wslBackendEnabled
                  ? "Enable the WSL backend in Sharing & access before installing the WSL command."
                  : "Run t3 app from WSL to open the current Linux project in the Windows desktop app."
          }
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={pending || query.isPending || (!wslInstalled && !state.wslBackendEnabled)}
              onClick={() => change(wslInstalled ? "uninstallWsl" : "installWsl")}
            >
              {wslInstalled ? "Remove" : "Install"}
            </Button>
          }
        />
      ) : null}
    </>
  );
}
