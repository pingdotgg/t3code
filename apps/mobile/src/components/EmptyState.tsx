import { View } from "react-native";

import { AppText as Text } from "./AppText";

export function EmptyState(props: { readonly title: string; readonly detail: string }) {
  return (
    <View className="rounded-[22px] border border-border bg-card p-5">
      <Text className="font-t3-bold text-lg text-foreground">{props.title}</Text>
      <Text className="mt-2 font-sans text-sm leading-[21px] text-foreground-muted">
        {props.detail}
      </Text>
    </View>
  );
}
