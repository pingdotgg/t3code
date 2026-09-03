import { Pressable, View } from "react-native";

import { AppText as Text } from "./AppText";

export interface ErrorBannerAction {
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
}

export function ErrorBanner(props: {
  readonly message: string;
  readonly action?: ErrorBannerAction;
}) {
  return (
    <View className="rounded-2xl border border-adaptive-rose-300-a70-400-a28 bg-adaptive-rose-100-a80-500-a12 px-3.5 py-3">
      <Text className="font-t3-medium text-sm text-adaptive-rose-700-300">{props.message}</Text>
      {props.action ? (
        <Pressable
          accessibilityRole="button"
          className="mt-2 self-start rounded-lg px-1 py-0.5 active:opacity-70 disabled:opacity-50"
          disabled={props.action.disabled}
          onPress={props.action.onPress}
        >
          <Text className="font-t3-bold text-sm text-adaptive-rose-700-300 underline">
            {props.action.label}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
