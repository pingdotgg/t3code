import { type ReactNode, useState } from "react";
import { TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import { ListSection } from "../../components/ui/ListSection";

const SHOWN_ROWS = 6;

type CatalogEntry = { readonly id: string; readonly name: string };

/**
 * Searchable pick from a provider catalog, such as its models or voices, by name or id. Shows a
 * few rows until searched or expanded, and keeps the choice in view.
 */
export function CatalogPicker<Entry extends CatalogEntry>({
  items,
  value,
  onChange,
  disabled = false,
  title,
  footer,
  searchLabel,
  placeholder,
  empty,
  showAllLabel,
  describe,
}: {
  items: ReadonlyArray<Entry>;
  value: string;
  onChange: (entry: Entry) => void;
  disabled?: boolean;
  title?: string;
  footer?: string | undefined;
  searchLabel: string;
  placeholder: string;
  empty: ReactNode;
  showAllLabel: (count: number) => string;
  /** The line under each name; model slugs by default. */
  describe?: (entry: Entry) => string | undefined;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const needle = query.trim().toLowerCase();
  const selected = items.find((entry) => entry.id === value);
  const matches = items.filter((entry) =>
    `${entry.name} ${entry.id}`.toLowerCase().includes(needle),
  );
  const shown = showAll ? matches : matches.slice(0, SHOWN_ROWS);
  const row = (entry: Entry) => {
    const description = describe ? describe(entry) : entry.id;
    return (
      <ListChoiceRow
        key={entry.id}
        label={entry.name}
        {...(description && description !== entry.name ? { description } : {})}
        selected={entry.id === value}
        separated
        disabled={disabled}
        onPress={() => onChange(entry)}
      />
    );
  };
  return (
    <ListSection {...(title ? { title } : {})} {...(footer ? { footer } : {})}>
      <View className="px-4 py-3">
        <TextInput
          accessibilityLabel={searchLabel}
          placeholder={placeholder}
          autoCapitalize="none"
          autoCorrect={false}
          editable={!disabled}
          value={query}
          onChangeText={setQuery}
          className="rounded-lg bg-background px-3 py-2 text-foreground"
        />
      </View>
      {selected && !shown.some((entry) => entry.id === selected.id) ? row(selected) : null}
      {shown.map(row)}
      {matches.length === 0 ? (
        <Separated>
          <Text className="px-4 py-3 text-sm text-foreground-muted">{empty}</Text>
        </Separated>
      ) : matches.length > shown.length ? (
        <Separated>
          <ListActionRow label={showAllLabel(matches.length)} onPress={() => setShowAll(true)} />
        </Separated>
      ) : null}
    </ListSection>
  );
}

/** A hairline above a row that has no `separated` prop of its own. */
function Separated({ children }: { children: ReactNode }) {
  return <View className="border-t border-border-subtle">{children}</View>;
}
