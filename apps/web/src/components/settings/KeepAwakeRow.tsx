import { useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import {
  keepAwakeStateAtom,
  refreshKeepAwakeState,
  setKeepAwakeEnabled,
  type KeepAwakeBridge,
} from "~/state/keepAwakeState";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SettingsRow } from "./settingsLayout";

function KeepAwakeSwitch({
  checked,
  disabled,
  disabledReason,
  onCheckedChange,
  ariaLabel = "Keep this computer awake",
}: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  readonly onCheckedChange?: (enabled: boolean) => void;
  readonly ariaLabel?: string;
}) {
  const control = (
    <Switch
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      {...(onCheckedChange ? { onCheckedChange } : {})}
    />
  );
  return disabledReason ? (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex">{control}</span>} />
      <TooltipPopup side="top">{disabledReason}</TooltipPopup>
    </Tooltip>
  ) : (
    control
  );
}

export function KeepAwakeRow({
  canManageLocalBackend,
}: {
  readonly canManageLocalBackend: boolean;
}) {
  const desktopBridge = typeof window === "undefined" ? undefined : window.desktopBridge;
  const keepAwakeBridge = desktopBridge as unknown as KeepAwakeBridge | undefined;
  const keepAwake = useEnvironmentQuery(
    canManageLocalBackend && desktopBridge ? keepAwakeStateAtom : null,
  );
  const [isUpdating, setIsUpdating] = useState(false);

  // Desktop-only row: the browser build has no power-inhibition backend.
  if (!desktopBridge) return null;

  // Load failed: keep a recovery row (with retry) visible instead of an
  // interactive switch stuck at off — with unknown state a click would send
  // `true` while the machine may already be awake, stranding the user with
  // no way to turn it off from this row.
  if (keepAwake.error) {
    return (
      <SettingsRow
        id="keep-awake"
        title="Keep Awake"
        description="Couldn't load the Keep Awake state."
        status={<span className="block text-destructive">{keepAwake.error}</span>}
        control={
          <Button
            size="sm"
            variant="outline"
            onClick={refreshKeepAwakeState}
            disabled={keepAwake.isPending}
          >
            {keepAwake.isPending ? "Retrying…" : "Retry"}
          </Button>
        }
      />
    );
  }

  const bridgeSupportsKeepAwake =
    typeof keepAwakeBridge?.getKeepAwakeState === "function" &&
    typeof keepAwakeBridge?.setKeepAwakeEnabled === "function";
  const state = keepAwake.data;

  const disabledReason = !canManageLocalBackend
    ? "Your session does not have permission to manage this machine's settings."
    : !bridgeSupportsKeepAwake
      ? "This version of the desktop app does not support Keep Awake."
      : state !== null && !state.supported
        ? "Keep Awake is not supported on this machine."
        : null;
  const isBusy = keepAwake.isPending || isUpdating;

  const updateKeepAwake = async (enabled: boolean) => {
    if (!canManageLocalBackend || !bridgeSupportsKeepAwake) return;
    setIsUpdating(true);
    try {
      const next = await setKeepAwakeEnabled(enabled);
      refreshKeepAwakeState();
      if (next.enabled !== enabled) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: enabled ? "Could not turn Keep Awake on" : "Could not turn Keep Awake off",
            description: next.supported
              ? "The setting did not change. Try again."
              : "Keep Awake is not supported on this machine.",
          }),
        );
        return;
      }
      toastManager.add({
        type: "success",
        title: enabled ? "Keep Awake on" : "Keep Awake off",
        description: enabled
          ? "This computer will stay awake for remote agent work."
          : "This computer can sleep normally again.",
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Failed to change Keep Awake.";
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change Keep Awake",
          description: message,
        }),
      );
      refreshKeepAwakeState();
    } finally {
      setIsUpdating(false);
    }
  };

  return (
    <SettingsRow
      id="keep-awake"
      title="Keep Awake"
      description="Keeps this computer awake with the display on, even with the lid closed. Your power settings are restored when you turn it off."
      status={
        keepAwake.error ? <span className="block text-destructive">{keepAwake.error}</span> : null
      }
      control={
        <KeepAwakeSwitch
          ariaLabel="Keep this computer awake"
          checked={state?.enabled ?? false}
          disabled={disabledReason !== null || isBusy || state === null}
          disabledReason={disabledReason}
          onCheckedChange={(enabled) => void updateKeepAwake(enabled)}
        />
      }
    />
  );
}
