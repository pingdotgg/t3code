import { MAX_SPELLCHECK_LANGUAGES } from "@t3tools/contracts";
import { useGT, useLocale } from "gt-react";
import { CheckIcon } from "lucide-react";
import { useId, useState } from "react";

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

const languageNamesByLocale = new Map<string, Intl.DisplayNames>();

function spellcheckLanguageLabel(code: string, locale: string): string {
  try {
    let languageNames = languageNamesByLocale.get(locale);
    if (!languageNames) {
      languageNames = new Intl.DisplayNames([locale], { type: "language", fallback: "code" });
      languageNamesByLocale.set(locale, languageNames);
    }
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
  const gt = useGT();
  const locale = useLocale();
  const summaryId = useId();
  const label = (code: string) => spellcheckLanguageLabel(code, locale);
  const [query, setQuery] = useState("");
  // Stored codes without a dictionary stay in `selected` but are not shown as active.
  const active = selected.filter((code) => available.includes(code));
  const items = available.toSorted((a, b) => label(a).localeCompare(label(b), locale));
  const needle = query.trim().toLowerCase();
  const filteredItems = needle
    ? items.filter(
        (code) => code.toLowerCase().includes(needle) || label(code).toLowerCase().includes(needle),
      )
    : items;
  const summary = active.length === 0 ? gt("System default") : active.map(label).join(", ");

  return (
    <Combobox
      multiple
      items={items}
      filteredItems={filteredItems}
      autoHighlight
      itemToStringLabel={label}
      value={[...selected]}
      onOpenChange={(open) => {
        if (!open) setQuery("");
      }}
      onValueChange={(next) => {
        if (next.length <= MAX_SPELLCHECK_LANGUAGES) onChange(next);
      }}
    >
      <ComboboxTrigger
        aria-label={gt("Spellcheck languages")}
        aria-describedby={summaryId}
        render={<SelectButton size="sm" />}
      >
        <span id={summaryId}>{summary}</span>
      </ComboboxTrigger>
      <ComboboxPopup align="end" className="w-64">
        <ComboboxSearchInput
          aria-label={gt("Search languages")}
          placeholder={gt("Search languages…")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <ComboboxEmpty>{gt("No matching languages.")}</ComboboxEmpty>
        <ComboboxList className="max-h-72">
          {(code: string) => (
            <ComboboxItem
              key={code}
              value={code}
              selectedFill={false}
              disabled={selected.length >= MAX_SPELLCHECK_LANGUAGES && !selected.includes(code)}
            >
              <span className="min-w-0 flex-1 truncate">{label(code)}</span>
              {active.includes(code) ? <CheckIcon className="ml-auto size-3.5" /> : null}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
