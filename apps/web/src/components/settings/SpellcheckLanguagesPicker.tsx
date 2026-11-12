import { MAX_SPELLCHECK_LANGUAGES } from "@t3tools/contracts";
import { CheckIcon } from "lucide-react";
import { useState } from "react";

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

let availableSpellcheckLanguages: readonly string[] | undefined;

/** Dictionaries the desktop main process can load; empty on web and macOS. Fixed per app session. */
export function readAvailableSpellcheckLanguages(): readonly string[] {
  availableSpellcheckLanguages ??= window.desktopBridge?.getSpellcheckLanguages() ?? [];
  return availableSpellcheckLanguages;
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
  // Stored codes without a dictionary stay in `selected` but are not shown as active.
  const active = selected.filter((code) => available.includes(code));
  const items = available.toSorted((a, b) =>
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
    active.length === 0 ? "System default" : active.map(spellcheckLanguageLabel).join(", ");

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
      onValueChange={(next) => {
        if (next.length <= MAX_SPELLCHECK_LANGUAGES) onChange(next);
      }}
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
              {active.includes(code) ? <CheckIcon className="ml-auto size-3.5" /> : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
