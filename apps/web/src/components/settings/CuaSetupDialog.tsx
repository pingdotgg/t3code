import type { CuaHostStatus } from "@t3tools/contracts";
import { useRef, useState } from "react";

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

function hostRequirements(platform: CuaHostStatus["platform"], hostLabel: string): string {
  switch (platform) {
    case "darwin":
      return `${hostLabel} needs Accessibility and Screen Recording. Finish setup at that Mac: in System Settings → Privacy & Security, grant access to the app or process running this environment. You can turn the setting on from here.`;
    case "linux":
      return `${hostLabel} needs a signed-in graphical session. On Wayland, someone at ${hostLabel} may need to approve a screen capture prompt.`;
    case "win32":
      return `${hostLabel} needs a signed-in desktop session. If Windows shows a security prompt for Cua Driver, someone at that computer must respond.`;
    default:
      return `Computer use needs a desktop on ${hostLabel}.`;
  }
}

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
  localMac: boolean;
  onCheck: (permission: CuaPermission) => Promise<boolean>;
  onAllow: (permission: CuaPermission) => Promise<void>;
  onEnable: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
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
  const allow = async (target: CuaPermission) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onAllow(target);
    } catch {
      setError("Could not open System Settings. Try Allow again.");
    }
    pending.current = false;
    setBusy(false);
  };
  const finish = async () => {
    if (pending.current || !ready) return;
    pending.current = true;
    setBusy(true);
    setError(null);
    try {
      await onEnable();
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Could not save the setting. Try again.");
    }
    pending.current = false;
    setBusy(false);
  };
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending.current) onClose();
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
                  onAllow: () => void allow("accessibility"),
                },
                {
                  id: "screen-recording",
                  icon: <MacScreenRecordingIcon className="size-8 shrink-0 drop-shadow-sm" />,
                  title: "Screen Recording",
                  description: "See the screen to decide what to do next.",
                  granted: permission.status["screen-recording"],
                  onAllow: () => void allow("screen-recording"),
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
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (!pending.current) onClose();
            }}
          >
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
