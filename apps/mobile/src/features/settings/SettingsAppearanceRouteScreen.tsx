import { Platform } from "react-native";
import { startTransition, useEffect, useState } from "react";
import { AndroidNavigationAppearanceSection } from "./appearance/sections/AndroidNavigationAppearanceSection";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SettingsScreen } from "./components/SettingsScreen";
import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { TerminalAppearanceSection } from "./appearance/sections/TerminalAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";
import { ThemeAppearanceSection } from "./appearance/sections/ThemeAppearanceSection";
import { ToolCallsAppearanceSection } from "./appearance/sections/ToolCallsAppearanceSection";

export function SettingsAppearanceRouteScreen() {
  const insets = useSafeAreaInsets();
  // Theme + scheme first; secondary sections wait a frame so the push isn't blocked on previews.
  const [sectionsReady, setSectionsReady] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- defers text/terminal/code sections until after Appearance opens
  useEffect(() => {
    startTransition(() => {
      setSectionsReady(true);
    });
  }, []);

  return (
    <SettingsScreen title="Appearance" eagerBody>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <ThemeAppearanceSection />
        {sectionsReady ? (
          <>
            {Platform.OS === "android" ? <AndroidNavigationAppearanceSection /> : null}
            <TextAppearanceSection />
            <TerminalAppearanceSection />
            <CodeAppearanceSection />
            <ToolCallsAppearanceSection />
          </>
        ) : null}
      </ScrollView>
    </SettingsScreen>
  );
}
