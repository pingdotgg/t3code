import { CheckIcon, ChevronDownIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  CODE_BLOCK_LANGUAGES,
  type CodeBlockLanguage,
  codeLanguageEntry,
  codeLanguageLabel,
} from "~/composer-code-languages";
import { syntheticFileNameForLanguageId } from "~/pierre-icons";

import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
} from "../ui/combobox";
import { PierreEntryIcon } from "./PierreEntryIcon";

function LanguageIcon(props: { language: string; theme: "light" | "dark" }) {
  const fileName = props.language ? syntheticFileNameForLanguageId(props.language) : "file.txt";
  return (
    <PierreEntryIcon pathValue={fileName} kind="file" theme={props.theme} className="size-3.5" />
  );
}

export function ComposerCodeBlockLanguagePicker(props: {
  language: string;
  theme: "light" | "dark";
  disabled: boolean;
  onChange: (language: string) => void;
}) {
  const [query, setQuery] = useState("");
  const current = codeLanguageEntry(props.language)?.id ?? props.language;
  const items = useMemo<CodeBlockLanguage[]>(
    () =>
      CODE_BLOCK_LANGUAGES.some((entry) => entry.id === current)
        ? [...CODE_BLOCK_LANGUAGES]
        : [{ id: current, label: current }, ...CODE_BLOCK_LANGUAGES],
    [current],
  );
  const filteredItems = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (entry) => entry.label.toLowerCase().includes(needle) || entry.id.includes(needle),
    );
  }, [items, query]);
  const selected = items.find((entry) => entry.id === current) ?? null;

  return (
    <span className="-ml-1.5 flex min-w-0">
      <Combobox
        items={items}
        filteredItems={filteredItems}
        autoHighlight
        itemToStringLabel={(entry) => entry.label}
        isItemEqualToValue={(a, b) => a.id === b.id}
        value={selected}
        onOpenChange={(open) => {
          if (!open) setQuery("");
        }}
        onValueChange={(entry) => {
          if (entry && entry.id !== current) props.onChange(entry.id);
        }}
      >
        <ComboboxTrigger
          render={
            <Button
              type="button"
              variant="ghost-muted"
              size="xs"
              disabled={props.disabled}
              aria-label={`Code language: ${codeLanguageLabel(props.language)}`}
            />
          }
        >
          <LanguageIcon language={current} theme={props.theme} />
          <span className="max-w-40 truncate">{codeLanguageLabel(props.language)}</span>
          <ChevronDownIcon className="opacity-60" />
        </ComboboxTrigger>
        <ComboboxPopup align="start" className="w-56">
          <ComboboxSearchInput
            aria-label="Search languages"
            placeholder="Search languages"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <ComboboxEmpty>No matching languages.</ComboboxEmpty>
          <ComboboxList>
            {(entry: CodeBlockLanguage) => (
              <ComboboxItem key={entry.id || "plain"} value={entry}>
                <LanguageIcon language={entry.id} theme={props.theme} />
                <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                {entry.id === current ? <CheckIcon className="ml-auto" /> : null}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
    </span>
  );
}
