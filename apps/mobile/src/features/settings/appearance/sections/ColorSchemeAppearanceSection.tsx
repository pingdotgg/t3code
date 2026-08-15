import { useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../../../components/AppText";
import { SymbolView } from "../../../../components/AppSymbol";
import {
  MOBILE_APPEARANCE_OPTIONS,
  resolveMobileThemePickerOptions,
  type MobileThemePickerOption,
} from "../../../../lib/mobileTheme";
import { useThemeColor } from "../../../../lib/useThemeColor";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

function ThemePreview(props: { readonly theme: MobileThemePickerOption }) {
  return (
    <View className="h-10 flex-row overflow-hidden rounded-xl">
      {(["light", "dark"] as const).map((appearance) => (
        <View
          key={appearance}
          className="flex-1 items-center justify-center"
          style={{ backgroundColor: props.theme[appearance].canvas }}
        >
          <View
            className="size-4 rounded-full"
            style={{ backgroundColor: props.theme[appearance].accent }}
          />
        </View>
      ))}
    </View>
  );
}

function ImportThemeSheet(props: {
  readonly visible: boolean;
  readonly onClose: () => void;
  readonly onImport: (source: string) => void;
}) {
  const [source, setSource] = useState("");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setSource("");
    setError(null);
    props.onClose();
  };
  const importTheme = () => {
    try {
      props.onImport(source);
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "That theme file could not be imported.");
    }
  };

  return (
    <Modal
      animationType="slide"
      presentationStyle="pageSheet"
      visible={props.visible}
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 bg-screen"
      >
        <View className="flex-row items-center justify-between border-b border-border px-4 py-3">
          <Pressable accessibilityRole="button" className="min-h-11 justify-center" onPress={close}>
            <Text className="text-base text-foreground-secondary">Cancel</Text>
          </Pressable>
          <Text className="text-base font-t3-bold">Import theme</Text>
          <Pressable
            accessibilityRole="button"
            className="min-h-11 justify-center"
            disabled={source.trim().length === 0}
            onPress={importTheme}
          >
            <Text
              className={
                source.trim().length === 0
                  ? "text-base font-t3-medium text-foreground-tertiary"
                  : "text-base font-t3-medium text-primary"
              }
            >
              Import
            </Text>
          </Pressable>
        </View>
        <View className="flex-1 gap-3 p-4">
          <Text className="text-sm leading-normal text-foreground-secondary">
            Paste a T3 Code ThemeFile v1 JSON object. Mobile colors support hex, named colors,
            rgb()/rgba(), hsl()/hsla(), hwb(), lab(), lch(), oklab(), oklch(), and color(display-p3
            ...)/color(srgb ...).
          </Text>
          <TextInput
            multiline
            autoCapitalize="none"
            autoCorrect={false}
            spellCheck={false}
            textAlignVertical="top"
            value={source}
            onChangeText={(value) => {
              setSource(value);
              setError(null);
            }}
            className="min-h-64 flex-1 font-mono text-sm"
            placeholder={'{\n  "version": 1,\n  "name": "My theme",\n  ...\n}'}
          />
          {error ? (
            <Text
              accessibilityRole="alert"
              className="text-sm leading-normal text-danger-foreground"
            >
              {error}
            </Text>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function ColorSchemeAppearanceSection() {
  const checkmarkColor = useThemeColor("--color-primary-foreground");
  const dangerColor = String(useThemeColor("--color-danger-foreground"));
  const [importSheetVisible, setImportSheetVisible] = useState(false);
  const {
    appearanceMode,
    importedThemes,
    importThemeJson,
    isReady,
    removeImportedTheme,
    setAppearanceMode,
    setThemeId,
    themeId,
  } = useAppearancePreferences();
  const themeRows = useMemo(() => {
    const themes = resolveMobileThemePickerOptions(importedThemes);
    return Array.from({ length: Math.ceil(themes.length / 2) }, (_, index) =>
      themes.slice(index * 2, index * 2 + 2),
    );
  }, [importedThemes]);

  const confirmRemoveTheme = (theme: MobileThemePickerOption) => {
    Alert.alert("Remove theme?", `Remove ${theme.label} from this device?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => removeImportedTheme(theme.id),
      },
    ]);
  };

  return (
    <SettingsSection card title="Color scheme">
      <View className="gap-3 p-4">
        <Text className="text-sm font-t3-medium text-foreground-muted">Appearance</Text>
        <View className="flex-row gap-2">
          {MOBILE_APPEARANCE_OPTIONS.map((option) => {
            const selected = appearanceMode === option.id;
            return (
              <Pressable
                key={option.id}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected, disabled: !isReady }}
                disabled={!isReady}
                onPress={() => setAppearanceMode(option.id)}
                className={
                  selected
                    ? "min-h-11 flex-1 items-center justify-center rounded-xl bg-primary px-2"
                    : "min-h-11 flex-1 items-center justify-center rounded-xl border border-border bg-card-alt px-2"
                }
              >
                <Text
                  className={
                    selected
                      ? "text-sm font-t3-medium text-primary-foreground"
                      : "text-sm font-t3-medium text-foreground"
                  }
                >
                  {option.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <View className="h-px bg-border-subtle" />

      <View className="gap-3 p-4">
        <Text className="text-sm font-t3-medium text-foreground-muted">Theme</Text>
        <View className="gap-2">
          {themeRows.map((row) => (
            <View key={row[0]?.id} className="flex-row gap-2">
              {row.map((theme) => {
                const selected = themeId === theme.id;
                return (
                  <View
                    key={theme.id}
                    className={
                      selected
                        ? "relative min-w-0 flex-1 rounded-2xl border-2 border-primary bg-card-alt"
                        : "relative min-w-0 flex-1 rounded-2xl border border-border bg-card-alt"
                    }
                  >
                    <Pressable
                      accessibilityRole="radio"
                      accessibilityState={{ checked: selected, disabled: !isReady }}
                      disabled={!isReady}
                      onPress={() => setThemeId(theme.id)}
                      className={selected ? "gap-2 p-2.5" : "gap-2 p-3"}
                    >
                      <ThemePreview theme={theme} />
                      <View className="flex-row items-center gap-1.5">
                        <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">
                          {theme.label}
                        </Text>
                        {selected ? (
                          <View className="size-5 items-center justify-center rounded-full bg-primary">
                            <SymbolView
                              name="checkmark"
                              size={12}
                              tintColor={checkmarkColor}
                              type="monochrome"
                              weight="bold"
                            />
                          </View>
                        ) : null}
                      </View>
                    </Pressable>
                    {theme.imported ? (
                      <Pressable
                        accessibilityLabel={`Remove ${theme.label}`}
                        accessibilityRole="button"
                        className="absolute right-2 top-2 size-8 items-center justify-center rounded-full bg-danger"
                        disabled={!isReady}
                        hitSlop={6}
                        onPress={() => confirmRemoveTheme(theme)}
                      >
                        <SymbolView
                          name="trash"
                          size={13}
                          tintColor={dangerColor}
                          type="monochrome"
                        />
                      </Pressable>
                    ) : null}
                  </View>
                );
              })}
              {row.length === 1 ? <View className="flex-1" /> : null}
            </View>
          ))}
        </View>
        <Pressable
          accessibilityRole="button"
          className="min-h-11 items-center justify-center rounded-xl border border-border bg-card-alt px-3"
          disabled={!isReady}
          onPress={() => setImportSheetVisible(true)}
        >
          <Text className="text-sm font-t3-medium">Import theme</Text>
        </Pressable>
      </View>
      <ImportThemeSheet
        visible={importSheetVisible}
        onClose={() => setImportSheetVisible(false)}
        onImport={importThemeJson}
      />
    </SettingsSection>
  );
}
