import { CheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

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

const languageNames = new Intl.DisplayNames(["en"], { type: "language", fallback: "code" });

function spellcheckLanguageLabel(code: string): string {
  try {
    return languageNames.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Dictionaries the desktop main process can load; empty on web and macOS. */
export function useAvailableSpellcheckLanguages(): readonly string[] {
  const [languages, setLanguages] = useState<readonly string[]>([]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the dictionary list from the Electron main process
  useEffect(() => {
    const bridge = window.desktopBridge;
    if (!bridge) return;
    let cancelled = false;
    bridge.getSpellcheckLanguages().then(
      (available) => {
        if (!cancelled) setLanguages(available);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return languages;
}

export function SpellcheckLanguagesPicker({
  available,
  selected,
  onChange,
}: {
  available: readonly string[];
  selected: readonly string[];
  onChange: (languages: string[]) => void;
}) {
  const [query, setQuery] = useState("");
  const items = [...new Set([...selected, ...available])].toSorted((a, b) =>
    spellcheckLanguageLabel(a).localeCompare(spellcheckLanguageLabel(b)),
  );
  const needle = query.trim().toLowerCase();
  const filteredItems = needle
    ? items.filter(
        (code) =>
          code.toLowerCase().includes(needle) ||
          spellcheckLanguageLabel(code).toLowerCase().includes(needle),
      )
    : items;
  const summary =
    selected.length === 0 ? "System default" : selected.map(spellcheckLanguageLabel).join(", ");

  return (
    <Combobox
      multiple
      items={items}
      filteredItems={filteredItems}
      autoHighlight
      itemToStringLabel={spellcheckLanguageLabel}
      value={[...selected]}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      onValueChange={(next) => onChange(next)}
    >
      <ComboboxTrigger aria-label="Spellcheck languages" render={<SelectButton size="sm" />}>
        {summary}
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="w-64">
        <ComboboxSearchInput
          aria-label="Search languages"
          placeholder="Search languages…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>No matching languages.</ComboboxEmpty>
        <ComboboxList className="max-h-72">
          {(code: string) => (
            <ComboboxItem key={code} value={code} selectedFill={false}>
              <span className="min-w-0 flex-1 truncate">{spellcheckLanguageLabel(code)}</span>
              {selected.includes(code) ? <CheckIcon className="ml-auto size-3.5" /> : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
