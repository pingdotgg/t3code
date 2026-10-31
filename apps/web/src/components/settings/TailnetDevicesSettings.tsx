import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TailnetDevice } from "@t3tools/contracts";
import { useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironmentQuery } from "~/state/query";
import { tailnetEnvironment } from "~/state/tailnet";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ITEM_ROW_CLASSNAME, ITEM_ROW_INNER_CLASSNAME } from "./itemRows";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
};

/**
 * Devices that signed in to a host through Tailscale. Block ends a device's
 * sessions there and refuses its sign-in until Unblock. A saved environment
 * passes its label; the primary environment's section has none.
 */
export function TailnetDevicesSettings({
  environmentId,
  environmentLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel?: string;
}) {
  const canManage = useAtomValue(tailnetEnvironment.blockDevice.permissionAtom(environmentId));
  const listed = useEnvironmentQuery(
    canManage ? tailnetEnvironment.devices({ environmentId, input: {} }) : null,
  );
  const blockDevice = useAtomCommand(tailnetEnvironment.blockDevice, { reportFailure: false });
  const unblockDevice = useAtomCommand(tailnetEnvironment.unblockDevice, { reportFailure: false });
  const [busyId, setBusyId] = useState<string | null>(null);
  const devices = listed.data?.devices ?? null;

  if (!canManage || (devices !== null && devices.length === 0)) return null;

  const toggle = async (device: TailnetDevice) => {
    const name = device.label ?? device.stableNodeId;
    if (device.blockedAt === null) {
      const confirmed = await requestConfirmDialog(
        `Block ${name}?\n${device.current ? `This is the device you are using, so it loses access ${environmentLabel === undefined ? "here" : `to ${environmentLabel}`} until another device unblocks it. ` : ""}Its sessions ${environmentLabel === undefined ? "here" : `on ${environmentLabel}`} end now, and it cannot sign in through Tailscale until you unblock it. A device that rejoins Tailscale gets a new ID, so block it again or remove it from your tailnet.`,
        { variant: "destructive" },
      );
      if (confirmed !== true) return;
    }
    setBusyId(device.stableNodeId);
    const input = { environmentId, input: { stableNodeId: device.stableNodeId } };
    const result = await (device.blockedAt === null ? blockDevice(input) : unblockDevice(input));
    setBusyId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: device.blockedAt === null ? "Could not block the device" : "Could not unblock it",
          description: failureMessage(result),
        }),
      );
    }
  };

  return (
    <SettingsSection
      {...(environmentLabel === undefined ? { id: "tailscale-devices" } : {})}
      title={
        environmentLabel === undefined
          ? "Tailscale devices"
          : `Tailscale devices on ${environmentLabel}`
      }
    >
      {listed.error !== null ? (
        <SettingsRow title="Could not load Tailscale devices" description={listed.error} />
      ) : devices === null ? (
        <SettingsRow title="Loading Tailscale devices…" role="status" />
      ) : (
        devices.map((device) => (
          <div key={device.stableNodeId} className={ITEM_ROW_CLASSNAME}>
            <div className={ITEM_ROW_INNER_CLASSNAME}>
              <div className="min-w-0 flex-1 space-y-1">
                <h3 className="truncate text-sm font-medium text-foreground">
                  {device.label ?? device.stableNodeId}
                </h3>
                <p className="text-xs text-muted-foreground">
                  {device.current ? "This device · " : ""}
                  {device.blockedAt !== null
                    ? "Blocked"
                    : device.activeSessionCount === 1
                      ? "1 session"
                      : `${device.activeSessionCount} sessions`}
                </p>
              </div>
              <Button
                size="xs"
                variant={device.blockedAt === null ? "destructive-outline" : "outline"}
                disabled={busyId === device.stableNodeId}
                onClick={() => void toggle(device)}
              >
                {device.blockedAt === null ? "Block" : "Unblock"}
              </Button>
            </div>
          </div>
        ))
      )}
    </SettingsSection>
  );
}
