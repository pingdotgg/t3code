import { Pressable, View } from "react-native";

import { AppText as Text } from "./AppText";

export function EmptyState(props: {
  readonly title: string;
  readonly detail: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
}) {
  return (
    <View className="rounded-[22px] border border-border bg-card p-5">
      <Text className="font-t3-bold text-lg text-foreground">{props.title}</Text>
      <Text className="mt-2 font-sans text-sm leading-[21px] text-foreground-muted">
        {props.detail}
      </Text>
      {props.actionLabel && props.onAction ? (
        <Pressable
          className="mt-4 self-start rounded-full bg-primary px-4 py-2.5 active:opacity-70"
          onPress={props.onAction}
        >
          <Text className="text-[13px] font-t3-bold text-primary-foreground">
            {props.actionLabel}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
