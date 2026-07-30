import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/AppText";

export function SettingsSection(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="px-2 text-sm font-t3-medium text-foreground-muted">{props.title}</Text>
      <View
        className="overflow-hidden rounded-[28px] bg-card"
        style={{ borderCurve: "continuous" }}
      >
        {props.children}
      </View>
    </View>
  );
}
