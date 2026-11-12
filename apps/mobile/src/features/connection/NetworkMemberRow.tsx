import * as Dialog from "../../components/ui/Dialog";
import type { NetworkMemberRecord } from "@t3tools/client-runtime/connection";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { networkMembers } from "../../state/networkMembers";
import { useAtomCommand } from "../../state/use-atom-command";
import { ConnectionStatusDot } from "./ConnectionStatusDot";

/** A machine of the user's network this device has not opened yet. */
export function NetworkMemberRow(props: {
  readonly member: NetworkMemberRecord;
  readonly viaLabel: string | null;
}) {
  const open = useAtomCommand(networkMembers.open, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const handleOpen = async () => {
    setBusy(true);
    const result = await open(props.member.environmentId);
    setBusy(false);
    if (AsyncResult.isSuccess(result)) return;
    const error = Cause.squash(result.cause);
    Dialog.alert(
      `Could not open ${props.member.label}`,
      error instanceof Error ? error.message : "None of your machines could open it.",
    );
  };

  return (
    <View className="flex-row items-center gap-3 bg-grouped-card px-4 py-3.5">
      <View className="min-w-0 flex-1 gap-0.5">
        <View className="flex-row items-center gap-1.5">
          <ConnectionStatusDot state="available" pulse={false} size={8} />
          <Text
            className="min-w-0 flex-shrink text-base font-t3-bold leading-snug text-foreground"
            numberOfLines={1}
          >
            {props.member.label}
          </Text>
        </View>
        <Text className="text-xs text-foreground-muted" numberOfLines={1}>
          {props.viaLabel === null ? "In your network" : `In your network · via ${props.viaLabel}`}
        </Text>
      </View>
      <Button
        label="Open"
        size="compact"
        accessibilityLabel={`Open ${props.member.label}`}
        loading={busy}
        onPress={() => void handleOpen()}
      />
    </View>
  );
}
