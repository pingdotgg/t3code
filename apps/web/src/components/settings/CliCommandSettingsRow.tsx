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

const FAILURE_TITLES = {
  install: "Could not install t3",
  uninstall: "Could not remove t3",
  addToPath: "Could not add t3 to PATH",
  installWsl: "Could not install t3 in WSL",
  uninstallWsl: "Could not remove t3 from WSL",
} as const;

/** The desktop `t3` command's state, and its actions with a toast on failure. */
export function useDesktopCliCommand() {
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const [pending, setPending] = useState(false);

  const run = (action: keyof typeof FAILURE_TITLES) => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: FAILURE_TITLES[action],
            description: error instanceof Error ? error.message : "Something went wrong.",
          }),
        );
      })
      .finally(() => setPending(false));
  };

  return {
    state: bridge ? query.data : undefined,
    busy: pending || query.isPending,
    run,
  };
}

export function CliCommandSettingsRow() {
  const { state, busy, run } = useDesktopCliCommand();

  if (!state?.supported) return null;
  const installed = state.installedPath !== null;
  const wslInstalled = state.wslInstalledPath !== null;
  const description = state.shadowedBy
    ? `Another t3 at ${state.shadowedBy} runs first in a new terminal. Remove it to use T3 Code's.`
    : !installed
      ? "Run T3 Code's CLI as `t3` from any terminal."
      : state.onPath
        ? `Installed at ${state.installedPath}. Open a new terminal to use it.`
        : state.pathSetup?.added
          ? `Installed at ${state.installedPath} and added to PATH in ${state.pathSetup.file}. Open a new terminal to use it.`
          : `Installed at ${state.installedPath}, which is not on your PATH yet.${state.pathSetup ? "" : " Add its folder to your PATH to run `t3`."}`;

  return (
    <>
      <SettingsRow
        {...searchableSetting("cli-command")}
        description={description}
        control={
          <div className="flex gap-2">
            {state.pathSetup && !state.pathSetup.added ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
                Add to PATH
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || (!installed && Boolean(state.shadowedBy))}
              onClick={() => run(installed ? "uninstall" : "install")}
            >
              {installed ? "Remove" : "Install"}
            </Button>
          </div>
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
              disabled={busy || (!wslInstalled && !state.wslBackendEnabled)}
              onClick={() => run(wslInstalled ? "uninstallWsl" : "installWsl")}
            >
              {wslInstalled ? "Remove" : "Install"}
            </Button>
          }
        />
      ) : null}
    </>
  );
}
