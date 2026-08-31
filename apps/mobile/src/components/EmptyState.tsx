import { ActivityIndicator, Pressable, View } from "react-native";

import { AppText as Text } from "./AppText";

function EmptyStateAction(props: {
  readonly label: string;
  readonly onPress: () => void;
  readonly busy: boolean;
  readonly className: string;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ busy: props.busy, disabled: props.busy }}
      disabled={props.busy}
      className={`flex-row items-center justify-center gap-2 rounded-full bg-primary active:opacity-70 ${props.className}${props.busy ? " opacity-60" : ""}`}
      onPress={props.onPress}
    >
      {props.busy ? (
        <ActivityIndicator colorClassName={"accent-primary-foreground"} size="small" />
      ) : null}
      <Text className="text-sm font-t3-bold text-primary-foreground">{props.label}</Text>
    </Pressable>
  );
}

export function EmptyState(props: {
  readonly title: string;
  readonly detail: string;
  readonly actionLabel?: string;
  readonly onAction?: () => void;
  readonly actionBusy?: boolean;
  readonly variant?: "card" | "plain";
}) {
  if (props.variant === "plain") {
    return (
      <View className="items-center px-8 py-8">
        <Text className="text-center text-xl font-t3-bold text-foreground">{props.title}</Text>
        <Text className="mt-2 text-center font-sans text-base leading-normal text-foreground-muted">
          {props.detail}
        </Text>
        {props.actionLabel && props.onAction ? (
          <EmptyStateAction
            busy={props.actionBusy ?? false}
            className="mt-5 px-5 py-3"
            label={props.actionLabel}
            onPress={props.onAction}
          />
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
      {props.actionLabel && props.onAction ? (
        <EmptyStateAction
          busy={props.actionBusy ?? false}
          className="mt-4 self-start px-4 py-2.5"
          label={props.actionLabel}
          onPress={props.onAction}
        />
      ) : null}
    </View>
  );
}
