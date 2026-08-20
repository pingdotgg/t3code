import { memo, useId, useMemo, useState } from "react";
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, View } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";

import { mixThemePreviewBase, THEME_PREVIEW_RENDER_SPECS } from "@t3tools/shared/themePreview";

import { SymbolView } from "../../../../components/AppSymbol";
import { AppText as Text } from "../../../../components/AppText";
import { AppTextInput as TextInput } from "../../../../components/AppText";
import {
  getMobileThemeVariables,
  getMobileThemePreviewColors,
  MOBILE_THEME_OPTIONS,
  mobileThemeHasAppearance,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeIds,
  type MobileThemeMode,
  type MobileThemeVariables,
} from "../../../../lib/mobileTheme";
import type { ImportedMobileTheme } from "../../../../lib/mobileThemeFile";
import { useThemeColor } from "../../../../lib/useThemeColor";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

const APPEARANCE_MODES: ReadonlyArray<{
  readonly id: MobileThemeMode;
  readonly label: string;
}> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const PreviewOrb = memo(function PreviewOrb(props: {
  readonly appearance: MobileThemeAppearance;
  readonly compact?: boolean;
  readonly themeId: MobileThemeId;
  readonly importedThemes: ReadonlyArray<ImportedMobileTheme>;
}) {
  const idPrefix = useId().replaceAll(":", "");
  const accentGradientId = `${idPrefix}-accent-glow`;
  const actionGradientId = `${idPrefix}-action-glow`;
  const colors = getMobileThemePreviewColors(props.themeId, props.appearance, props.importedThemes);
  const spec = THEME_PREVIEW_RENDER_SPECS[props.appearance];
  const accentRadius = Math.hypot(
    Math.max(spec.accent.center[0], 1 - spec.accent.center[0]),
    Math.max(spec.accent.center[1], 1 - spec.accent.center[1]),
  );
  const actionRadius = Math.hypot(
    Math.max(spec.action.center[0], 1 - spec.action.center[0]),
    Math.max(spec.action.center[1], 1 - spec.action.center[1]),
  );
  const position = (value: number) => `${value * 100}%`;
  const radius = (value: number) => `${value * 100}%`;

  return (
    <View
      className={`${props.compact ? "size-14" : "size-16"} overflow-hidden rounded-full border`}
      style={{
        borderColor:
          props.appearance === "dark" ? "rgba(255, 255, 255, 0.14)" : "rgba(0, 0, 0, 0.1)",
      }}
    >
      <Svg accessibilityElementsHidden height="100%" viewBox="0 0 64 64" width="100%">
        <Defs>
          <RadialGradient
            cx={position(spec.accent.center[0])}
            cy={position(spec.accent.center[1])}
            fx={position(spec.accent.center[0])}
            fy={position(spec.accent.center[1])}
            id={accentGradientId}
            r={radius(accentRadius)}
          >
            <Stop offset="0%" stopColor={colors.accent} stopOpacity={1} />
            <Stop
              offset={position(spec.accent.middleOffset)}
              stopColor={colors.accent}
              stopOpacity={spec.accent.middleOpacity}
            />
            <Stop
              offset={position(spec.accent.endOffset)}
              stopColor={colors.accent}
              stopOpacity={0}
            />
            <Stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient
            cx={position(spec.action.center[0])}
            cy={position(spec.action.center[1])}
            fx={position(spec.action.center[0])}
            fy={position(spec.action.center[1])}
            id={actionGradientId}
            r={radius(actionRadius)}
          >
            <Stop
              offset="0%"
              stopColor={colors.messageAction}
              stopOpacity={spec.action.startOpacity}
            />
            <Stop
              offset={position(spec.action.endOffset)}
              stopColor={colors.messageAction}
              stopOpacity={0}
            />
            <Stop offset="100%" stopColor={colors.messageAction} stopOpacity={0} />
          </RadialGradient>
        </Defs>
        <Circle cx="32" cy="32" fill={mixThemePreviewBase(colors, props.appearance)} r="32" />
        <Circle cx="32" cy="32" fill={`url(#${actionGradientId})`} r="32" />
        <Circle cx="32" cy="32" fill={`url(#${accentGradientId})`} r="32" />
      </Svg>
    </View>
  );
});

function ThemeCard(props: {
  readonly disabled: boolean;
  readonly darkSelected: boolean;
  readonly label: string;
  readonly lightSelected: boolean;
  readonly onSelectBoth: () => void;
  readonly onSelect: (appearance: MobileThemeAppearance) => void;
  readonly onRemove?: () => void;
  readonly themeId: MobileThemeId;
  readonly importedThemes: ReadonlyArray<ImportedMobileTheme>;
}) {
  const badgeBackground = useThemeColor("--color-card");
  const badgeIcon = useThemeColor("--color-icon");
  const selectBothDisabled =
    props.disabled ||
    !mobileThemeHasAppearance(props.themeId, "light", props.importedThemes) ||
    !mobileThemeHasAppearance(props.themeId, "dark", props.importedThemes);

  const choice = (appearance: MobileThemeAppearance, selected: boolean) => {
    const available = mobileThemeHasAppearance(props.themeId, appearance, props.importedThemes);
    return (
      <Pressable
        accessibilityLabel={`${props.label} ${appearance} theme`}
        accessibilityRole="radio"
        accessibilityState={{ checked: selected, disabled: props.disabled || !available }}
        className={
          selected
            ? "size-[66px] items-center justify-center rounded-full border-[3px] border-primary"
            : "size-[66px] items-center justify-center rounded-full border-[3px] border-transparent"
        }
        disabled={props.disabled || !available}
        onPress={() => props.onSelect(appearance)}
      >
        <PreviewOrb
          appearance={appearance}
          compact
          importedThemes={props.importedThemes}
          themeId={props.themeId}
        />
        {selected ? (
          <View
            className="absolute -bottom-0.5 -right-0.5 size-5 items-center justify-center rounded-full border border-border"
            style={{ backgroundColor: badgeBackground }}
          >
            <SymbolView
              name={appearance === "light" ? "sun.max" : "moon"}
              size={12}
              tintColor={badgeIcon}
              type="monochrome"
              weight="medium"
            />
          </View>
        ) : null}
      </Pressable>
    );
  };

  return (
    <View className="min-w-36 flex-1 basis-[47%] gap-3 rounded-[24px] border border-border bg-card px-2 py-4">
      <Pressable
        accessibilityHint="Sets both light and dark appearances"
        accessibilityLabel={`${props.label} theme`}
        accessibilityRole="button"
        accessibilityState={{ disabled: selectBothDisabled }}
        className="absolute inset-0 rounded-[24px] active:bg-subtle"
        disabled={selectBothDisabled}
        onPress={props.onSelectBoth}
      />
      <View className="flex-row items-center justify-center gap-2 py-1" pointerEvents="box-none">
        {choice("light", props.lightSelected)}
        {choice("dark", props.darkSelected)}
      </View>
      <View className="min-h-8 flex-row items-center" pointerEvents="none">
        <Text className="min-w-0 flex-1 text-lg font-t3-medium" numberOfLines={1}>
          {props.label}
        </Text>
      </View>
      {props.onRemove ? (
        <Pressable
          accessibilityLabel={`Remove ${props.label}`}
          accessibilityRole="button"
          className="min-h-9 items-center justify-center rounded-xl bg-danger"
          disabled={props.disabled}
          onPress={props.onRemove}
        >
          <Text className="text-sm font-t3-medium text-danger-foreground">Remove</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function PreviewPane(props: { readonly colors: MobileThemeVariables; readonly compact?: boolean }) {
  return (
    <View
      className="flex-1 overflow-hidden"
      style={{ backgroundColor: props.colors["--color-screen"] }}
    >
      <View
        className={props.compact ? "h-[18px] gap-0.5 px-1" : "h-[18px] gap-1 px-1.5"}
        style={{ backgroundColor: props.colors["--color-card"] }}
      >
        <View className="mt-2 flex-row items-center gap-1">
          <View
            className="size-1.5 rounded-full"
            style={{ backgroundColor: props.colors["--color-primary"] }}
          />
          <View
            className="h-1 flex-1 rounded-full"
            style={{ backgroundColor: props.colors["--color-foreground-muted"] }}
          />
        </View>
      </View>
      <View
        className={
          props.compact ? "flex-1 justify-between px-1 py-2" : "flex-1 justify-between px-1.5 py-2"
        }
      >
        <View className="gap-1">
          <View
            className="h-1.5 w-[72%] rounded-full"
            style={{ backgroundColor: props.colors["--color-subtle-strong"] }}
          />
          <View
            className="h-1.5 w-[46%] rounded-full"
            style={{ backgroundColor: props.colors["--color-subtle-strong"] }}
          />
        </View>
        <View className="items-end gap-1 pb-2">
          <View
            className="h-3 w-[78%] rounded-full"
            style={{ backgroundColor: props.colors["--color-user-bubble"] }}
          />
          <View
            className="h-1 w-[38%] rounded-full"
            style={{ backgroundColor: props.colors["--color-foreground-muted"] }}
          />
        </View>
      </View>
    </View>
  );
}

function ModePreview(props: {
  readonly importedThemes: ReadonlyArray<ImportedMobileTheme>;
  readonly mode: MobileThemeMode;
  readonly themeIds: MobileThemeIds;
}) {
  const light = getMobileThemeVariables(props.themeIds.light, "light", null, props.importedThemes);
  const dark = getMobileThemeVariables(props.themeIds.dark, "dark", null, props.importedThemes);
  const currentBorder = useThemeColor("--color-border");
  const currentFrame = useThemeColor("--color-drawer");
  const currentIndicator = useThemeColor("--color-foreground-muted");
  const frameColor =
    props.mode === "light"
      ? light["--color-border"]
      : props.mode === "dark"
        ? dark["--color-border"]
        : currentBorder;
  const frameBackground =
    props.mode === "light"
      ? light["--color-drawer"]
      : props.mode === "dark"
        ? dark["--color-drawer"]
        : currentFrame;
  const indicatorColor =
    props.mode === "light"
      ? light["--color-foreground-muted"]
      : props.mode === "dark"
        ? dark["--color-foreground-muted"]
        : currentIndicator;

  return (
    <View
      className="h-24 w-14 self-center rounded-[16px] p-[3px]"
      style={{ backgroundColor: frameBackground, borderColor: frameColor, borderWidth: 1.5 }}
    >
      <View className="flex-1 flex-row overflow-hidden rounded-[11px]">
        {props.mode === "system" ? (
          <>
            <PreviewPane colors={light} compact />
            <PreviewPane colors={dark} compact />
          </>
        ) : (
          <PreviewPane colors={props.mode === "light" ? light : dark} />
        )}
      </View>
      <View
        className="absolute bottom-[6px] left-1/2 h-1 w-4 -translate-x-1/2 rounded-full"
        style={{ backgroundColor: indicatorColor }}
      />
    </View>
  );
}

function ModeCard(props: {
  readonly disabled: boolean;
  readonly label: string;
  readonly importedThemes: ReadonlyArray<ImportedMobileTheme>;
  readonly mode: MobileThemeMode;
  readonly onPress: () => void;
  readonly selected: boolean;
  readonly themeIds: MobileThemeIds;
}) {
  return (
    <Pressable
      accessibilityLabel={`${props.label} appearance`}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      className={
        props.selected
          ? "min-w-0 flex-1 gap-2 rounded-[24px] border-2 border-primary bg-subtle p-2"
          : "min-w-0 flex-1 gap-2 rounded-[24px] border border-border bg-card p-2"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <ModePreview
        importedThemes={props.importedThemes}
        mode={props.mode}
        themeIds={props.themeIds}
      />
      <Text
        className={
          props.selected
            ? "text-center text-base font-t3-bold text-foreground"
            : "text-center text-base text-foreground-muted"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

function SectionLabel({ children }: { readonly children: string }) {
  return <Text className="px-2 text-sm font-t3-medium text-foreground-muted">{children}</Text>;
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
            Paste a T3 Code ThemeFile v1 JSON object. Mobile accepts the same literal CSS colors as
            the web app.
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
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {error}
            </Text>
          ) : null}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

export function ThemeAppearanceSection() {
  const [importSheetVisible, setImportSheetVisible] = useState(false);
  const {
    importedThemes,
    importThemeJson,
    isReady,
    removeImportedTheme,
    setThemeIdForAppearance,
    setThemeIdForBothAppearances,
    setThemeMode,
    themeIds,
    themeMode,
  } = useAppearancePreferences();
  const themeOptions = useMemo(
    () => [
      ...MOBILE_THEME_OPTIONS,
      ...importedThemes.map((theme) => ({ id: theme.id, label: theme.name })),
    ],
    [importedThemes],
  );

  const confirmRemoveTheme = (theme: ImportedMobileTheme) => {
    Alert.alert("Remove theme?", `Remove ${theme.name} from this device?`, [
      { text: "Cancel", style: "cancel" },
      {
        text: "Remove",
        style: "destructive",
        onPress: () => removeImportedTheme(theme.id),
      },
    ]);
  };

  return (
    <View className="gap-6">
      <View className="gap-2">
        <SectionLabel>Color scheme</SectionLabel>
        <View accessibilityRole="radiogroup" className="flex-row gap-2">
          {APPEARANCE_MODES.map((mode) => (
            <ModeCard
              disabled={!isReady}
              importedThemes={importedThemes}
              key={mode.id}
              label={mode.label}
              mode={mode.id}
              onPress={() => setThemeMode(mode.id)}
              selected={mode.id === themeMode}
              themeIds={themeIds}
            />
          ))}
        </View>
      </View>

      <View className="gap-3">
        <SectionLabel>Themes</SectionLabel>
        <View className="flex-row flex-wrap gap-3">
          {themeOptions.map((theme) => {
            const imported = importedThemes.find((candidate) => candidate.id === theme.id);
            return (
              <ThemeCard
                disabled={!isReady}
                key={theme.id}
                label={theme.label}
                importedThemes={importedThemes}
                darkSelected={theme.id === themeIds.dark}
                lightSelected={theme.id === themeIds.light}
                onSelect={(appearance) => setThemeIdForAppearance(appearance, theme.id)}
                onSelectBoth={() => setThemeIdForBothAppearances(theme.id)}
                onRemove={imported ? () => confirmRemoveTheme(imported) : undefined}
                themeId={theme.id}
              />
            );
          })}
        </View>
        <Pressable
          accessibilityRole="button"
          className="min-h-11 items-center justify-center rounded-xl border border-border bg-card"
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
    </View>
  );
}
