import { SymbolView } from "expo-symbols";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";

export function NewTaskSheetHeader(props: {
  readonly eyebrow?: string;
  readonly title: string;
  readonly control?: {
    readonly icon: "chevron.left" | "xmark";
    readonly onPress: () => void;
  };
}) {
  const iconColor = useThemeColor("--color-icon");

  return (
    <>
      <View style={{ minHeight: 16, paddingTop: 8 }} />
      <View className="items-center gap-1 px-5 pb-3 pt-4">
        {props.control ? (
          <Pressable
            className="absolute left-3 top-4 h-9 w-9 items-center justify-center rounded-full bg-subtle"
            style={{ zIndex: 1 }}
            onPress={props.control.onPress}
          >
            <SymbolView
              name={props.control.icon}
              size={16}
              tintColor={iconColor}
              type="monochrome"
              weight="medium"
            />
          </Pressable>
        ) : null}
        <Text
          className="text-[12px] font-t3-bold uppercase text-foreground-muted"
          style={{ letterSpacing: 1 }}
        >
          {props.eyebrow ?? "New task"}
        </Text>
        <Text className="text-[28px] font-t3-bold">{props.title}</Text>
      </View>
    </>
  );
}
