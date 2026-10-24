import type { DesktopCliCommandState } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

export function CliCommandSettingsRow() {
  const bridge = typeof window === "undefined" ? undefined : window.desktopBridge?.cliCommand;
  const [state, setState] = useState<DesktopCliCommandState | null>(null);
  const [pending, setPending] = useState(false);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge
      .getState()
      .then((next) => {
        if (!cancelled) setState(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  const change = (action: "install" | "uninstall") => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(setState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: action === "install" ? "Could not install t3" : "Could not remove t3",
            description: error instanceof Error ? error.message : "Something went wrong.",
          }),
        );
      })
      .finally(() => setPending(false));
  };

  if (!bridge || !state?.supported) return null;
  const installed = state.installedPath !== null;
  const wsl = state.wsl ? (state.wsl.distro ? `WSL (${state.wsl.distro})` : "WSL") : null;
  const inWsl = wsl ? ` in ${wsl}` : "";
  const status = state.shadowedBy
    ? `Another t3 at ${state.shadowedBy}${inWsl} runs first in a new terminal. Remove it to use T3 Code's.`
    : !installed
      ? `Run T3 Code's CLI as \`t3\` from any terminal${inWsl}.`
      : state.onPath
        ? `Installed${inWsl} at ${state.installedPath}. Open a new terminal to use it.`
        : `Installed${inWsl} at ${state.installedPath}, which is not on your PATH yet. Add its folder to your PATH to run \`t3\`.`;
  const description = state.wsl?.windowsInstalled
    ? `${status} The Windows t3 command is still installed; turn off WSL only in Connections to remove it.`
    : status;

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => change(installed ? "uninstall" : "install")}
        >
          {installed ? "Remove" : "Install"}
        </Button>
      }
    />
  );
}
