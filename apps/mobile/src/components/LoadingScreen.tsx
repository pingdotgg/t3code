import { ActivityIndicator, StatusBar, View, useColorScheme } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useThemeColor } from "../lib/useThemeColor";

import { AppText as Text } from "./AppText";
import { BrandMark } from "./BrandMark";

export function LoadingScreen(props: { readonly message: string }) {
  const colorScheme = useColorScheme();
  const screenBg = useThemeColor("--color-screen");
  const insets = useSafeAreaInsets();

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top }}>
      <StatusBar
        barStyle={colorScheme === "dark" ? "light-content" : "dark-content"}
        backgroundColor={screenBg as string}
        translucent
      />
      <View className="flex-1 items-center justify-center gap-5 px-6">
        <BrandMark compact />
        <ActivityIndicator size="large" />
        <Text className="font-t3-bold text-lg text-foreground">{props.message}</Text>
      </View>
    </View>
  );
}
