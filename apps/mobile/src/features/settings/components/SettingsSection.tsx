import type { ReactNode } from "react";
import { Platform, View } from "react-native";

import { AppText as Text } from "../../../components/AppText";

export function SettingsSection(props: {
  readonly title: string;
  readonly children: ReactNode;
  /** Force the grouped card background; Android otherwise lists options flat. */
  readonly card?: boolean;
}) {
  const showCard = props.card ?? Platform.OS !== "android";
  return (
    <View className="gap-2">
      <Text className="px-2 text-sm font-t3-medium text-foreground-muted">{props.title}</Text>
      <View
        className={
          showCard ? "overflow-hidden rounded-[24px] bg-card" : "overflow-hidden rounded-[24px]"
        }
        style={{ borderCurve: "continuous" }}
      >
        {props.children}
      </View>
    </View>
  );
}
