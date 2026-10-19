import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

export function ComposerQueuedEditBanner(props: {
  readonly saving: boolean;
  readonly onCancel: () => void;
}) {
  return (
    <View className="flex-row items-center gap-2 px-4 pb-2">
      <SymbolView name="pencil" size={12} tintColorClassName="accent-foreground-muted" />
      <Text className="min-w-0 flex-1 text-xs text-foreground-muted" numberOfLines={1}>
        Editing queued message
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Cancel editing queued message"
        disabled={props.saving}
        onPress={props.onCancel}
        hitSlop={8}
        className="min-h-8 justify-center px-1 active:opacity-70 disabled:opacity-40"
      >
        <Text className="font-t3-medium text-xs text-primary">Cancel</Text>
      </Pressable>
    </View>
  );
}
