import { createContext, memo, useContext, useMemo } from "react";
import { Image, Platform, ScrollView, Text, useColorScheme, View } from "react-native";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import { CopyTextButton } from "./CopyTextButton";
import { MarkdownTextPrimitive } from "./MarkdownTextPrimitive";
import {
  markdownBlockDirection,
  nativeMarkdownDocumentRuns,
  nativeMarkdownListItemBlocks,
  nativeMarkdownNodePosition,
  type MarkdownWritingDirection,
} from "./nativeMarkdownText";
import { NativeMarkdownSelectableText } from "./NativeMarkdownSelectableText";
import type {
  MarkdownCodeHighlighter,
  MarkdownHighlightedToken,
  MarkdownImageRenderer,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "./SelectableMarkdownText.types";
import { useHighlightedCode, type HighlightedCode } from "./useHighlightedCode";

/** Set by SelectableMarkdownText so images anywhere in the block tree can use it. */
export const MarkdownImageRendererContext = createContext<MarkdownImageRenderer | null>(null);

const MONO_FONT_FAMILY = Platform.select({
  ios: "ui-monospace",
  android: "monospace",
  default: "monospace",
});

function nodeKey(node: MarkdownNode, index: number): string {
  return `${node.type}:${nativeMarkdownNodePosition(node, index)}`;
}

/** Code inside markdown scales with the base text size (12pt at the default 15pt body). */
function codeBlockFontSize(textStyle: NativeMarkdownTextStyle): number {
  return Math.max(10, Math.round(textStyle.fontSize * 0.8));
}

function codeBlockLineHeight(textStyle: NativeMarkdownTextStyle): number {
  return codeBlockFontSize(textStyle) + 6;
}

function nodeText(node: MarkdownNode): string {
  if (node.content !== undefined) {
    return node.content;
  }
  return (node.children ?? []).map(nodeText).join("");
}

function documentFor(node: MarkdownNode): MarkdownNode {
  return node.type === "document" ? node : { type: "document", children: [node] };
}

function SelectableNode(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
  readonly direction?: MarkdownWritingDirection;
}) {
  return (
    <NativeMarkdownSelectableText
      runs={nativeMarkdownDocumentRuns(documentFor(props.node), props.skills, props.direction)}
      textStyle={props.textStyle}
      onLinkPress={props.onLinkPress}
    />
  );
}

const HighlightedCodeLine = memo(function HighlightedCodeLine(props: {
  readonly tokens: ReadonlyArray<MarkdownHighlightedToken>;
  readonly color: string;
  readonly newline: boolean;
}) {
  let offset = 0;
  const children = [];
  for (const token of props.tokens) {
    if (!token.content) continue;
    children.push(
      <MarkdownTextPrimitive
        key={offset}
        style={{
          color: token.color ?? props.color,
          fontFamily: MONO_FONT_FAMILY,
          fontStyle: token.fontStyle !== null && (token.fontStyle & 1) === 1 ? "italic" : "normal",
          fontWeight: token.fontStyle !== null && (token.fontStyle & 2) === 2 ? "700" : "400",
        }}
      >
        {token.content}
      </MarkdownTextPrimitive>,
    );
    offset += token.content.length;
  }
  return (
    <MarkdownTextPrimitive>
      {children}
      {props.newline ? "\n" : ""}
    </MarkdownTextPrimitive>
  );
});

function HighlightedCodeText(props: {
  readonly content: string;
  readonly highlighted: HighlightedCode | null;
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  // The text root provides inherited styles through context. A new style object
  // would rerender every token even when its completed line is unchanged.
  const fontSize = codeBlockFontSize(props.textStyle);
  const lineHeight = codeBlockLineHeight(props.textStyle);
  const style = useMemo(
    () => ({
      color: props.textStyle.codeColor,
      fontFamily: MONO_FONT_FAMILY,
      fontSize,
      lineHeight,
      // Code stays LTR always — a Hebrew comment must not flip the snippet.
      writingDirection: "ltr" as const,
    }),
    [props.textStyle.codeColor, fontSize, lineHeight],
  );
  let offset = 0;
  const lines = [];
  if (props.highlighted) {
    for (const tokens of props.highlighted) {
      lines.push(
        <HighlightedCodeLine
          key={offset}
          tokens={tokens}
          color={props.textStyle.codeColor}
          newline={lines.length + 1 < props.highlighted.length}
        />,
      );
      offset += tokens.reduce((length, token) => length + token.content.length, 0) + 1;
    }
  }
  return (
    <MarkdownTextPrimitive uiTextView selectable style={style}>
      {props.highlighted ? lines : props.content}
    </MarkdownTextPrimitive>
  );
}

function NativeCodeBlock(props: {
  readonly node: MarkdownNode;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly compact?: boolean;
}) {
  const content = nodeText(props.node).replace(/\n$/, "");
  const colorScheme = useColorScheme();
  const theme = colorScheme === "dark" ? "dark" : "light";
  const highlighted = useHighlightedCode(content, props.node.language, theme, props.highlightCode);
  const languageLabel = props.node.language?.toUpperCase() ?? "CODE";
  return (
    <View
      style={{
        backgroundColor: props.textStyle.codeBlockBackgroundColor,
        borderColor: props.textStyle.dividerColor,
        borderCurve: "continuous",
        borderRadius: 10,
        borderWidth: 1,
        marginVertical: props.compact ? 7 : 0,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          minHeight: 42,
          borderBottomColor: props.textStyle.dividerColor,
          borderBottomWidth: 1,
          paddingLeft: 14,
          paddingRight: 6,
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Text
          selectable
          style={{
            flex: 1,
            color: props.textStyle.mutedColor,
            fontFamily: MONO_FONT_FAMILY,
            fontSize: codeBlockFontSize(props.textStyle),
          }}
        >
          {languageLabel}
        </Text>
        <CopyTextButton
          accessibilityLabel={`Copy ${languageLabel.toLowerCase()} code`}
          text={content}
          tintColor={props.textStyle.mutedColor}
          copiedTintColor={props.textStyle.linkColor}
          backgroundColor={props.textStyle.codeBackgroundColor}
          borderColor={props.textStyle.dividerColor}
          buttonSize={34}
          iconSize={14}
        />
      </View>
      <ScrollView
        horizontal
        bounces={false}
        nestedScrollEnabled={Platform.OS === "android"}
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 12 }}
      >
        <HighlightedCodeText
          content={content}
          highlighted={highlighted}
          textStyle={props.textStyle}
        />
      </ScrollView>
    </View>
  );
}

function collectTableRows(node: MarkdownNode): MarkdownNode[] {
  const rows: MarkdownNode[] = [];
  const visit = (child: MarkdownNode) => {
    if (child.type === "table_row") {
      rows.push(child);
      return;
    }
    for (const nested of child.children ?? []) {
      visit(nested);
    }
  };
  visit(node);
  return rows;
}

function NativeTable(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
}) {
  const rows = collectTableRows(props.node);
  return (
    <ScrollView
      horizontal
      bounces={false}
      nestedScrollEnabled={Platform.OS === "android"}
      showsHorizontalScrollIndicator={false}
    >
      <View
        style={{
          borderColor: props.textStyle.dividerColor,
          borderCurve: "continuous",
          borderRadius: 8,
          borderWidth: 1,
          overflow: "hidden",
        }}
      >
        {rows.map((row, rowIndex) => (
          <View
            key={nodeKey(row, rowIndex)}
            style={{
              flexDirection: "row",
              backgroundColor: rowIndex === 0 ? props.textStyle.codeBackgroundColor : "transparent",
              borderTopColor: props.textStyle.dividerColor,
              borderTopWidth: rowIndex === 0 ? 0 : 1,
            }}
          >
            {(row.children ?? []).map((cell, cellIndex) => (
              <View
                key={nodeKey(cell, cellIndex)}
                style={{
                  width: 160,
                  borderLeftColor: props.textStyle.dividerColor,
                  borderLeftWidth: cellIndex === 0 ? 0 : 1,
                  paddingHorizontal: 10,
                  paddingVertical: 8,
                }}
              >
                <NativeMarkdownSelectableText
                  runs={nativeMarkdownDocumentRuns(documentFor(cell), props.skills).map((run) =>
                    rowIndex === 0 || cell.isHeader ? { ...run, bold: true } : run,
                  )}
                  textStyle={props.textStyle}
                  onLinkPress={props.onLinkPress}
                />
              </View>
            ))}
          </View>
        ))}
      </View>
    </ScrollView>
  );
}

function NativeMarkdownImage(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
}) {
  const renderImage = useContext(MarkdownImageRendererContext);
  const href = props.node.href;
  if (!href) {
    return (
      <SelectableNode
        node={props.node}
        skills={props.skills}
        textStyle={props.textStyle}
        onLinkPress={props.onLinkPress}
      />
    );
  }

  if (renderImage) {
    const rendered = renderImage({
      href,
      alt: props.node.alt ?? null,
      title: props.node.title ?? null,
    });
    if (rendered != null) {
      return <>{rendered}</>;
    }
  }

  return (
    <View style={{ gap: 6 }}>
      <Image
        source={{ uri: href }}
        resizeMode="contain"
        accessibilityLabel={props.node.alt ?? props.node.title}
        style={{
          width: "100%",
          aspectRatio: 16 / 9,
          backgroundColor: props.textStyle.codeBackgroundColor,
          borderRadius: 10,
        }}
      />
      {props.node.alt ? (
        <Text
          selectable
          style={{
            color: props.textStyle.mutedColor,
            fontFamily: props.textStyle.fontFamily,
            fontSize: 12,
            lineHeight: 16,
          }}
        >
          {props.node.alt}
        </Text>
      ) : null}
    </View>
  );
}

function inlineGroups(nodes: ReadonlyArray<MarkdownNode>): MarkdownNode[] {
  const groups: MarkdownNode[] = [];
  let inline: MarkdownNode[] = [];
  const flush = () => {
    if (inline.length === 0) {
      return;
    }
    groups.push({ type: "paragraph", children: inline });
    inline = [];
  };

  for (const node of nodes) {
    if (node.type === "image") {
      flush();
      groups.push(node);
    } else {
      inline.push(node);
    }
  }
  flush();
  return groups;
}

function NativeMixedParagraph(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly onLinkPress?: (href: string) => void;
  readonly direction?: MarkdownWritingDirection;
}) {
  return (
    <View style={{ gap: 8 }}>
      {inlineGroups(props.node.children ?? []).map((child, index) =>
        child.type === "image" ? (
          <NativeMarkdownImage
            key={nodeKey(child, index)}
            node={child}
            skills={props.skills}
            textStyle={props.textStyle}
            onLinkPress={props.onLinkPress}
          />
        ) : (
          <SelectableNode
            key={nodeKey(child, index)}
            node={child}
            skills={props.skills}
            textStyle={props.textStyle}
            onLinkPress={props.onLinkPress}
            direction={props.direction}
          />
        ),
      )}
    </View>
  );
}

function NativeList(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly onLinkPress?: (href: string) => void;
  readonly depth: number;
  readonly direction?: MarkdownWritingDirection;
}) {
  const ordered = props.node.ordered ?? false;
  const start = props.node.start ?? 1;
  const nested = props.depth > 0;
  return (
    <View
      style={{
        gap: nested ? 3 : 5,
      }}
    >
      {(props.node.children ?? []).map((item, index) => {
        // Each item resolves its own direction — inherited from the enclosing
        // block, or from the item's own first strong letter — so a Hebrew item
        // in an English list still gets its marker on the right, and vice versa.
        const itemDirection = props.direction ?? markdownBlockDirection(item);
        const rtl = itemDirection === "rtl";
        const taskMarker = item.type === "task_list_item";
        const marker = taskMarker
          ? item.checked
            ? "☑︎"
            : "☐︎"
          : ordered
            ? `${start + index}.`
            : props.depth % 3 === 1
              ? "◦"
              : props.depth % 3 === 2
                ? "▪︎"
                : "•";
        const markerWidth = ordered ? 28 : taskMarker ? 20 : 18;
        const markerOffset = taskMarker ? 3 : ordered ? 0 : 2;
        return (
          <View
            key={nodeKey(item, index)}
            style={{ alignItems: "flex-start", flexDirection: rtl ? "row-reverse" : "row" }}
          >
            <View
              style={{
                width: markerWidth,
                height: props.textStyle.lineHeight,
                marginLeft: rtl ? 6 : 0,
                marginRight: rtl ? 0 : 6,
                alignItems: rtl && ordered ? "flex-start" : ordered ? "flex-end" : "center",
                justifyContent: "flex-start",
              }}
            >
              <Text
                style={{
                  color: props.textStyle.color,
                  fontFamily: props.textStyle.fontFamily,
                  fontSize: taskMarker ? 14 : props.textStyle.fontSize,
                  lineHeight: props.textStyle.lineHeight,
                  fontVariant: ordered ? ["tabular-nums"] : undefined,
                  transform: [{ translateY: markerOffset }],
                }}
              >
                {marker}
              </Text>
            </View>
            <View style={{ flex: 1, minWidth: 0, gap: 2 }}>
              {nativeMarkdownListItemBlocks(item).map((child, childIndex) => (
                <NativeMarkdownBlock
                  key={nodeKey(child, childIndex)}
                  node={child}
                  skills={props.skills}
                  textStyle={props.textStyle}
                  highlightCode={props.highlightCode}
                  onLinkPress={props.onLinkPress}
                  depth={props.depth + 1}
                  direction={itemDirection}
                  compact
                />
              ))}
            </View>
          </View>
        );
      })}
    </View>
  );
}

export function NativeMarkdownBlock(props: {
  readonly node: MarkdownNode;
  readonly skills: ReadonlyArray<SelectableMarkdownSkill>;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly onLinkPress?: (href: string) => void;
  readonly depth?: number;
  readonly compact?: boolean;
  readonly direction?: MarkdownWritingDirection;
}) {
  const depth = props.depth ?? 0;
  switch (props.node.type) {
    case "document":
      return (
        <View style={{ gap: 8 }}>
          {(props.node.children ?? []).map((child, index) => (
            <NativeMarkdownBlock
              key={nodeKey(child, index)}
              node={child}
              skills={props.skills}
              textStyle={props.textStyle}
              highlightCode={props.highlightCode}
              onLinkPress={props.onLinkPress}
              depth={depth}
              direction={props.direction}
            />
          ))}
        </View>
      );
    case "code_block":
      return (
        <NativeCodeBlock
          node={props.node}
          textStyle={props.textStyle}
          highlightCode={props.highlightCode}
          compact={props.compact}
        />
      );
    case "table":
      return (
        <NativeTable
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
        />
      );
    case "image":
      return (
        <NativeMarkdownImage
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
        />
      );
    case "horizontal_rule":
      return (
        <View
          style={{
            height: 1,
            backgroundColor: props.textStyle.dividerColor,
          }}
        />
      );
    case "blockquote": {
      // The quote bar sits on the leading edge of its own text: right for a
      // Hebrew/Arabic quote, left otherwise (per-block, like the web's dir="auto").
      const rtl = (props.direction ?? markdownBlockDirection(props.node)) === "rtl";
      return (
        <View
          style={{
            borderLeftColor: props.textStyle.quoteMarkerColor,
            borderLeftWidth: rtl ? 0 : 2,
            borderRightColor: props.textStyle.quoteMarkerColor,
            borderRightWidth: rtl ? 2 : 0,
            marginVertical: props.compact ? 4 : 0,
            paddingLeft: rtl ? 0 : 11,
            paddingRight: rtl ? 11 : 0,
            paddingVertical: 2,
            gap: 6,
          }}
        >
          {(props.node.children ?? []).map((child, index) => (
            <NativeMarkdownBlock
              key={nodeKey(child, index)}
              node={child}
              skills={props.skills}
              textStyle={props.textStyle}
              highlightCode={props.highlightCode}
              onLinkPress={props.onLinkPress}
              depth={depth}
              direction={rtl ? "rtl" : "ltr"}
              compact
            />
          ))}
        </View>
      );
    }
    case "list":
      return (
        <NativeList
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          highlightCode={props.highlightCode}
          onLinkPress={props.onLinkPress}
          depth={depth}
          direction={props.direction}
        />
      );
    case "paragraph":
      return (props.node.children ?? []).some((child) => child.type === "image") ? (
        <NativeMixedParagraph
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
          direction={props.direction}
        />
      ) : (
        <SelectableNode
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
          direction={props.direction}
        />
      );
    case "html_block":
    case "math_block":
      return (
        <View
          style={{
            marginVertical: props.compact ? 2 : 0,
            paddingHorizontal: props.node.type === "math_block" ? 10 : 0,
            paddingVertical: props.node.type === "math_block" ? 8 : 0,
            backgroundColor:
              props.node.type === "math_block"
                ? props.textStyle.codeBackgroundColor
                : "transparent",
          }}
        >
          <SelectableNode
            node={props.node}
            skills={props.skills}
            textStyle={props.textStyle}
            onLinkPress={props.onLinkPress}
          />
        </View>
      );
    case "table_head":
    case "table_body":
    case "table_row":
    case "table_cell":
    case "list_item":
    case "task_list_item":
      return (
        <View style={{ gap: 4 }}>
          {(props.node.children ?? []).map((child, index) => (
            <NativeMarkdownBlock
              key={nodeKey(child, index)}
              node={child}
              skills={props.skills}
              textStyle={props.textStyle}
              highlightCode={props.highlightCode}
              onLinkPress={props.onLinkPress}
              depth={depth}
              compact
            />
          ))}
        </View>
      );
    default:
      return (
        <SelectableNode
          node={props.node}
          skills={props.skills}
          textStyle={props.textStyle}
          onLinkPress={props.onLinkPress}
        />
      );
  }
}
