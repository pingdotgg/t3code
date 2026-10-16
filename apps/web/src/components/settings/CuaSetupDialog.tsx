import type { CuaHostStatus } from "@t3tools/contracts";
import { useState } from "react";

import { MacAccessibilityIcon, MacScreenRecordingIcon } from "../Icons";
import { PermissionChecklist, PermissionContinueButton } from "../permissions/PermissionChecklist";
import { usePermissionStatus } from "../permissions/usePermissionStatus";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

export type CuaPermission = "accessibility" | "screen-recording";

const CUA_PERMISSIONS: readonly CuaPermission[] = ["accessibility", "screen-recording"];

/** What the host itself needs before computer use can work there. */
function hostRequirements(platform: CuaHostStatus["platform"], hostLabel: string): string {
  switch (platform) {
    case "darwin":
      return `T3 Code on ${hostLabel} needs Accessibility and Screen Recording. Open T3 Code on that Mac to grant them; the setting turns on from here either way.`;
    case "linux":
      return `${hostLabel} needs a signed-in graphical session. On Wayland, someone at ${hostLabel} approves the screen capture prompt the first time an agent looks at the screen.`;
    case "win32":
      return `${hostLabel} needs a signed-in desktop session. No permissions are needed; Windows Defender may ask once before Cua Driver first runs.`;
    default:
      return `Computer use needs a desktop on ${hostLabel}.`;
  }
}

/**
 * Setup for Cua computer use. On the Mac that hosts the environment it walks
 * through Accessibility and Screen Recording, which macOS grants to T3 Code;
 * elsewhere it explains what the host needs, since only someone at it can act.
 */
export function CuaSetupDialog({
  enabled,
  hostLabel,
  platform,
  localMac,
  onCheck,
  onAllow,
  onEnable,
  onClose,
}: {
  enabled: boolean;
  hostLabel: string;
  platform: CuaHostStatus["platform"];
  /** This desktop is the Mac that runs the environment, so it can grant access here. */
  localMac: boolean;
  onCheck: (permission: CuaPermission) => Promise<boolean>;
  onAllow: (permission: CuaPermission) => Promise<void>;
  onEnable: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const permission = usePermissionStatus(
    async () => ({
      accessibility: await onCheck("accessibility"),
      "screen-recording": await onCheck("screen-recording"),
    }),
    { accessibility: false, "screen-recording": false },
    localMac && !busy,
  );
  const ready = !localMac || permission.isReady(CUA_PERMISSIONS);
  const allow = (target: CuaPermission) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    void onAllow(target)
      .catch(() => setError("Could not open System Settings. Try Allow again."))
      .finally(() => setBusy(false));
  };
  const finish = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onEnable();
      onClose();
    } catch {
      setError("Could not save the setting. Try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogPopup showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Let agents use {hostLabel}</DialogTitle>
          <DialogDescription>
            Cua Driver lets agents see and use apps on {hostLabel} in the background, without moving
            your cursor. Agent sessions started afterwards get the computer use tools.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {localMac ? (
            <PermissionChecklist
              busy={busy}
              permissions={[
                {
                  id: "accessibility",
                  icon: <MacAccessibilityIcon className="size-8 shrink-0 drop-shadow-sm" />,
                  title: "Accessibility",
                  description: "Click, type, and read controls in other apps.",
                  granted: permission.status.accessibility,
                  onAllow: () => allow("accessibility"),
                },
                {
                  id: "screen-recording",
                  icon: <MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />,
                  title: "Screen Recording",
                  description: "See the screen to decide what to do next.",
                  granted: permission.status["screen-recording"],
                  onAllow: () => allow("screen-recording"),
                },
              ]}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{hostRequirements(platform, hostLabel)}</p>
          )}
          {error || (localMac && permission.error) ? (
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              {error ?? permission.error}
            </p>
          ) : null}
          {localMac && !ready ? (
            <p className="mt-3 text-xs text-muted-foreground">
              If a permission stays off after you allow it, quit and reopen T3 Code.
            </p>
          ) : null}
        </DialogPanel>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>
            {enabled ? "Close" : "Finish later"}
          </Button>
          <PermissionContinueButton ready={ready} busy={busy} onClick={() => void finish()}>
            {enabled ? "Done" : "Turn on"}
          </PermissionContinueButton>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
