import { useState } from "react";
import { Alert, View } from "react-native";
import { useAtomSet } from "@effect/atom-react";
import { AppText as Text } from "../../../../components/ui/AppText";
import { ListRowLayout } from "../../../../components/ui/ListRowLayout";
import { Menu } from "../../../../components/ui/Menu";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsActionRow } from "../../components/SettingsActionRow";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { FontSizeSliderRow } from "../components/FontSizeSliderRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import { updateMobilePreferencesAtom } from "../../../../state/preferences";
import { canPickInstalledFont, pickInstalledFont } from "../../../../native/installed-fonts";
import {
  BUILT_IN_FONT_OPTIONS,
  DEFAULT_FONT_SELECTIONS,
  type MobileFontRole,
} from "../../../../lib/mobileFonts";
import { MIN_BASE_FONT_SIZE, MAX_BASE_FONT_SIZE } from "../../../../lib/appearancePreferences";

const ROLES: readonly { role: MobileFontRole; label: string }[] = [
  { role: "interface", label: "Interface font" },
  { role: "reply", label: "Reply font" },
  { role: "composer", label: "Composer font" },
  { role: "code", label: "Chat code font" },
];

export function FontAppearanceSection() {
  const {
    isReady,
    fontSelections,
    installedFonts,
    unavailableFonts,
    fonts,
    replyFontSize,
    composerFontSize,
    customReplyFontSize,
    customComposerFontSize,
    setFontSelection,
    setReplyFontSize,
    setComposerFontSize,
  } = useAppearancePreferences();
  const savePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const [busy, setBusy] = useState(false);
  const options = [
    ...BUILT_IN_FONT_OPTIONS,
    ...[...installedFonts.values()].map((font) => ({
      id: `installed:${font.name}`,
      label: font.label,
    })),
  ];
  const report = (error: unknown) =>
    Alert.alert(
      "Custom fonts",
      error instanceof Error ? error.message : "Could not update fonts. Please try again.",
    );

  const chooseInstalledFont = (role: MobileFontRole) => {
    setBusy(true);
    const selection = fontSelections[role];
    void pickInstalledFont(selection.startsWith("installed:") ? selection.slice(10) : null)
      .then((font) => {
        if (font) setFontSelection(role, `installed:${font.name}`);
      })
      .catch(report)
      .finally(() => setBusy(false));
  };

  return (
    <SettingsSection title="Fonts">
      <View className="gap-1 p-4">
        <Text
          style={{
            fontFamily: fonts.reply.regular,
            fontSize: replyFontSize,
            lineHeight: Math.round(replyFontSize * 1.45),
          }}
        >
          A reply in your selected font.
        </Text>
        <Text className="text-xs text-foreground-muted">
          Defaults follow the interface. Choose an installed font to use its matching styles. These
          choices stay on this device.
        </Text>
      </View>
      {ROLES.map(({ role, label }) => (
        <Menu
          key={role}
          accessibilityLabel={label}
          accessibilityRole="button"
          actions={[
            ...options.map((option) => ({
              id: option.id || "default",
              title: option.label,
              state: fontSelections[role] === option.id ? ("on" as const) : ("off" as const),
              attributes: { disabled: !isReady || busy },
            })),
            ...(canPickInstalledFont
              ? [
                  {
                    id: "choose-installed",
                    title: "Choose installed font…",
                    attributes: { disabled: !isReady || busy },
                  },
                ]
              : []),
          ]}
          onPressAction={({ nativeEvent }) =>
            nativeEvent.event === "choose-installed"
              ? chooseInstalledFont(role)
              : setFontSelection(role, nativeEvent.event === "default" ? "" : nativeEvent.event)
          }
        >
          <View>
            <ListRowLayout
              icon="textformat.size"
              label={label}
              detail={
                options.find((option) => option.id === fontSelections[role])?.label ?? "Unavailable"
              }
            />
          </View>
        </Menu>
      ))}
      <SettingsSwitchRow
        icon="textformat.size"
        label="Custom reply size"
        disabled={!isReady || busy}
        value={customReplyFontSize}
        onValueChange={(enabled) => setReplyFontSize(enabled ? replyFontSize : null)}
      />
      {customReplyFontSize ? (
        <FontSizeSliderRow
          icon="textformat.size"
          label="Reply size"
          min={MIN_BASE_FONT_SIZE}
          max={MAX_BASE_FONT_SIZE}
          step={1}
          value={replyFontSize}
          valueLabel={`${replyFontSize} pt`}
          onChange={setReplyFontSize}
        />
      ) : null}
      <SettingsSwitchRow
        icon="textformat.size"
        label="Custom composer size"
        disabled={!isReady || busy}
        value={customComposerFontSize}
        onValueChange={(enabled) => setComposerFontSize(enabled ? composerFontSize : null)}
      />
      {customComposerFontSize ? (
        <FontSizeSliderRow
          icon="textformat.size"
          label="Composer size"
          min={MIN_BASE_FONT_SIZE}
          max={MAX_BASE_FONT_SIZE}
          step={1}
          value={composerFontSize}
          valueLabel={`${composerFontSize} pt`}
          onChange={setComposerFontSize}
        />
      ) : null}
      {unavailableFonts.length ? (
        <View className="px-4 py-2">
          <Text className="text-sm text-foreground-muted">
            Unavailable fonts: {unavailableFonts.join(", ")}. Using defaults. Choose an installed
            font again or select Default.
          </Text>
        </View>
      ) : null}
      <SettingsActionRow
        icon="arrow.clockwise"
        label="Reset font choices and message sizes"
        disabled={!isReady || busy}
        onPress={() =>
          void savePreferences({
            fontSelections: DEFAULT_FONT_SELECTIONS,
            replyFontSize: null,
            composerFontSize: null,
          }).catch(report)
        }
      />
    </SettingsSection>
  );
}
