import { ActivityIndicator, StatusBar, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAppearancePreferences } from "../features/settings/appearance/AppearancePreferencesProvider";

import { AppText as Text } from "./AppText";
import { BrandMark } from "./BrandMark";

export function LoadingScreen(props: {
  readonly message: string;
  readonly messagePlacement?: "above-spinner" | "below-spinner";
}) {
  const { themeAppearance: colorScheme } = useAppearancePreferences();
  const insets = useSafeAreaInsets();
  const messagePlacement = props.messagePlacement ?? "below-spinner";

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <StatusBar barStyle={colorScheme === "dark" ? "light-content" : "dark-content"} translucent />
      <View className="flex-1 items-center justify-center gap-5 px-6">
        <BrandMark compact />
        {messagePlacement === "above-spinner" ? (
          <Text className="font-t3-bold text-lg text-foreground">{props.message}</Text>
        ) : null}
        <ActivityIndicator size="large" />
        {messagePlacement === "below-spinner" ? (
          <Text className="font-t3-bold text-lg text-foreground">{props.message}</Text>
        ) : null}
      </View>
    </View>
  );
}
