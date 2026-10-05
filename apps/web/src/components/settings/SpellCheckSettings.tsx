import { CheckIcon } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { desktopSpellCheckStore } from "../../state/desktopSpellCheck";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { SelectButton } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const languageNames = new Intl.DisplayNames(["en"], {
  type: "language",
  languageDisplay: "standard",
});

function languageLabel(code: string): string {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * Desktop spell check languages. Renders nothing in a browser, on macOS (the
 * OS checker picks the language itself), and in desktop builds that predate
 * the bridge methods.
 */
export function SpellCheckLanguagesSetting() {
  const state = useSyncExternalStore(
    desktopSpellCheckStore.subscribe,
    desktopSpellCheckStore.getSnapshot,
  );
  const [query, setQuery] = useState("");

  useEffect(() => {
    void desktopSpellCheckStore.refresh();
  }, []);

  const options = useMemo(
    () =>
      (state?.availableLanguages ?? [])
        .map((code) => ({ code, label: languageLabel(code) }))
        .toSorted((a, b) => a.label.localeCompare(b.label)),
    [state?.availableLanguages],
  );
  const filteredCodes = useMemo(() => {
    const trimmed = query.trim().toLowerCase();
    return options
      .filter(
        (option) =>
          trimmed.length === 0 ||
          option.label.toLowerCase().includes(trimmed) ||
          option.code.toLowerCase().includes(trimmed),
      )
      .map((option) => option.code);
  }, [options, query]);

  if (state === null) return null;

  const selected = state.languages;
  const handleChange = (languages: string[]) => {
    desktopSpellCheckStore.setLanguages(languages).catch((error: unknown) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not change spell check languages",
          description: error instanceof Error ? error.message : "Spell check update failed.",
        }),
      );
    });
  };

  return (
    <SettingsRow
      {...searchableSetting("spell-check-languages")}
      description="Underline misspelled words as you type. A word passes when any selected language accepts it."
      control={
        <Combobox
          multiple
          items={options.map((option) => option.code)}
          filteredItems={filteredCodes}
          autoHighlight
          value={[...selected]}
          onValueChange={handleChange}
          onOpenChange={(open) => {
            if (open) setQuery("");
          }}
        >
          <ComboboxTrigger
            aria-label="Spell check languages"
            render={<SelectButton size="sm" className="w-full sm:w-56" />}
          >
            {selected.map(languageLabel).join(", ")}
          </ComboboxTrigger>
          <ComboboxPopup align="end" className="w-72">
            <ComboboxSearchInput
              aria-label="Search languages"
              placeholder="Search languages…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <ComboboxEmpty>No languages found.</ComboboxEmpty>
            <ComboboxList className="max-h-72">
              {filteredCodes.map((code, index) => {
                const isSelected = selected.includes(code);
                return (
                  <ComboboxItem
                    key={code}
                    hideIndicator
                    index={index}
                    value={code}
                    disabled={isSelected && selected.length === 1}
                  >
                    <span className="min-w-0 flex-1 truncate">{languageLabel(code)}</span>
                    {isSelected ? (
                      <CheckIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />
                    ) : null}
                  </ComboboxItem>
                );
              })}
            </ComboboxList>
          </ComboboxPopup>
        </Combobox>
      }
    />
  );
}
