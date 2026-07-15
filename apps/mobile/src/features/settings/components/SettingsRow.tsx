import { useNavigation } from "@react-navigation/native";
import type { ComponentProps } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";

import { AppText as Text } from "../../../components/AppText";
import { useThemeColor } from "../../../lib/useThemeColor";
import type { SettingsLegalDocumentTarget, SettingsSheetTarget } from "./settings-sheet-targets";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly value?: string;
  readonly target?: SettingsSheetTarget;
  readonly fullScreenTarget?: SettingsLegalDocumentTarget;
  readonly onPress?: () => void;
}) {
  const navigation = useNavigation();
  const icon = useThemeColor("--color-icon");
  const chevron = useThemeColor("--color-chevron");
  const content = (
    <View
      className={
        props.disabled
          ? "flex-row items-center gap-4 p-4 opacity-[0.45]"
          : "flex-row items-center gap-4 p-4"
      }
    >
      <SymbolView name={props.icon} size={22} tintColor={icon} type="monochrome" weight="regular" />
      <Text className="shrink-0 text-lg text-foreground" numberOfLines={1}>
        {props.label}
      </Text>
      <View className="min-w-0 flex-1 items-end">
        {props.value ? (
          <Text
            className="max-w-[180px] text-right text-base text-foreground-muted"
            ellipsizeMode="middle"
            numberOfLines={1}
          >
            {props.value}
          </Text>
        ) : null}
      </View>
      <SymbolView
        name="chevron.right"
        size={16}
        tintColor={chevron}
        type="monochrome"
        weight="semibold"
      />
    </View>
  );

  const target = props.target;
  if (target) {
    return (
      <Pressable
        accessibilityLabel={props.label}
        accessibilityRole="button"
        disabled={props.disabled}
        onPress={() =>
          navigation.navigate("SettingsSheet", {
            screen: target,
          })
        }
      >
        {content}
      </Pressable>
    );
  }

  const fullScreenTarget = props.fullScreenTarget;
  if (fullScreenTarget) {
    return (
      <Pressable
        accessibilityLabel={props.label}
        accessibilityRole="button"
        disabled={props.disabled}
        onPress={() => navigation.navigate(fullScreenTarget)}
      >
        {content}
      </Pressable>
    );
  }

  return (
    <Pressable accessibilityRole="button" disabled={props.disabled} onPress={props.onPress}>
      {content}
    </Pressable>
  );
}
