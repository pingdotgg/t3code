import { type ThemeDefinition } from "@t3tools/themes";
import { Pressable, ScrollView, View } from "react-native";

import { AppText as Text } from "../../../../components/AppText";
import { cn } from "../../../../lib/cn";
import type { MobileAppearanceMode } from "../AppearancePreferencesProvider";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import { SettingsSection } from "../../components/SettingsSection";
import { buildThemePickerItems } from "../themePickerItems";

const APPEARANCE_OPTIONS: ReadonlyArray<{
  readonly label: string;
  readonly value: MobileAppearanceMode;
}> = [
  { label: "System", value: "system" },
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
];

function ThemeSwatch(props: { readonly theme: ThemeDefinition }) {
  const colors = props.theme.colors;
  return (
    <View className="h-12 w-[128px] overflow-hidden rounded-[12px] border border-border">
      <View className="flex-1 flex-row" style={{ backgroundColor: colors.sidebar }}>
        <View className="w-5" style={{ backgroundColor: colors.sidebarRowSelected }} />
        <View className="flex-1 p-1.5" style={{ backgroundColor: colors.canvas }}>
          <View className="h-1.5 w-8 rounded-full" style={{ backgroundColor: colors.textMuted }} />
          <View className="mt-1.5 h-4 rounded-md" style={{ backgroundColor: colors.surface }}>
            <View
              className="mt-1 ml-auto h-2 w-6 rounded-full"
              style={{ backgroundColor: colors.messageAction }}
            />
          </View>
        </View>
      </View>
      <View className="h-1.5" style={{ backgroundColor: colors.accent }} />
    </View>
  );
}

export function ThemeAppearanceSection() {
  const { appearanceMode, isReady, setAppearanceMode, setThemeId, themeId } =
    useAppearancePreferences();
  const items = buildThemePickerItems();

  return (
    <SettingsSection card title="Theme">
      <View className="gap-3 p-4">
        <View className="flex-row items-center justify-between">
          <Text className="text-lg text-foreground">Appearance</Text>
          <Text className="text-sm text-foreground-muted">
            {appearanceMode === "system" ? "System" : appearanceMode === "light" ? "Light" : "Dark"}
          </Text>
        </View>
        <View className="flex-row gap-1 rounded-[12px] bg-subtle p-1">
          {APPEARANCE_OPTIONS.map((option) => {
            const selected = appearanceMode === option.value;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="button"
                accessibilityState={{ disabled: !isReady, selected }}
                className={cn(
                  "flex-1 items-center rounded-[9px] px-2 py-2",
                  selected ? "bg-primary" : "bg-transparent",
                  !isReady && "opacity-[0.45]",
                )}
                disabled={!isReady}
                onPress={() => setAppearanceMode(option.value)}
              >
                <Text
                  className={cn(
                    "text-sm font-t3-medium",
                    selected ? "text-primary-foreground" : "text-foreground-muted",
                  )}
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
      <View className="h-px bg-separator" />
      <View className="gap-1 px-4 pt-3">
        <Text className="text-lg text-foreground">Color theme</Text>
        <Text className="text-sm text-foreground-muted">
          Choose a built-in palette for every screen, terminal, and diff.
        </Text>
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerClassName="gap-3 p-4"
      >
        {items.map((item) => {
          const selected = themeId === item.id;
          return (
            <Pressable
              key={item.id}
              accessibilityLabel={`${item.label} theme`}
              accessibilityRole="button"
              accessibilityState={{ disabled: !isReady, selected }}
              className={cn(
                "w-[128px] gap-2 rounded-[14px] p-1",
                selected ? "bg-accent-surface" : "bg-transparent",
                !isReady && "opacity-[0.45]",
              )}
              disabled={!isReady}
              onPress={() => setThemeId(item.id)}
            >
              <ThemeSwatch theme={item.definition} />
              <Text
                className={cn(
                  "px-1 pb-1 text-sm font-t3-medium",
                  selected ? "text-foreground" : "text-foreground-muted",
                )}
                numberOfLines={1}
              >
                {item.label}
              </Text>
            </Pressable>
          );
        })}
      </ScrollView>
    </SettingsSection>
  );
}
