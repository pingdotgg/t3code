import { MaterialListRow } from "../../../components/MaterialListRow";
import { useNavigation } from "@react-navigation/native";
import type { ComponentProps } from "react";
import { Platform, Pressable, View } from "react-native";

import { SymbolView } from "../../../components/AppSymbol";
import { AppText as Text } from "../../../components/AppText";
import type { SettingsLegalDocumentTarget, SettingsSheetTarget } from "./settings-sheet-targets";
import { cn } from "../../../lib/cn";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

export function SettingsRow(props: {
  readonly disabled?: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly value?: string;
  readonly valuePosition?: "below" | "trailing";
  readonly target?: SettingsSheetTarget;
  readonly fullScreenTarget?: SettingsLegalDocumentTarget;
  readonly onPress?: () => void;
}) {
  const navigation = useNavigation();
  if (Platform.OS === "android") {
    return (
      <MaterialListRow
        title={props.label}
        subtitle={props.valuePosition === "trailing" ? undefined : props.value}
        accessibilityLabel={[props.label, props.value].filter(Boolean).join(", ")}
        trailing={
          props.valuePosition === "trailing" && props.value ? (
            <View className="flex-row items-center gap-3">
              <Text className="text-sm text-foreground-muted">{props.value}</Text>
              <SymbolView name="chevron.right" size={16} tintColorClassName="accent-chevron" />
            </View>
          ) : undefined
        }
        disabled={props.disabled}
        leading={
          <SymbolView
            name={props.icon}
            size={24}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="regular"
          />
        }
        onPress={() => {
          if (props.target)
            navigation.navigate("SettingsSheet", {
              screen: "SettingsContent",
              params: { screen: props.target },
            });
          else if (props.fullScreenTarget) navigation.navigate(props.fullScreenTarget);
          else props.onPress?.();
        }}
      />
    );
  }
  const content = (
    <View className={cn("flex-row items-center gap-4 p-4", props.disabled && "opacity-[0.45]")}>
      <SymbolView
        name={props.icon}
        size={22}
        tintColorClassName="accent-icon"
        type="monochrome"
        weight="regular"
      />
      <>
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
      </>
      <SymbolView
        name="chevron.right"
        size={16}
        tintColorClassName="accent-chevron"
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
            screen: "SettingsContent",
            params: { screen: target },
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
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      disabled={props.disabled}
      onPress={props.onPress}
    >
      {content}
    </Pressable>
  );
}
