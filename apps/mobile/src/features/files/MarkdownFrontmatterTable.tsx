import type { MarkdownFrontmatterEntry } from "@t3tools/client-runtime/markdown-frontmatter";
import { useState } from "react";
import { ScrollView, Text as NativeText, View } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";

const MIN_KEY_COLUMN_WIDTH = 160;
const MIN_VALUE_COLUMN_WIDTH = 400;

function MarkdownFrontmatterList({
  items,
  textColor,
}: {
  readonly items: ReadonlyArray<string>;
  readonly textColor: string;
}) {
  const occurrences = new Map<string, number>();

  return (
    <View className="flex-row flex-wrap gap-1">
      {items.map((item) => {
        const occurrence = occurrences.get(item) ?? 0;
        occurrences.set(item, occurrence + 1);

        return (
          <View
            key={JSON.stringify([item, occurrence])}
            className="max-w-full rounded-full border border-secondary-border bg-secondary px-2.5 py-1"
          >
            <NativeText className="font-t3-regular text-sm" style={{ color: textColor }}>
              {item}
            </NativeText>
          </View>
        );
      })}
    </View>
  );
}

export function MarkdownFrontmatterTable({
  entries,
}: {
  readonly entries: ReadonlyArray<MarkdownFrontmatterEntry>;
}) {
  const textColor = String(useThemeColor("--color-md-body"));
  const strongColor = String(useThemeColor("--color-md-strong"));
  const codeColor = String(useThemeColor("--color-md-code-text"));
  const [keyWidths, setKeyWidths] = useState<ReadonlyMap<string, number>>(() => new Map());
  let measuredKeyColumnWidth = MIN_KEY_COLUMN_WIDTH;
  let hasEveryKeyWidth = true;
  for (const entry of entries) {
    const keyWidth = keyWidths.get(entry.key);
    if (keyWidth === undefined) {
      hasEveryKeyWidth = false;
      break;
    }
    measuredKeyColumnWidth = Math.max(measuredKeyColumnWidth, keyWidth);
  }
  const keyColumnWidth = hasEveryKeyWidth ? measuredKeyColumnWidth : null;

  return (
    <ScrollView
      horizontal
      className="mb-6"
      contentContainerStyle={{ minWidth: "100%" }}
      showsHorizontalScrollIndicator={false}
    >
      <View
        className="flex-1 overflow-hidden border border-border"
        style={{ minWidth: (keyColumnWidth ?? MIN_KEY_COLUMN_WIDTH) + MIN_VALUE_COLUMN_WIDTH }}
      >
        {entries.map((entry, index) => (
          <View
            key={entry.key}
            className={index === 0 ? "flex-row" : "flex-row border-t border-border"}
          >
            <View
              className="min-w-40 shrink-0 items-end justify-center border-r border-border bg-card px-3 py-2"
              style={keyColumnWidth === null ? undefined : { width: keyColumnWidth }}
              onLayout={
                keyColumnWidth === null
                  ? (event) => {
                      const measuredWidth = Math.ceil(event.nativeEvent.layout.width);
                      setKeyWidths((current) => {
                        if (current.get(entry.key) === measuredWidth) {
                          return current;
                        }
                        const next = new Map(current);
                        next.set(entry.key, measuredWidth);
                        return next;
                      });
                    }
                  : undefined
              }
            >
              <NativeText
                numberOfLines={1}
                className="font-t3-bold text-sm"
                style={{ color: strongColor }}
              >
                {entry.key}
              </NativeText>
            </View>
            <View className="min-w-0 flex-1 px-3 py-2">
              {entry.value.kind === "text" ? (
                <NativeText className="font-t3-regular text-sm" style={{ color: textColor }}>
                  {entry.value.text}
                </NativeText>
              ) : entry.value.kind === "list" ? (
                <MarkdownFrontmatterList items={entry.value.items} textColor={textColor} />
              ) : (
                <NativeText className="font-mono text-xs" style={{ color: codeColor }}>
                  {entry.value.source}
                </NativeText>
              )}
            </View>
          </View>
        ))}
      </View>
    </ScrollView>
  );
}
