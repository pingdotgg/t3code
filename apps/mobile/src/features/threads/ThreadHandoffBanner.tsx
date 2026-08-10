import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { SymbolView } from "expo-symbols";
import { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { useThreadShells } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Shows where a departed thread's work lives, with the escape hatch to make
 * this side live again. Moving a thread FROM the phone is not offered yet;
 * this keeps a thread that was moved elsewhere legible rather than silently
 * refusing every send.
 */
export function ThreadHandoffBanner(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const shells = useThreadShells();
  const shell =
    shells.find(
      (candidate) =>
        candidate.environmentId === props.environmentId && candidate.id === props.threadId,
    ) ?? null;
  const handoff = shell?.handoff ?? null;
  const releaseHandoff = useAtomCommand(threadEnvironment.releaseHandoff, {
    reportFailure: false,
  });
  const [releasing, setReleasing] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const borderColor = useThemeColor("--color-border");

  const handleRelease = useCallback(async () => {
    if (handoff === null || releasing) return;
    setReleasing(true);
    setErrorMessage(null);
    try {
      const result = await releaseHandoff({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, handoffId: handoff.handoffId },
      });
      if (result._tag === "Failure") {
        setErrorMessage("Could not continue here. Check the other device is reachable.");
      }
    } finally {
      setReleasing(false);
    }
  }, [handoff, props.environmentId, props.threadId, releaseHandoff, releasing]);

  if (handoff === null || handoff.presence !== "away") {
    return null;
  }

  return (
    <View className="mb-2">
      <View
        className="mx-4 flex-row items-center gap-2.5 rounded-xl px-3.5 py-2.5"
        style={{ borderWidth: 1, borderColor }}
      >
        <SymbolView name="cloud" size={16} tintColor={borderColor} />
        <View className="flex-1">
          <Text className="text-sm font-t3-medium text-foreground">
            Running on {handoff.peerLabel ?? "another device"}
          </Text>
          <Text className="text-xs text-foreground-tertiary">
            The thread now lives there — keep working with it from any device.
          </Text>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Continue on this device"
          disabled={releasing}
          onPress={() => {
            void handleRelease();
          }}
          className="rounded-lg px-3 py-1.5"
          style={{ borderWidth: 1, borderColor }}
        >
          {releasing ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text className="text-xs font-t3-medium text-foreground">Continue here</Text>
          )}
        </Pressable>
      </View>
      {errorMessage === null ? null : (
        <Text className="mx-4 mt-1 text-xs text-red-600 dark:text-red-400">{errorMessage}</Text>
      )}
    </View>
  );
}
