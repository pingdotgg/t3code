import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, TailnetDevice } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { useEnvironmentServerConfig } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { tailnetEnvironment } from "../../state/tailnet";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : String(error);
};

/**
 * Devices that signed in to a host through Tailscale, with Block and Unblock.
 * Block ends the device's sessions there and refuses its sign-in until Unblock.
 */
export function TailnetDevicesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  /** Outer spacing. Defaults to the environment list's. */
  readonly className?: string;
}) {
  const config = useEnvironmentServerConfig(props.environmentId);
  const offered = config?.environment.capabilities.tailnetSignIn === true;
  const canManage = useAtomValue(
    tailnetEnvironment.blockDevice.permissionAtom(props.environmentId),
  );
  const listed = useEnvironmentQuery(
    offered && canManage
      ? tailnetEnvironment.devices({ environmentId: props.environmentId, input: {} })
      : null,
  );
  const blockDevice = useAtomCommand(tailnetEnvironment.blockDevice, { reportFailure: false });
  const unblockDevice = useAtomCommand(tailnetEnvironment.unblockDevice, { reportFailure: false });
  const [busyId, setBusyId] = useState<string | null>(null);
  const devices = listed.data?.devices ?? [];

  if (devices.length === 0) return null;

  const apply = async (device: TailnetDevice) => {
    setBusyId(device.stableNodeId);
    const input = {
      environmentId: props.environmentId,
      input: { stableNodeId: device.stableNodeId },
    };
    const result = await (device.blockedAt === null ? blockDevice(input) : unblockDevice(input));
    setBusyId(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      Dialog.alert(
        device.blockedAt === null ? "Could not block the device" : "Could not unblock it",
        failureMessage(result),
      );
    }
  };

  const toggle = (device: TailnetDevice) => {
    const name = device.label ?? device.stableNodeId;
    if (device.blockedAt !== null) {
      void apply(device);
      return;
    }
    Dialog.confirm({
      title: `Block ${name}?`,
      message: `${device.current ? `This is the device you are using, so it loses access to ${props.environmentLabel} until another device unblocks it. ` : ""}Its Tailscale sessions on ${props.environmentLabel} end now, and it cannot sign in through Tailscale until you unblock it. Sessions it made with a pairing code stay until you revoke them. A device that rejoins Tailscale gets a new ID, so block it again or remove it from your tailnet.`,
      confirmText: "Block",
      destructive: true,
      onConfirm: () => void apply(device),
    });
  };

  return (
    <View className={props.className ?? "mt-5 gap-3"}>
      <SettingsSection title={`Tailscale devices on ${props.environmentLabel}`}>
        {devices.map((device) => (
          <ListActionRow
            key={device.stableNodeId}
            label={device.label ?? device.stableNodeId}
            description={`${device.current ? "This device · " : ""}${
              device.blockedAt !== null
                ? "Blocked"
                : device.activeSessionCount === 1
                  ? "1 session"
                  : `${device.activeSessionCount} sessions`
            }`}
            detail={device.blockedAt === null ? "Block" : "Unblock"}
            loading={busyId === device.stableNodeId}
            onPress={() => toggle(device)}
          />
        ))}
      </SettingsSection>
    </View>
  );
}
