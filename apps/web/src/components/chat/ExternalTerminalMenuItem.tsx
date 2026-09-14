import {
  EXTERNAL_TERMINALS,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type EnvironmentId,
} from "@t3tools/contracts";
import { TerminalIcon } from "lucide-react";
import { useClientSettings } from "~/hooks/useSettings";
import { useRemoteOpenResolution } from "~/remoteOpen";
import { useEnvironmentPresentation } from "~/state/presentation";
import { desktopLocalBackendId } from "~/connection/desktopLocal";
import { MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from "../ui/menu";
import { toastManager } from "../ui/toast";

export function ExternalTerminalMenuItem({
  environmentId,
  cwd,
}: {
  environmentId: EnvironmentId;
  cwd: string | null;
}) {
  const terminal = useClientSettings((settings) => settings.externalTerminal);
  const remote = useRemoteOpenResolution(environmentId);
  const { presentation } = useEnvironmentPresentation(environmentId);
  const bridge = window.desktopBridge;
  if (!bridge?.openTerminal) return null;
  const unavailable = !remote.isResolved || remote.state.mode === "remote-unavailable";
  const label = EXTERNAL_TERMINALS.find(({ id }) => id === terminal)?.label ?? "Default";

  const open = async () => {
    if (!cwd || unavailable || !bridge.openTerminal) return;
    try {
      const target = presentation?.entry.target;
      const backendId =
        target?._tag === "PrimaryConnectionTarget"
          ? PRIMARY_LOCAL_ENVIRONMENT_ID
          : target
            ? desktopLocalBackendId(target)
            : null;
      const bootstrap =
        backendId === null
          ? undefined
          : bridge.getLocalEnvironmentBootstraps().find(({ id }) => id === backendId);
      if (backendId !== null && (!bootstrap || bootstrap.httpBaseUrl === null)) {
        throw new Error("The local environment is not ready. Reconnect before opening a terminal.");
      }
      const wslDistro = bootstrap?.runningDistro;
      await bridge.openTerminal({
        terminal,
        cwd,
        ...(remote.state.mode === "remote-links" ? { sshHost: remote.state.host.host } : {}),
        ...(wslDistro ? { wslDistro } : {}),
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not open terminal",
        description:
          error instanceof Error
            ? error.message
            : "Check your terminal app in Settings → Integrations.",
      });
    }
  };

  return (
    <>
      <MenuSeparator />
      <MenuGroup>
        <MenuGroupLabel>Terminal</MenuGroupLabel>
        <MenuItem disabled={!cwd || unavailable} onClick={() => void open()}>
          <TerminalIcon aria-hidden="true" />
          {terminal === "system" ? "Open in terminal" : `Open in ${label}`}
        </MenuItem>
      </MenuGroup>
    </>
  );
}
