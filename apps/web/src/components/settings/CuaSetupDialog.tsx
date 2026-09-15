import { useState } from "react";

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
import { AccessibilityPermissionIcon, ScreenRecordingIcon } from "./MacPermissionIcons";

export type CuaPermission = "accessibility" | "screen-recording";

export const CUA_PERMISSIONS: readonly CuaPermission[] = ["accessibility", "screen-recording"];

/**
 * Host permission onboarding for Cua computer use, shown on the desktop that
 * owns the environment. The switch only turns on once both grants exist.
 */
export function CuaSetupDialog({
  enabled,
  onCheck,
  onAllow,
  onEnable,
  onClose,
}: {
  enabled: boolean;
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
    !busy,
  );
  const ready = permission.isReady(CUA_PERMISSIONS);
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
          <DialogTitle>Let agents use this computer</DialogTitle>
          <DialogDescription>
            Cua Driver controls the screen and apps on this Mac. Allow each permission for T3 Code,
            then continue. Agent sessions started afterwards get the computer use tools.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <PermissionChecklist
            busy={busy}
            permissions={[
              {
                id: "accessibility",
                icon: <AccessibilityPermissionIcon />,
                title: "Accessibility",
                description: "Click, type, and read controls in other apps.",
                granted: permission.status.accessibility,
                onAllow: () => allow("accessibility"),
              },
              {
                id: "screen-recording",
                icon: <ScreenRecordingIcon />,
                title: "Screen Recording",
                description: "See the screen to decide what to do next.",
                granted: permission.status["screen-recording"],
                onAllow: () => allow("screen-recording"),
              },
            ]}
          />
          {error || permission.error ? (
            <p role="status" className="mt-3 text-xs text-muted-foreground">
              {error ?? permission.error}
            </p>
          ) : null}
          {!ready ? (
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
