import { Pressable, View } from "react-native";

import { AppText } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";

export function DevicePreviewButton(props: {
  readonly count: number;
  readonly onPress: () => void;
  readonly compact?: boolean;
}) {
  const compact = props.compact ?? true;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.count === 1 ? "View device" : `View ${props.count} devices`}
      accessibilityHint="Watch and control devices open in this thread"
      onPress={props.onPress}
      className={
        compact
          ? "size-11 shrink-0 items-center justify-center rounded-full active:bg-subtle"
          : "h-11 shrink-0 flex-row items-center justify-center gap-2 rounded-full px-4 active:bg-subtle"
      }
    >
      <SymbolView
        name={{ ios: "iphone", android: "smartphone" }}
        size={20}
        tintColorClassName="accent-icon"
        type="monochrome"
      />
      {!compact ? (
        <AppText className="font-t3-medium text-xs text-foreground">
          {props.count === 1 ? "One device open" : `${props.count} devices open`}
        </AppText>
      ) : props.count > 1 ? (
        <View className="absolute right-0.5 top-0.5 min-w-4 items-center rounded-full bg-primary px-1">
          <AppText className="text-2xs font-t3-bold text-primary-foreground">{props.count}</AppText>
        </View>
      ) : null}
    </Pressable>
  );
}
