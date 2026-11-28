import type { ReactNode } from "react";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  useComboboxFilter,
} from "../ui/combobox";

type CatalogEntry = { readonly id: string; readonly name: string };

/** Searchable pick from a provider catalog, such as its models or voices, by name or id. */
export function CatalogCombobox<Entry extends CatalogEntry>({
  items,
  value,
  onChange,
  disabled = false,
  id,
  label,
  placeholder,
  empty,
  showIds = true,
}: {
  items: ReadonlyArray<Entry>;
  value: string;
  onChange: (next: string) => void;
  disabled?: boolean;
  id?: string;
  label: string;
  placeholder: string;
  empty: ReactNode;
  /** Shows each entry's id under its name, for ids people search by, such as model slugs. */
  showIds?: boolean;
}) {
  const { contains } = useComboboxFilter();
  return (
    <Combobox
      items={items}
      itemToStringLabel={(entry: Entry) => entry.name}
      itemToStringValue={(entry: Entry) => entry.id}
      filter={(entry: Entry, query) => contains(entry.name, query) || contains(entry.id, query)}
      value={items.find((entry) => entry.id === value) ?? null}
      onValueChange={(entry) => onChange(entry?.id ?? "")}
      autoHighlight
      disabled={disabled}
    >
      <ComboboxInput id={id} aria-label={label} placeholder={placeholder} size="sm" />
      <ComboboxPopup>
        <ComboboxEmpty>{empty}</ComboboxEmpty>
        <ComboboxList scrollAreaClassName="max-h-64">
          {(entry: Entry) => (
            <ComboboxItem key={entry.id} value={entry}>
              <span className="flex min-w-0 flex-col">
                <span className="truncate">{entry.name}</span>
                {showIds && entry.id && entry.id !== entry.name && (
                  <span className="truncate text-xs text-muted-foreground">{entry.id}</span>
                )}
              </span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
