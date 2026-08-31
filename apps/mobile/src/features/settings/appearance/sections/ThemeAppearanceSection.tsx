import { memo, useId } from "react";
import { Pressable, View } from "react-native";
import Svg, { Circle, Defs, RadialGradient, Stop } from "react-native-svg";
import { ScopedTheme } from "uniwind";

import { mixThemePreviewBase, THEME_PREVIEW_RENDER_SPECS } from "@t3tools/shared/themePreview";

import { SymbolView } from "../../../../components/AppSymbol";
import { AppText as Text } from "../../../../components/AppText";
import {
  getMobileThemePreviewColors,
  MOBILE_THEME_OPTIONS,
  type MobileThemeAppearance,
  type MobileThemeId,
  type MobileThemeIds,
  type MobileThemeMode,
} from "../../../../lib/mobileTheme";
import { getMobileUniwindThemeName } from "../../../../lib/mobileThemeRuntime";
import { cn } from "../../../../lib/cn";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

const APPEARANCE_MODES: ReadonlyArray<{
  readonly id: MobileThemeMode;
  readonly label: string;
}> = [
  { id: "system", label: "System" },
  { id: "light", label: "Light" },
  { id: "dark", label: "Dark" },
];

const previewPercentage = (value: number) => `${value * 100}%`;

const PreviewOrb = memo(function PreviewOrb(props: {
  readonly appearance: MobileThemeAppearance;
  readonly compact?: boolean;
  readonly themeId: MobileThemeId;
}) {
  const idPrefix = useId().replaceAll(":", "");
  const accentGradientId = `${idPrefix}-accent-glow`;
  const actionGradientId = `${idPrefix}-action-glow`;
  const colors = getMobileThemePreviewColors(props.themeId, props.appearance);
  const spec = THEME_PREVIEW_RENDER_SPECS[props.appearance];
  const accentRadius = Math.hypot(
    Math.max(spec.accent.center[0], 1 - spec.accent.center[0]),
    Math.max(spec.accent.center[1], 1 - spec.accent.center[1]),
  );
  const actionRadius = Math.hypot(
    Math.max(spec.action.center[0], 1 - spec.action.center[0]),
    Math.max(spec.action.center[1], 1 - spec.action.center[1]),
  );
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
            cx={previewPercentage(spec.accent.center[0])}
            cy={previewPercentage(spec.accent.center[1])}
            fx={previewPercentage(spec.accent.center[0])}
            fy={previewPercentage(spec.accent.center[1])}
            id={accentGradientId}
            r={previewPercentage(accentRadius)}
          >
            <Stop offset="0%" stopColor={colors.accent} stopOpacity={1} />
            <Stop
              offset={previewPercentage(spec.accent.middleOffset)}
              stopColor={colors.accent}
              stopOpacity={spec.accent.middleOpacity}
            />
            <Stop
              offset={previewPercentage(spec.accent.endOffset)}
              stopColor={colors.accent}
              stopOpacity={0}
            />
            <Stop offset="100%" stopColor={colors.accent} stopOpacity={0} />
          </RadialGradient>
          <RadialGradient
            cx={previewPercentage(spec.action.center[0])}
            cy={previewPercentage(spec.action.center[1])}
            fx={previewPercentage(spec.action.center[0])}
            fy={previewPercentage(spec.action.center[1])}
            id={actionGradientId}
            r={previewPercentage(actionRadius)}
          >
            <Stop
              offset="0%"
              stopColor={colors.messageAction}
              stopOpacity={spec.action.startOpacity}
            />
            <Stop
              offset={previewPercentage(spec.action.endOffset)}
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
  readonly themeId: MobileThemeId;
}) {
  const choice = (appearance: MobileThemeAppearance, selected: boolean) => (
    <Pressable
      accessibilityHint={`Sets the ${appearance} appearance only`}
      accessibilityLabel={`${props.label} ${appearance} theme`}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled, selected }}
      className={cn(
        "size-[66px] items-center justify-center rounded-full border-[3px] active:scale-[0.94]",
        selected ? "border-primary" : "border-transparent",
      )}
      disabled={props.disabled}
      onPress={() => props.onSelect(appearance)}
    >
      <PreviewOrb appearance={appearance} compact themeId={props.themeId} />
      {selected ? (
        <View className="absolute -bottom-0.5 -right-0.5 size-5 items-center justify-center rounded-full border border-border bg-card">
          <SymbolView
            name={appearance === "light" ? "sun.max" : "moon"}
            size={12}
            tintColorClassName="accent-icon"
            type="monochrome"
            weight="medium"
          />
        </View>
      ) : null}
    </Pressable>
  );

  return (
    <View className="min-w-36 flex-1 basis-[47%] gap-3 rounded-[24px] border border-border bg-card px-2 py-4">
      <Pressable
        accessibilityHint="Sets both light and dark appearances"
        accessibilityLabel={`${props.label} theme`}
        accessibilityRole="button"
        accessibilityState={{
          disabled: props.disabled,
          selected: props.lightSelected && props.darkSelected,
        }}
        className="absolute inset-0 rounded-[24px] active:bg-subtle"
        disabled={props.disabled}
        onPress={props.onSelectBoth}
      />
      <View className="flex-row items-center justify-center gap-2 py-1" pointerEvents="box-none">
        {choice("light", props.lightSelected)}
        {choice("dark", props.darkSelected)}
      </View>
      <Text
        className="min-w-0 flex-1 px-1 text-lg font-t3-medium"
        numberOfLines={1}
        pointerEvents="none"
      >
        {props.label}
      </Text>
    </View>
  );
}

function PreviewPane(props: { readonly compact?: boolean }) {
  return (
    <View className="flex-1 overflow-hidden bg-screen">
      <View
        className={cn("bg-card", props.compact ? "h-[18px] gap-0.5 px-1" : "h-[18px] gap-1 px-1.5")}
      >
        <View className="mt-2 flex-row items-center gap-1">
          <View className="size-1.5 rounded-full bg-primary" />
          <View className="h-1 flex-1 rounded-full bg-foreground-muted" />
        </View>
      </View>
      <View
        className={
          props.compact ? "flex-1 justify-between px-1 py-2" : "flex-1 justify-between px-1.5 py-2"
        }
      >
        <View className="gap-1">
          <View className="h-1.5 w-[72%] rounded-full bg-subtle-strong" />
          <View className="h-1.5 w-[46%] rounded-full bg-subtle-strong" />
        </View>
        <View className="items-end gap-1 pb-2">
          <View className="h-3 w-[78%] rounded-full bg-user-bubble" />
          <View className="h-1 w-[38%] rounded-full bg-foreground-muted" />
        </View>
      </View>
    </View>
  );
}

function ModePreview(props: { readonly mode: MobileThemeMode; readonly themeIds: MobileThemeIds }) {
  if (props.mode === "system") {
    return (
      <View className="h-24 w-14 self-center rounded-[16px] border-[1.5px] border-border bg-drawer p-[3px]">
        <View className="flex-1 flex-row overflow-hidden rounded-[11px]">
          <ScopedTheme theme={getMobileUniwindThemeName(props.themeIds.light, "light")}>
            <PreviewPane compact />
          </ScopedTheme>
          <ScopedTheme theme={getMobileUniwindThemeName(props.themeIds.dark, "dark")}>
            <PreviewPane compact />
          </ScopedTheme>
        </View>
        <View className="absolute bottom-[6px] left-1/2 h-1 w-4 -translate-x-1/2 rounded-full bg-foreground-muted" />
      </View>
    );
  }

  return (
    <ScopedTheme theme={getMobileUniwindThemeName(props.themeIds[props.mode], props.mode)}>
      <View className="h-24 w-14 self-center rounded-[16px] border-[1.5px] border-border bg-drawer p-[3px]">
        <View className="flex-1 flex-row overflow-hidden rounded-[11px]">
          <PreviewPane />
        </View>
        <View className="absolute bottom-[6px] left-1/2 h-1 w-4 -translate-x-1/2 rounded-full bg-foreground-muted" />
      </View>
    </ScopedTheme>
  );
}

function ModeCard(props: {
  readonly disabled: boolean;
  readonly label: string;
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
      className={cn(
        "min-w-0 flex-1 gap-2 rounded-[24px] p-2 active:scale-[0.97]",
        props.selected ? "border-2 border-primary bg-subtle" : "border border-border bg-card",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <ModePreview mode={props.mode} themeIds={props.themeIds} />
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

export function ThemeAppearanceSection() {
  const {
    isReady,
    setThemeIdForAppearance,
    setThemeIdForBothAppearances,
    setThemeMode,
    themeIds,
    themeMode,
  } = useAppearancePreferences();

  return (
    <View className="gap-6">
      <View className="gap-2">
        <SectionLabel>Color scheme</SectionLabel>
        <View accessibilityRole="radiogroup" className="flex-row gap-2">
          {APPEARANCE_MODES.map((mode) => (
            <ModeCard
              disabled={!isReady}
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
          {MOBILE_THEME_OPTIONS.map((theme) => (
            <ThemeCard
              disabled={!isReady}
              key={theme.id}
              label={theme.label}
              darkSelected={theme.id === themeIds.dark}
              lightSelected={theme.id === themeIds.light}
              onSelect={(appearance) => setThemeIdForAppearance(appearance, theme.id)}
              onSelectBoth={() => setThemeIdForBothAppearances(theme.id)}
              themeId={theme.id}
            />
          ))}
        </View>
      </View>
    </View>
  );
}
