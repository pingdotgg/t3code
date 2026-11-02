import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { PdfAppearance } from "@t3tools/contracts/settings";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsSection } from "../../components/SettingsSection";

const OPTIONS: ReadonlyArray<readonly [PdfAppearance, string]> = [
  ["match-app", "Match app"],
  ["original", "Original colors"],
  ["dark", "Dark"],
];

export function PdfAppearanceSection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom);
  const ready = AsyncResult.isSuccess(preferences);
  const appearance = ready ? (preferences.value.pdfAppearance ?? "match-app") : "match-app";
  return (
    <SettingsSection title="PDF appearance">
      <View accessibilityRole="radiogroup">
        {OPTIONS.map(([value, label], index) => (
          <ListChoiceRow
            key={value}
            label={label}
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
