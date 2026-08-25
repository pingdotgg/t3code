import type { MarkdownFrontmatterEntry } from "@t3tools/client-runtime/markdown-frontmatter";
import { ScrollView, Text as NativeText, View } from "react-native";

import { useThemeColor } from "../../lib/useThemeColor";

function MarkdownFrontmatterList({
  items,
  textColor,
  backgroundColor,
}: {
  readonly items: ReadonlyArray<string>;
  readonly textColor: string;
  readonly backgroundColor: string;
}) {
  const occurrences = new Map<string, number>();

  return (
    <View className="flex-row flex-wrap gap-1">
      {items.map((item) => {
        const occurrence = occurrences.get(item) ?? 0;
        occurrences.set(item, occurrence + 1);

        return (
          <View
            key={`${item}:${occurrence}`}
            className="max-w-full rounded-sm border border-border px-2.5 py-1"
            style={{ backgroundColor }}
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
  const mutedBackgroundColor = String(useThemeColor("--color-md-blockquote-bg"));
  const codeColor = String(useThemeColor("--color-md-code-text"));

  return (
    <View className="mb-6 overflow-hidden border border-border">
      {entries.map((entry, index) => (
        <View
          key={entry.key}
          className={index === 0 ? "flex-row" : "flex-row border-t border-border"}
        >
          <View className="w-28 shrink-0 items-end border-r border-border bg-card px-3 py-2">
            <NativeText className="font-t3-bold text-sm" style={{ color: strongColor }}>
              {entry.key}
            </NativeText>
          </View>
          <View className="min-w-0 flex-1 px-3 py-2">
            {entry.value.kind === "text" ? (
              <NativeText className="font-t3-regular text-sm" style={{ color: textColor }}>
                {entry.value.text}
              </NativeText>
            ) : entry.value.kind === "list" ? (
              <MarkdownFrontmatterList
                items={entry.value.items}
                textColor={textColor}
                backgroundColor={mutedBackgroundColor}
              />
            ) : (
              <ScrollView horizontal showsHorizontalScrollIndicator={false}>
                <NativeText className="font-mono text-xs" style={{ color: codeColor }}>
                  {entry.value.source}
                </NativeText>
              </ScrollView>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}
