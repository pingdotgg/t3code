import type { ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/AppSymbol";
import { useThemeColor } from "../../lib/useThemeColor";

/**
 * Android-only wrapper that overlays a bottom-right new-task FAB on the home
 * screen. Other platforms render children unchanged.
 */
export function AndroidHomeFabLayout(props: {
  readonly onStartNewTask: () => void;
  readonly children: ReactNode;
}) {
  if (Platform.OS !== "android") {
    return <>{props.children}</>;
  }

  return <AndroidHomeFab {...props} />;
}

function AndroidHomeFab(props: {
  readonly onStartNewTask: () => void;
  readonly children: ReactNode;
}) {
  const insets = useSafeAreaInsets();
  const primaryForegroundColor = useThemeColor("--color-primary-foreground");

  return (
    <View className="flex-1">
      {props.children}
      <Pressable
        accessibilityLabel="New task"
        accessibilityRole="button"
        onPress={props.onStartNewTask}
        className="absolute right-5 size-14 items-center justify-center rounded-full bg-primary shadow-lg"
        style={{
          bottom: Math.max(insets.bottom, 16) + 16,
        }}
      >
        <SymbolView
          name="square.and.pencil"
          size={22}
          tintColor={primaryForegroundColor}
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}
