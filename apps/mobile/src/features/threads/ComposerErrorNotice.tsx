import { useEffect } from "react";
import { AccessibilityInfo, Platform, Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

/** Why the thread's last message did not send, above the composer until dismissed. */
export function ComposerErrorNotice({
  message,
  onDismiss,
}: {
  readonly message: string;
  readonly onDismiss: () => void;
}) {
  // accessibilityLiveRegion below only reaches TalkBack; VoiceOver needs an
  // explicit announcement.
  useEffect(() => {
    if (Platform.OS === "ios") {
      AccessibilityInfo.announceForAccessibility(message);
    }
  }, [message]);
  return (
    <View className="px-4 pb-3">
      <View className="flex-row items-start gap-3 rounded-[20px] border-continuous bg-card p-4">
        <SymbolView
          name="exclamationmark.circle"
          size={16}
          tintColorClassName="accent-danger-foreground"
          type="monochrome"
        />
        <Text
          selectable
          accessibilityLiveRegion="polite"
          className="min-w-0 flex-1 text-sm text-foreground"
        >
          {message}
        </Text>
        <Pressable
          accessibilityLabel="Dismiss error"
          accessibilityRole="button"
          hitSlop={12}
          onPress={onDismiss}
          className="p-1 active:opacity-60"
        >
          <SymbolView
            name="xmark"
            size={14}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        </Pressable>
      </View>
    </View>
  );
}
