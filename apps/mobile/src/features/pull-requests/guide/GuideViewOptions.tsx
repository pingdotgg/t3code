import { useState } from "react";
import { Pressable } from "react-native";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { ReviewDisplayOptions } from "../../review/ReviewDisplayOptions";
import { useDiffWhitespacePreference } from "../../review/useDiffWhitespacePreference";
import { useAppearancePreferences } from "../../settings/appearance/AppearancePreferencesProvider";

/** Guide and Code share the compact switches and the same persisted display preferences. */
export function GuideViewOptions({
  open,
  onClose,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const { appearance, setCodeWordBreak } = useAppearancePreferences();
  const { ignoreWhitespace, setIgnoreWhitespace } = useDiffWhitespacePreference();
  return (
    <ReviewDisplayOptions
      open={open}
      onClose={onClose}
      options={[
        {
          id: "word-wrap",
          label: "Word wrap",
          checked: appearance.codeWordBreak,
          onChange: setCodeWordBreak,
        },
        {
          id: "hide-whitespace",
          label: "Hide whitespace changes",
          checked: ignoreWhitespace,
          onChange: setIgnoreWhitespace,
        },
      ]}
    />
  );
}

export function GuideViewOptionsButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="View options"
        onPress={() => setOpen(true)}
        className="h-11 w-11 items-center justify-center rounded-lg active:bg-grouped-card"
      >
        <SymbolView name="slider.horizontal.3" size={18} tintColorClassName="accent-icon-muted" />
      </Pressable>
      <GuideViewOptions open={open} onClose={() => setOpen(false)} />
    </>
  );
}
