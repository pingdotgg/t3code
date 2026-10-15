import { View } from "react-native";
import type { ReactNode } from "react";

import { AppText as Text } from "./AppText";
import { Button } from "./Button";

export function EmptyState(props: {
  readonly title: string;
  readonly detail: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly action?: ReactNode;
  readonly variant?: "card" | "plain";
}) {
  if (props.variant === "plain") {
    return (
      <View className="items-center px-8 py-8">
        <Text className="text-center text-xl font-t3-bold text-foreground">{props.title}</Text>
        <Text className="mt-2 text-center font-sans text-base leading-normal text-foreground-muted">
          {props.detail}
        </Text>
        {props.action ? (
          <View className="mt-5">{props.action}</View>
        ) : props.actionLabel && props.onAction ? (
          <View className="mt-5">
            <Button tone="primary" label={props.actionLabel} onPress={props.onAction} />
          </View>
        ) : null}
      </View>
    );
  }

  return (
    <View className="rounded-[22px] border border-border bg-card p-5">
      <Text className="font-t3-bold text-lg text-foreground">{props.title}</Text>
      <Text className="mt-2 font-sans text-sm leading-relaxed text-foreground-muted">
        {props.detail}
      </Text>
      {props.action ? (
        <View className="mt-4 self-start">{props.action}</View>
      ) : props.actionLabel && props.onAction ? (
        <View className="mt-4 self-start">
          <Button tone="primary" label={props.actionLabel} onPress={props.onAction} />
        </View>
      ) : null}
    </View>
  );
}
