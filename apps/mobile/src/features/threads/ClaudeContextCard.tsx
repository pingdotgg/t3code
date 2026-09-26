import {
  claudeContextSegmentColor,
  claudeContextUsedCategories,
  formatClaudeContextPercent,
  formatClaudeContextTokens,
  type ClaudeContextReport,
  type ClaudeContextSection,
} from "@t3tools/shared/claudeContextReport";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";

function SectionRow(props: { readonly section: ClaudeContextSection }) {
  const [open, setOpen] = useState(false);
  const { section } = props;
  return (
    <View>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${section.title}, ${
          section.totalTokens !== null ? `${formatClaudeContextTokens(section.totalTokens)}, ` : ""
        }${section.rows.length} ${section.rows.length === 1 ? "item" : "items"}`}
        onPress={() => setOpen((value) => !value)}
        className="min-h-11 flex-row items-center gap-2"
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={13}
          tintColorClassName="accent-icon-subtle"
          type="monochrome"
        />
        <Text className="flex-1 text-sm text-foreground" numberOfLines={1}>
          {section.title}
        </Text>
        <Text className="text-xs tabular-nums text-foreground-muted">
          {section.totalTokens !== null
            ? `${formatClaudeContextTokens(section.totalTokens)} · `
            : ""}
          {section.rows.length}
        </Text>
      </Pressable>
      {open ? (
        <View className="mb-2 ml-5 gap-1">
          {section.rows.map((row) => (
            <View key={row.join("|")} className="flex-row items-center gap-3">
              <Text selectable className="flex-1 text-xs text-foreground-secondary">
                {row
                  .slice(0, -1)
                  .map((cell, index) => `${section.columns[index]}: ${cell}`)
                  .join(" · ")}
              </Text>
              <Text className="text-xs tabular-nums text-foreground-muted">
                {section.columns.at(-1)}: {row.at(-1)}
              </Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

export function ClaudeContextCardBody(props: { readonly report: ClaudeContextReport }) {
  const { report } = props;
  const used = claudeContextUsedCategories(report);
  return (
    <View className="gap-2.5">
      <View className="h-2 flex-row overflow-hidden rounded-full bg-subtle">
        {used.length > 0 ? (
          used.map((category, index) => (
            <View
              key={category.name}
              className="h-full"
              style={{
                width: `${Math.min(100, category.percent)}%`,
                backgroundColor: claudeContextSegmentColor(index, used.length),
              }}
            />
          ))
        ) : (
          <View
            className="h-full bg-foreground"
            style={{ width: `${Math.min(100, report.usedPercent)}%` }}
          />
        )}
      </View>
      {report.overLimit ? (
        <Text className="text-xs text-danger-foreground">Over limit: {report.overLimit}</Text>
      ) : null}
      {report.categories.length > 0 ? (
        <View className="gap-1">
          {report.categories.map((category) => {
            const usedIndex = used.indexOf(category);
            return (
              <View key={category.name} className="flex-row items-center gap-2">
                <View
                  className={
                    usedIndex === -1
                      ? "size-2 rounded-full bg-subtle-strong"
                      : "size-2 rounded-full"
                  }
                  style={
                    usedIndex === -1
                      ? undefined
                      : { backgroundColor: claudeContextSegmentColor(usedIndex, used.length) }
                  }
                />
                <Text className="flex-1 text-xs text-foreground" numberOfLines={1}>
                  {category.name}
                </Text>
                <Text className="text-xs tabular-nums text-foreground-muted">
                  {category.tokens}
                </Text>
                <Text className="min-w-10 text-right text-xs tabular-nums text-foreground-secondary">
                  {formatClaudeContextPercent(category.percent)}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}
      {report.sections.length > 0 ? (
        <View className="border-t border-border-subtle pt-1">
          {report.sections.map((section) => (
            <SectionRow key={section.title} section={section} />
          ))}
        </View>
      ) : null}
    </View>
  );
}
