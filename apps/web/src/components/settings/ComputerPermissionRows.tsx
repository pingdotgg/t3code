import type { DesktopBridge, DesktopComputerPermissions, EnvironmentId } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import {
  setDesktopComputerHostOffered,
  useDesktopComputerHostStatus,
} from "~/computer/desktopHostBridge";
import { isElectron } from "~/env";
import { useClientSettings } from "~/hooks/useSettings";

import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";

const desktopBridge = (): DesktopBridge | undefined =>
  isElectron ? window.desktopBridge : undefined;

/** Reads the two grants on mount and whenever the window comes back from System Settings. */
function useComputerPermissions(bridge: DesktopBridge | undefined) {
  const [permissions, setPermissions] = useState<DesktopComputerPermissions | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the grants live in macOS, read again on focus
  useEffect(() => {
    let stopped = false;
    const read = () => {
      void bridge?.getComputerPermissions?.().then(
        (next) => {
          if (!stopped) setPermissions(next);
        },
        () => {
          if (!stopped) setPermissions(null);
        },
      );
    };
    read();
    window.addEventListener("focus", read);
    return () => {
      stopped = true;
      window.removeEventListener("focus", read);
    };
  }, [bridge]);
  return permissions;
}

function hostStatusText(
  status: ReturnType<typeof useDesktopComputerHostStatus>,
): string | undefined {
  switch (status.phase) {
    case "off":
      return undefined;
    case "starting":
      return "Offering this computer to the environment.";
    case "hosting":
      return "This computer is available to this environment while Ada is open.";
    case "waiting":
    case "denied":
    case "unavailable":
      return status.detail;
  }
}

/**
 * The desktop-only part of Settings → Computer use: the per-environment offer, and the macOS grants the
 * helper needs. Phase C renders this; it renders nothing outside the desktop app.
 */
export function ComputerPermissionRows({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const bridge = desktopBridge();
  const offering = bridge?.computerHost !== undefined;
  const offered = useClientSettings(
    (settings) =>
      environmentId !== null && settings.computerHostEnvironments[environmentId] === true,
  );
  const status = useDesktopComputerHostStatus(environmentId);
  const permissions = useComputerPermissions(offering ? bridge : undefined);

  if (!offering || bridge === undefined) return null;

  const openPane = (pane: "accessibility" | "screen-recording" | "automation") => {
    void bridge.openSystemSettings(pane).catch(() => undefined);
  };

  return (
    <>
      <SettingsRow
        title="Let this environment use this computer"
        description="Ada runs its agent's steps on this Mac while the app is open, asking before consequential ones."
        status={hostStatusText(status)}
        control={
          <Switch
            checked={offered}
            disabled={environmentId === null}
            aria-label="Let this environment use this computer"
            onCheckedChange={(checked) => {
              if (environmentId === null) return;
              void setDesktopComputerHostOffered(environmentId, checked);
            }}
          />
        }
      />
      {permissions === null ? null : (
        <>
          <SettingsRow
            title="Accessibility"
            description="Lets computer use read the screen and press the controls it finds."
            status={permissions.accessibility ? "Allowed" : "Not allowed"}
            control={
              <Button size="xs" variant="outline" onClick={() => openPane("accessibility")}>
                Open System Settings
              </Button>
            }
          />
          <SettingsRow
            title="Screen Recording"
            description="Used only when an app hides its window from Accessibility; the picture is read and then dropped."
            status={permissions.screenRecording ? "Allowed" : "Not allowed"}
            control={
              <Button size="xs" variant="outline" onClick={() => openPane("screen-recording")}>
                Open System Settings
              </Button>
            }
          />
          <SettingsRow
            title="Automation"
            description="macOS asks per app the first time Ada controls it, so there is nothing to switch on here yet."
            control={
              <Button size="xs" variant="outline" onClick={() => openPane("automation")}>
                Open System Settings
              </Button>
            }
          />
        </>
      )}
    </>
  );
}
