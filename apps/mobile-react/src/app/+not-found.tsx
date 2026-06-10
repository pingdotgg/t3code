import { Link } from "expo-router";
import { Pressable, ScrollView, StyleSheet } from "react-native";
import { useResolveClassNames } from "uniwind";

import { AppText as Text } from "../components/AppText";

export default function NotFoundRoute() {
  const screenBgStyle = StyleSheet.flatten(useResolveClassNames("bg-screen"));
  const primaryBgStyle = StyleSheet.flatten(useResolveClassNames("bg-primary"));

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{
        flexGrow: 1,
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        paddingHorizontal: 24,
        paddingVertical: 32,
      }}
      style={[{ flex: 1 }, screenBgStyle]}
    >
      <Text className="text-[28px] font-t3-bold text-foreground" selectable>
        Route not found
      </Text>
      <Link href="/" asChild>
        <Pressable
          style={[
            {
              borderRadius: 999,
              paddingHorizontal: 20,
              paddingVertical: 14,
            },
            primaryBgStyle,
          ]}
        >
          <Text className="text-[16px] font-t3-bold text-primary-foreground">Return home</Text>
        </Pressable>
      </Link>
    </ScrollView>
  );
}
