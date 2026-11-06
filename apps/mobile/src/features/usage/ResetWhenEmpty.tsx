import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderConsumeResetCreditInput,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { resetCreditTargetKey } from "@t3tools/shared/usageLimits";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";

export function ResetWhenEmpty({
  environmentId,
  target,
  window,
}: {
  readonly environmentId: EnvironmentId;
  readonly target: ProviderConsumeResetCreditInput;
  readonly window: ServerProviderUsageWindow;
}) {
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const canManage = useAtomValue(serverEnvironment.setResetWhenEmpty.permissionAtom(environmentId));
  const set = useAtomCommand(serverEnvironment.setResetWhenEmpty, { reportFailure: false });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const armed =
    settings?.resetCreditsWhenEmpty?.some(
      (entry) =>
        resetCreditTargetKey(entry.target) === resetCreditTargetKey(target) &&
        entry.windowId === window.id &&
        entry.resetsAt === window.resetsAt,
    ) ?? false;
  const toggle = async (enabled: boolean) => {
    setBusy(true);
    setFailed(false);
    const result = await set({ environmentId, input: { target, windowId: window.id, enabled } });
    setBusy(false);
    setFailed(result._tag !== "Success");
  };
  return (
    <View className="w-full gap-1 pt-3">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="flex-1 text-sm font-t3-medium text-foreground">Reset when empty</Text>
        <ThemedSwitch
          accessibilityLabel="Reset when empty"
          value={armed}
          disabled={busy || !canManage || !window.resetsAt}
          onValueChange={(enabled) => void toggle(enabled)}
        />
      </View>
      <Text className="text-xs text-foreground-tertiary">
        Uses one credit at 0% left, then turns off. Cancels when this period resets.
      </Text>
      {failed ? (
        <Text className="text-sm text-foreground">
          Could not change the queued reset. Refresh usage and try again.
        </Text>
      ) : null}
    </View>
  );
}
