import { markdownFrontmatterProperties } from "@t3tools/shared/markdownFrontmatterProperties";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { FONT_FAMILIES } from "../../lib/fontFamilies";
import type { NativeMarkdownTextStyle } from "../../native/SelectableMarkdownText";
import { REVIEW_MONO_FONT_FAMILY } from "../review/reviewDiffRendering";

/**
 * A Markdown file's YAML frontmatter (a SKILL.md's name and description) as one
 * row per key above the rendered body. Renders nothing when there is none or
 * it does not parse, so the body alone shows as before.
 */
export function MarkdownFrontmatterTable(props: {
  readonly markdown: string;
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  // Every key cell takes the widest key's width so the values line up. Each key's own width is
  // kept by key; the table stays invisible (but laid out) until all are in, so values never jump.
  const [keyWidths, setKeyWidths] = useState<ReadonlyMap<string, number>>(() => new Map());
  const properties = markdownFrontmatterProperties(props.markdown);
  if (!properties) return null;
  const keyWidth = Math.max(0, ...keyWidths.values());
  const measured = properties.every((property) => keyWidths.has(property.key));
  const { textStyle } = props;
  const fontSize = textStyle.fontSize;
  const lineHeight = textStyle.lineHeight;

  return (
    <View accessibilityLabel="Properties" className="mb-4" style={{ opacity: measured ? 1 : 0 }}>
      {properties.map((property, index) => (
        <View
          key={property.key}
          className="flex-row gap-4 py-2"
          style={{
            borderBottomWidth: index === properties.length - 1 ? 0 : 1,
            borderBottomColor: textStyle.dividerColor,
          }}
        >
          <View style={{ maxWidth: "45%", ...(keyWidth > 0 ? { width: keyWidth } : {}) }}>
            {/* The text measures its own width (not the shared column's), and the column keeps the
                widest seen, however the layout events are batched. */}
            <Text
              selectable
              className="text-foreground-muted"
              style={{
                alignSelf: "flex-start",
                fontFamily: FONT_FAMILIES.medium,
                fontSize,
                lineHeight,
              }}
              onLayout={(event) => {
                const width = Math.ceil(event.nativeEvent.layout.width);
                setKeyWidths((current) => {
                  const previous = current.get(property.key);
                  if (previous !== undefined && previous >= width) return current;
                  return new Map(current).set(property.key, width);
                });
              }}
            >
              {property.key}
            </Text>
          </View>
          <View className="min-w-0 flex-1">
            {property.structured ? (
              <Text
                selectable
                style={{
                  alignSelf: "flex-start",
                  borderRadius: 4,
                  paddingHorizontal: 4,
                  color: textStyle.codeColor,
                  backgroundColor: textStyle.codeBackgroundColor,
                  fontFamily: REVIEW_MONO_FONT_FAMILY,
                  fontSize: fontSize * 0.9,
                  lineHeight,
                }}
              >
                {property.value}
              </Text>
            ) : (
              <Text
                selectable
                style={{
                  color: textStyle.color,
                  fontFamily: textStyle.fontFamily,
                  fontSize,
                  lineHeight,
                }}
              >
                {property.value}
              </Text>
            )}
          </View>
        </View>
      ))}
    </View>
  );
}
