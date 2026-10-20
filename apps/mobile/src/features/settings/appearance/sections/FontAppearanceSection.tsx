import { useState } from "react";
import { Alert, View } from "react-native";
import { useAtomSet } from "@effect/atom-react";
import * as DocumentPicker from "expo-document-picker";
import { AppText as Text } from "../../../../components/ui/AppText";
import { ListRowLayout } from "../../../../components/ui/ListRowLayout";
import { Menu } from "../../../../components/ui/Menu";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsActionRow } from "../../components/SettingsActionRow";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { FontSizeSliderRow } from "../components/FontSizeSliderRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import { updateMobilePreferencesAtom } from "../../../../state/preferences";
import { importFontFiles, deleteImportedFontFiles } from "../../../../lib/mobileFontFiles";
import {
  BUILT_IN_FONT_OPTIONS,
  DEFAULT_FONT_SELECTIONS,
  MOBILE_FONT_ROLES,
  importedFontFamilies,
  mergeImportedFonts,
  normalizeFontSelections,
  normalizeImportedFonts,
  type MobileFontRole,
  type ImportedFontFace,
} from "../../../../lib/mobileFonts";
import { MIN_BASE_FONT_SIZE, MAX_BASE_FONT_SIZE } from "../../../../lib/appearancePreferences";

const ROLES: readonly { role: MobileFontRole; label: string }[] = [
  { role: "interface", label: "Interface font" },
  { role: "reply", label: "Reply font" },
  { role: "composer", label: "Composer font" },
  { role: "code", label: "Chat code font" },
];

type SaveFontPreferences = (update: {
  readonly transform: (current: Preferences) => Partial<Preferences>;
}) => Promise<Preferences>;

async function importSelectedFonts(
  importedFonts: readonly ImportedFontFace[],
  savePreferences: SaveFontPreferences,
) {
  const picked = await DocumentPicker.getDocumentAsync({
    type: "*/*",
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (picked.canceled) return;
  await importFontFiles(picked.assets, importedFonts, async (copied) => {
    const result = await savePreferences({
      transform: (current) => ({
        importedFonts: mergeImportedFonts(normalizeImportedFonts(current.importedFonts), copied),
      }),
    });
    return normalizeImportedFonts(result.importedFonts);
  });
}

export function FontAppearanceSection() {
  const {
    isReady,
    fontSelections,
    importedFonts,
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
  const families = importedFontFamilies(importedFonts);
  const options = [
    ...BUILT_IN_FONT_OPTIONS,
    ...families.map((family) => ({ id: `imported:${family}`, label: family })),
  ];
  const report = (error: unknown) =>
    Alert.alert(
      "Custom fonts",
      error instanceof Error ? error.message : "Could not update fonts. Please try again.",
    );

  const importFonts = async () => {
    setBusy(true);
    let copied: readonly ImportedFontFace[] = [];
    let saved = false;
    try {
      const picked = await DocumentPicker.getDocumentAsync({
        type: "*/*",
        multiple: true,
        copyToCacheDirectory: true,
      });
      if (picked.canceled) return;
      copied = await copyImportedFonts(picked.assets);
      const next = mergeImportedFonts(importedFonts, copied);
      const loaded = await loadImportedFontFiles(next);
      if (loaded.unavailable.length)
        throw new Error(
          `Could not load: ${loaded.unavailable.join(", ")}. Try another static TTF or OTF font.`,
        );
      const result = await savePreferences({
        transform: (current) => ({
          importedFonts: mergeImportedFonts(normalizeImportedFonts(current.importedFonts), copied),
        }),
      });
      saved = true;
      const retained = new Set(normalizeImportedFonts(result.importedFonts).map((face) => face.id));
      deleteImportedFontFiles(
        [...importedFonts, ...copied].filter((face) => !retained.has(face.id)),
      );
    } catch (error) {
      if (!saved) deleteImportedFontFiles(copied);
      report(error);
    } finally {
      setBusy(false);
    }
  };

  const removeFamily = async (family: string) => {
    setBusy(true);
    try {
      await savePreferences({
        transform: (current) => {
          const selections = { ...normalizeFontSelections(current.fontSelections) };
          for (const role of MOBILE_FONT_ROLES)
            if (selections[role] === `imported:${family}`) selections[role] = "";
          return {
            fontSelections: selections,
            importedFonts: normalizeImportedFonts(current.importedFonts).filter(
              (face) => face.family !== family,
            ),
          };
        },
      });
      deleteImportedFontFiles(importedFonts.filter((face) => face.family === family));
    } catch (error) {
      report(error);
    } finally {
      setBusy(false);
    }
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
          Defaults follow the interface. Chat code uses a monospace default. These choices stay on
          this device.
        </Text>
      </View>
      {ROLES.map(({ role, label }) => (
        <Menu
          key={role}
          accessibilityLabel={label}
          accessibilityRole="button"
          actions={options.map((option) => ({
            id: option.id || "default",
            title: option.label,
            state: fontSelections[role] === option.id ? "on" : "off",
            attributes: { disabled: !isReady || busy },
          }))}
          onPressAction={({ nativeEvent }) =>
            setFontSelection(role, nativeEvent.event === "default" ? "" : nativeEvent.event)
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
      <SettingsActionRow
        icon="plus"
        label="Import fonts from Files"
        description="Select static TTF or OTF files, including matching bold and italic faces. Fonts are copied into this app."
        disabled={!isReady}
        loading={busy}
        onPress={() => void importFonts()}
      />
      {unavailableFonts.length ? (
        <View className="px-4 py-2">
          <Text className="text-sm text-foreground-muted">
            Unavailable fonts: {unavailableFonts.join(", ")}. Using defaults; remove or reimport
            these fonts.
          </Text>
        </View>
      ) : null}
      {families.map((family) => (
        <SettingsActionRow
          key={family}
          icon="trash"
          label={`Remove ${family}`}
          tone="danger"
          disabled={!isReady || busy}
          onPress={() =>
            Alert.alert(
              "Remove font?",
              `${family} will be removed from this device. Any settings using it will return to Default.`,
              [
                { text: "Cancel", style: "cancel" },
                { text: "Remove", style: "destructive", onPress: () => void removeFamily(family) },
              ],
            )
          }
        />
      ))}
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
