import { msg, useGT, useMessages } from "gt-react-native";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { PdfAppearance } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsSection } from "../../components/SettingsSection";

const OPTIONS: ReadonlyArray<readonly [PdfAppearance, string]> = [
  ["match-app", msg("Match theme")],
  ["original", msg("Original colors")],
  ["dark", msg("Inverted colors")],
];

export function PdfAppearanceSection() {
  const gt = useGT();
  const m = useMessages();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences);
  const appearance = ready ? (preferences.value.pdfAppearance ?? "match-app") : "match-app";
  return (
    <SettingsSection title={gt("PDF colors")}>
      <View accessibilityRole="radiogroup">
        {OPTIONS.map(([value, label], index) => (
          <ListChoiceRow
            key={value}
            label={m(label)}
            disabled={!ready}
            selected={appearance === value}
            onPress={() => updatePreferences({ pdfAppearance: value })}
            separated={index > 0}
          />
        ))}
      </View>
    </SettingsSection>
  );
}
