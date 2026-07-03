import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { TerminalAppearanceSection } from "./appearance/sections/TerminalAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";

export function SettingsAppearanceRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        style={{ flex: 1 }}
        contentContainerStyle={{
          gap: 24,
          paddingBottom: Math.max(insets.bottom, 18) + 18,
          paddingHorizontal: 20,
          paddingTop: 16,
        }}
      >
        <TextAppearanceSection />
        <TerminalAppearanceSection />
        <CodeAppearanceSection />
      </ScrollView>
    </View>
  );
}
