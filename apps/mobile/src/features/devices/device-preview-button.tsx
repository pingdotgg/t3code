import { Plural, T, useGT, Var } from "gt-react-native";
import { Pressable, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";

export function DevicePreviewButton(props: {
  readonly count: number;
  readonly onPress: () => void;
  readonly compact?: boolean;
}) {
  const compact = props.compact ?? true;
  const gt = useGT();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={gt("{count, plural, =1 {View device} other {View {count} devices}}", {
        count: props.count,
      })}
      accessibilityHint={gt("Watch and control devices open in this thread")}
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
          <T>
            <Plural
              n={props.count}
              singular="One device open"
              other={
                <>
                  <Var>{props.count}</Var> devices open
                </>
              }
            />
          </T>
        </AppText>
      ) : props.count > 1 ? (
        <View className="absolute right-1.5 top-1.5 min-w-4 items-center rounded-full bg-primary px-1">
          <AppText className="text-2xs font-t3-bold text-primary-foreground">{props.count}</AppText>
        </View>
      ) : null}
    </Pressable>
  );
}
