import { useState, type ComponentProps } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../../components/AppSymbol";
import { AppText as Text, AppTextInput } from "../../../../components/AppText";
import {
  createUserBubbleOverrides,
  getMobileThemeVariables,
  normalizeUserBubbleColor,
} from "../../../../lib/mobileTheme";
import { useThemeColor } from "../../../../lib/useThemeColor";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import { AppearancePreviewSeparator } from "../components/AppearancePreviews";
import { HsvColorPicker } from "../components/HsvColorPicker";

type SymbolName = ComponentProps<typeof SymbolView>["name"];

const BUBBLE_COLOR_PRESETS = ["#34c759", "#af52de", "#ff9500"] as const;
const TEXT_COLOR_PRESETS = ["#ffffff", "#000000"] as const;

/** Live sample of a sent message using the effective bubble and text colors. */
function SentMessagePreview() {
  const bubbleColor = useThemeColor("--color-user-bubble");
  const textColor = useThemeColor("--color-user-bubble-foreground");

  return (
    <View className="items-end p-4">
      <View
        className="max-w-[85%] rounded-[20px] px-3.5 py-2.5"
        style={{ backgroundColor: bubbleColor }}
      >
        <Text className="text-base" style={{ color: String(textColor) }}>
          Make the sidebar remember its width.
        </Text>
      </View>
    </View>
  );
}

function ColorSwatch(props: {
  readonly color: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly selected: boolean;
  readonly icon?: SymbolName;
  readonly iconColor?: string;
}) {
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="radio"
      accessibilityState={{ checked: props.selected, disabled: props.disabled }}
      className={
        props.selected
          ? "size-11 items-center justify-center rounded-full border-[3px] border-primary"
          : "size-11 items-center justify-center rounded-full border-[3px] border-transparent"
      }
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <View
        className="size-8 items-center justify-center rounded-full border border-border"
        style={{ backgroundColor: props.color }}
      >
        {props.icon ? (
          <SymbolView
            name={props.icon}
            size={14}
            tintColor={props.iconColor}
            type="monochrome"
            weight="medium"
          />
        ) : null}
      </View>
    </Pressable>
  );
}

/**
 * Default swatch + presets + custom, in the same circular style as the theme
 * pickers. Selecting custom reveals a hex field without changing the stored
 * color until a valid value is typed, so it stays reachable even when the
 * current color matches a preset.
 */
function ColorSwatchRow(props: {
  readonly defaultColor: string;
  readonly defaultLabel: string;
  readonly disabled: boolean;
  readonly icon: SymbolName;
  readonly label: string;
  readonly onChange: (value: string | null) => void;
  readonly presets: readonly string[];
  readonly value: string | null;
}) {
  const iconColor = useThemeColor("--color-icon");
  const subtleIconColor = String(useThemeColor("--color-icon-muted"));
  const customSurface = String(useThemeColor("--color-subtle"));
  const [customSelected, setCustomSelected] = useState(false);
  const isCustomValue = props.value !== null && !props.presets.includes(props.value);
  const isCustom = customSelected || isCustomValue;

  const commitCustom = (text: string) => {
    const normalized = normalizeUserBubbleColor(text);
    if (normalized !== null) props.onChange(normalized);
  };

  return (
    <View className={props.disabled ? "gap-3 p-4 opacity-[0.45]" : "gap-3 p-4"}>
      <View className="flex-row items-center gap-4">
        <SymbolView
          name={props.icon}
          size={22}
          tintColor={iconColor}
          type="monochrome"
          weight="regular"
        />
        <Text className="flex-1 text-lg text-foreground">{props.label}</Text>
        <Text className="text-base font-t3-medium text-foreground-muted">
          {props.value === null ? props.defaultLabel : props.value.toUpperCase()}
        </Text>
      </View>
      <View accessibilityRole="radiogroup" className="flex-row flex-wrap items-center gap-2">
        <ColorSwatch
          color={props.defaultColor}
          disabled={props.disabled}
          label={`${props.defaultLabel} ${props.label.toLowerCase()}`}
          onPress={() => {
            setCustomSelected(false);
            props.onChange(null);
          }}
          selected={props.value === null && !customSelected}
        />
        {props.presets.map((preset) => (
          <ColorSwatch
            color={preset}
            disabled={props.disabled}
            key={preset}
            label={`${props.label} ${preset}`}
            onPress={() => {
              setCustomSelected(false);
              props.onChange(preset);
            }}
            selected={props.value === preset && !customSelected}
          />
        ))}
        <ColorSwatch
          color={isCustomValue && props.value !== null ? props.value : customSurface}
          disabled={props.disabled}
          icon={isCustomValue ? undefined : "plus"}
          iconColor={subtleIconColor}
          label={`Custom ${props.label.toLowerCase()}`}
          onPress={() => setCustomSelected(true)}
          selected={isCustom}
        />
      </View>
      {isCustom ? (
        <View className="gap-3">
          <HsvColorPicker
            disabled={props.disabled}
            onChange={props.onChange}
            value={props.value ?? props.defaultColor}
          />
          <AppTextInput
            accessibilityLabel={`Custom ${props.label.toLowerCase()} hex value`}
            autoCapitalize="none"
            autoComplete="off"
            autoCorrect={false}
            defaultValue={props.value ?? ""}
            key={props.value}
            onEndEditing={(event) => commitCustom(event.nativeEvent.text)}
            onSubmitEditing={(event) => commitCustom(event.nativeEvent.text)}
            placeholder="#4F46E5"
            returnKeyType="done"
          />
        </View>
      ) : null}
    </View>
  );
}

export function MessageAppearanceSection() {
  const {
    isReady,
    setUserBubbleColor,
    setUserBubbleTextColor,
    themeAppearance,
    themeId,
    userBubbleColor,
    userBubbleTextColor,
  } = useAppearancePreferences();

  const base = getMobileThemeVariables(themeId, themeAppearance);
  const themeBubbleColor = base["--color-user-bubble"];
  // What the text falls back to when unset: the theme foreground on a themed
  // bubble, or black/white by contrast on a custom one.
  const autoTextColor =
    createUserBubbleOverrides(base, userBubbleColor, null)?.["--color-user-bubble-foreground"] ??
    base["--color-user-bubble-foreground"];

  return (
    <SettingsSection card title="Sent messages">
      <SentMessagePreview />
      <AppearancePreviewSeparator />
      <ColorSwatchRow
        defaultColor={themeBubbleColor}
        defaultLabel="Theme"
        disabled={!isReady}
        icon="paintbrush"
        label="Bubble color"
        onChange={setUserBubbleColor}
        presets={BUBBLE_COLOR_PRESETS}
        value={userBubbleColor}
      />
      <ColorSwatchRow
        defaultColor={autoTextColor}
        defaultLabel="Auto"
        disabled={!isReady}
        icon="textformat.size"
        label="Text color"
        onChange={setUserBubbleTextColor}
        presets={TEXT_COLOR_PRESETS}
        value={userBubbleTextColor}
      />
    </SettingsSection>
  );
}
