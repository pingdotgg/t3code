import { LegendList } from "@legendapp/list/react-native";
import {
  ISSUE_PROPERTY_PIN_LIMIT,
  formatIssuePropertyScalar,
  isEmptyIssuePropertyValue,
  isIssuePropertyObject,
  issuePropertyObjectLabel,
  visibleIssueProperties,
} from "@t3tools/client-runtime/issue-properties";
import type { IssueProperty } from "@t3tools/contracts";
import { T, useGT } from "gt-react-native";
import { useRef, useState, type ReactElement, type ReactNode } from "react";
import { Pressable, View, type TextInputInstance } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SearchField } from "../../components/ui/SearchField";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";

function IssuePropertyValue({ value }: { readonly value: IssueProperty["value"] }) {
  const gt = useGT();
  const [expanded, setExpanded] = useState(false);
  if (value === null || isEmptyIssuePropertyValue(value)) {
    return (
      <Text className="text-sm text-foreground-muted">
        <T context="an issue field with no value">None</T>
      </Text>
    );
  }
  if (typeof value !== "object") {
    return (
      <Text selectable className="text-sm text-foreground">
        {typeof value === "boolean"
          ? value
            ? gt("Yes")
            : gt("No")
          : formatIssuePropertyScalar(value)}
      </Text>
    );
  }
  if (!isIssuePropertyObject(value)) {
    return (
      <View className="gap-1">
        {value.map((entry, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- Values have no ids; the content keeps an expanded entry from passing to the next.
          <IssuePropertyValue key={`${index}:${JSON.stringify(entry)}`} value={entry} />
        ))}
      </View>
    );
  }
  const name = issuePropertyObjectLabel(value);
  if (name !== null) {
    return (
      <Text selectable className="text-sm text-foreground">
        {name}
      </Text>
    );
  }
  return (
    <View className="items-start gap-2">
      <Button
        label={expanded ? gt("Hide value") : gt("View value")}
        size="compact"
        tone="text"
        onPress={() => setExpanded(!expanded)}
      />
      {expanded
        ? Object.entries(value).map(([key, entry]) => (
            <View key={key} className="gap-1 border-l border-divider pl-3">
              <Text className="text-xs text-foreground-muted">{key}</Text>
              <IssuePropertyValue value={entry} />
            </View>
          ))
        : null}
    </View>
  );
}

export function IssuePropertyRow({
  property,
  pinned,
  disabled,
  onTogglePin,
}: {
  readonly property: IssueProperty;
  readonly pinned: boolean;
  readonly disabled: boolean;
  readonly onTogglePin: (id: string) => void;
}) {
  const gt = useGT();
  return (
    <View className="flex-row items-start gap-3 py-0.5">
      <View className="w-1/3 pt-1">
        <Text className="text-sm text-foreground-muted">{property.label}</Text>
      </View>
      <View className="min-w-0 flex-1 pt-1">
        <IssuePropertyValue value={property.value} />
      </View>
      <Pressable
        disabled={disabled}
        accessibilityRole="button"
        accessibilityState={{ disabled, selected: pinned }}
        accessibilityLabel={
          pinned
            ? gt("Unpin {field}", { field: property.label })
            : gt("Pin {field}", { field: property.label })
        }
        onPress={() => onTogglePin(property.id)}
        hitSlop={8}
        className="size-7 items-center justify-center active:opacity-70"
      >
        <SymbolView
          name={pinned ? "pin.slash" : "pin"}
          size={16}
          tintColorClassName={disabled ? "accent-icon-subtle" : "accent-foreground-muted"}
        />
      </Pressable>
    </View>
  );
}

/** Every field of the issue, searchable, below the same header the overview has. */
export function IssuePropertiesView({
  header,
  refreshControl,
  properties,
  pins,
  ready,
  onTogglePin,
}: {
  readonly header: ReactNode;
  readonly refreshControl: ReactElement;
  readonly properties: ReadonlyArray<IssueProperty>;
  readonly pins: ReadonlyArray<string>;
  readonly ready: boolean;
  readonly onTogglePin: (id: string) => void;
}) {
  const gt = useGT();
  const inputRef = useRef<TextInputInstance>(null);
  const [search, setSearch] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const visible = visibleIssueProperties(properties, search, showEmpty);
  const hasEmpty = properties.some((property) => isEmptyIssuePropertyValue(property.value));
  return (
    <LegendList
      className="flex-1"
      renderScrollComponent={NativeScrollView}
      refreshControl={refreshControl}
      recycleItems={false}
      maintainVisibleContentPosition={false}
      extraData={{ pins, ready }}
      data={visible}
      keyExtractor={(item) => item.id}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 8, paddingBottom: 24 }}
      ListHeaderComponent={
        <View className="gap-2 pb-3">
          {header}
          <View className="flex-row">
            <SearchField
              inputRef={inputRef}
              autoFocus={false}
              value={search}
              onChangeText={setSearch}
              accessibilityLabel={gt("Search issue properties")}
              clearAccessibilityLabel={gt("Clear search")}
              placeholder={gt("Search fields by name or ID")}
            />
          </View>
          <View className="min-h-10 flex-row items-center justify-between">
            <Text className="text-xs text-foreground-muted">
              {gt("{shown} of {total}", { shown: visible.length, total: properties.length })}
            </Text>
            {hasEmpty && search.trim() === "" ? (
              <Button
                size="compact"
                tone="text"
                label={showEmpty ? gt("Hide empty fields") : gt("Show empty fields")}
                onPress={() => setShowEmpty(!showEmpty)}
              />
            ) : null}
          </View>
        </View>
      }
      ListEmptyComponent={
        <Text className="py-6 text-sm text-foreground-muted">
          <T>No fields match.</T>
        </Text>
      }
      renderItem={({ item }) => {
        const pinned = pins.includes(item.id);
        return (
          <IssuePropertyRow
            property={item}
            pinned={pinned}
            disabled={!ready || (!pinned && pins.length >= ISSUE_PROPERTY_PIN_LIMIT)}
            onTogglePin={onTogglePin}
          />
        );
      }}
    />
  );
}
