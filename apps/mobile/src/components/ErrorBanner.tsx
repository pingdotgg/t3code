import { View } from "react-native";

import { AppText as Text } from "./AppText";
export function ErrorBanner(props: { readonly message: string }) {
  return (
    <View className="rounded-2xl border border-adaptive-rose-300-a70-400-a28 bg-adaptive-rose-100-a80-500-a12 px-3.5 py-3">
      <Text className="font-t3-medium text-sm text-adaptive-rose-700-300">{props.message}</Text>
    </View>
  );
}
