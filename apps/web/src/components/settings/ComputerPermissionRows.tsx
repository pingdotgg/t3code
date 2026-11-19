import type { DesktopBridge, DesktopComputerPermissions, EnvironmentId } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
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
  gt: ReturnType<typeof useGT>,
): string | undefined {
  switch (status.phase) {
    case "off":
      return undefined;
    case "starting":
      return gt("Offering this computer to the environment.");
    case "hosting":
      return gt("This computer is available to this environment while Ada is open.");
    case "waiting":
    case "denied":
    case "unavailable":
      return status.detail;
  }
}

/**
 * The desktop-only part of Settings → Computer use: the per-environment offer, and the macOS grants the
 * helper needs. It renders nothing outside the desktop app.
 */
export function ComputerPermissionRows({
  environmentId,
}: {
  readonly environmentId: EnvironmentId | null;
}) {
  const gt = useGT();
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
        title={gt("Let this environment use this computer")}
        description={gt(
          "Ada runs its agent's steps on this Mac while the app is open, asking before consequential ones.",
        )}
        status={hostStatusText(status, gt)}
        control={
          <Switch
            checked={offered}
            disabled={environmentId === null}
            aria-label={gt("Let this environment use this computer")}
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
            title={gt("Accessibility", { $context: "macOS privacy permission name" })}
            description={gt("Lets computer use read the screen and press the controls it finds.")}
            status={
              permissions.accessibility
                ? gt("Allowed", { $context: "permission status" })
                : gt("Not allowed", { $context: "permission status" })
            }
            control={
              <Button size="xs" variant="outline" onClick={() => openPane("accessibility")}>
                <T>Open System Settings</T>
              </Button>
            }
          />
          <SettingsRow
            title={gt("Screen Recording", { $context: "macOS privacy permission name" })}
            description={gt(
              "Used only when an app hides its window from Accessibility; the picture is read and then dropped.",
            )}
            status={
              permissions.screenRecording
                ? gt("Allowed", { $context: "permission status" })
                : gt("Not allowed", { $context: "permission status" })
            }
            control={
              <Button size="xs" variant="outline" onClick={() => openPane("screen-recording")}>
                <T>Open System Settings</T>
              </Button>
            }
          />
          <SettingsRow
            title={gt("Automation", { $context: "macOS privacy permission name" })}
            description={gt(
              "macOS asks per app the first time Ada controls it, so there is nothing to switch on here yet.",
            )}
            control={
              <Button size="xs" variant="outline" onClick={() => openPane("automation")}>
                <T>Open System Settings</T>
              </Button>
            }
          />
        </>
      )}
    </>
  );
}
