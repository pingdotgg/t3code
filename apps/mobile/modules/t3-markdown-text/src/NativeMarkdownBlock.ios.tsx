import { useEffect, useState } from "react";
import { Image, ScrollView, Text, useColorScheme, View } from "react-native";
import type { MarkdownNode } from "react-native-nitro-markdown/headless";

import { CopyTextButton } from "./CopyTextButton";
import { MarkdownTextPrimitive } from "./MarkdownTextPrimitive";
import {
  nativeMarkdownDocumentRuns,
  nativeMarkdownListItemBlocks,
  nativeMarkdownTextRuns,
} from "./nativeMarkdownText";
import { NativeMarkdownSelectableText } from "./NativeMarkdownSelectableText.ios";
import type {
  MarkdownCodeHighlighter,
  MarkdownHighlightedToken,
  NativeMarkdownTextStyle,
} from "./SelectableMarkdownText.types";

type HighlightedCode = ReadonlyArray<ReadonlyArray<MarkdownHighlightedToken>>;

const highlightedCodeCache = new Map<string, HighlightedCode>();
const highlightedCodePromiseCache = new Map<string, Promise<HighlightedCode>>();
const HIGHLIGHTED_CODE_CACHE_LIMIT = 64;

function nodeKey(node: MarkdownNode, index: number): string {
  return `${node.type}:${node.beg ?? index}:${node.end ?? index}`;
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
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  return (
    <NativeMarkdownSelectableText
      runs={nativeMarkdownDocumentRuns(documentFor(props.node))}
      textStyle={props.textStyle}
    />
  );
}

function codeHighlightCacheKey(
  code: string,
  language: string | undefined,
  theme: "light" | "dark",
): string {
  return `${theme}:${language ?? "text"}:${code}`;
}

function cacheHighlightedCode(key: string, tokens: HighlightedCode): void {
  highlightedCodeCache.delete(key);
  highlightedCodeCache.set(key, tokens);

  while (highlightedCodeCache.size > HIGHLIGHTED_CODE_CACHE_LIMIT) {
    const oldestKey = highlightedCodeCache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    highlightedCodeCache.delete(oldestKey);
  }
}

function loadHighlightedCode(
  code: string,
  language: string | undefined,
  theme: "light" | "dark",
  highlightCode: MarkdownCodeHighlighter,
): Promise<HighlightedCode> {
  const key = codeHighlightCacheKey(code, language, theme);
  const cached = highlightedCodeCache.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }

  const pending = highlightedCodePromiseCache.get(key);
  if (pending) {
    return pending;
  }

  const promise = highlightCode({ code, language, theme })
    .then((tokens) => {
      cacheHighlightedCode(key, tokens);
      highlightedCodePromiseCache.delete(key);
      return tokens;
    })
    .catch((error) => {
      highlightedCodePromiseCache.delete(key);
      throw error;
    });
  highlightedCodePromiseCache.set(key, promise);
  return promise;
}

function useHighlightedCode(
  code: string,
  language: string | undefined,
  theme: "light" | "dark",
  highlightCode: MarkdownCodeHighlighter,
): HighlightedCode | null {
  const key = codeHighlightCacheKey(code, language, theme);
  const [highlighted, setHighlighted] = useState<{
    readonly key: string;
    readonly tokens: HighlightedCode | null;
  }>(() => ({
    key,
    tokens: highlightedCodeCache.get(key) ?? null,
  }));

  useEffect(() => {
    let active = true;
    const cached = highlightedCodeCache.get(key);
    if (cached) {
      cacheHighlightedCode(key, cached);
      setHighlighted({ key, tokens: cached });
      return () => {
        active = false;
      };
    }

    void loadHighlightedCode(code, language, theme, highlightCode)
      .then((tokens) => {
        if (active) {
          setHighlighted({ key, tokens });
        }
      })
      .catch(() => {
        if (active) {
          setHighlighted({ key, tokens: null });
        }
      });
    return () => {
      active = false;
    };
  }, [code, highlightCode, key, language, theme]);

  return highlighted.key === key ? highlighted.tokens : null;
}

function HighlightedCodeText(props: {
  readonly content: string;
  readonly highlighted: HighlightedCode | null;
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  if (!props.highlighted) {
    return (
      <MarkdownTextPrimitive
        uiTextView
        selectable
        style={{
          color: props.textStyle.codeColor,
          fontFamily: "ui-monospace",
          fontSize: 12,
          lineHeight: 18,
        }}
      >
        {props.content}
      </MarkdownTextPrimitive>
    );
  }
  const highlighted = props.highlighted;
  let sourceOffset = 0;
  const keyOccurrences = new Map<string, number>();
  const keyedLines = highlighted.map((line) => {
    const lineStart = sourceOffset;
    const tokens = line.map((token) => {
      const start = sourceOffset;
      sourceOffset += token.content.length;
      const signature = `${start}:${token.content}:${token.color ?? ""}:${token.fontStyle ?? ""}`;
      const occurrence = keyOccurrences.get(signature) ?? 0;
      keyOccurrences.set(signature, occurrence + 1);
      return { key: `${signature}:${occurrence}`, token };
    });
    sourceOffset += 1;
    return {
      key: `line:${lineStart}:${line.map((token) => token.content).join("")}`,
      tokens,
    };
  });

  return (
    <MarkdownTextPrimitive
      uiTextView
      selectable
      style={{
        color: props.textStyle.codeColor,
        fontFamily: "ui-monospace",
        fontSize: 12,
        lineHeight: 18,
      }}
    >
      {keyedLines.map((line, lineIndex) => (
        <MarkdownTextPrimitive key={line.key}>
          {line.tokens.map(({ key, token }) => (
            <MarkdownTextPrimitive
              key={key}
              style={{
                color: token.color ?? props.textStyle.codeColor,
                fontFamily: "ui-monospace",
                fontStyle:
                  token.fontStyle !== null && (token.fontStyle & 1) === 1 ? "italic" : "normal",
                fontWeight: token.fontStyle !== null && (token.fontStyle & 2) === 2 ? "700" : "400",
              }}
            >
              {token.content}
            </MarkdownTextPrimitive>
          ))}
          {lineIndex + 1 < keyedLines.length ? "\n" : ""}
        </MarkdownTextPrimitive>
      ))}
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
            fontFamily: "ui-monospace",
            fontSize: 12,
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
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  const rows = collectTableRows(props.node);
  return (
    <ScrollView horizontal bounces={false} showsHorizontalScrollIndicator={false}>
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
                  runs={nativeMarkdownTextRuns(cell).map((run) =>
                    rowIndex === 0 || cell.isHeader ? { ...run, bold: true } : run,
                  )}
                  textStyle={props.textStyle}
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
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  const href = props.node.href;
  if (!href) {
    return <SelectableNode node={props.node} textStyle={props.textStyle} />;
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
  readonly textStyle: NativeMarkdownTextStyle;
}) {
  return (
    <View style={{ gap: 8 }}>
      {inlineGroups(props.node.children ?? []).map((child, index) =>
        child.type === "image" ? (
          <NativeMarkdownImage
            key={nodeKey(child, index)}
            node={child}
            textStyle={props.textStyle}
          />
        ) : (
          <SelectableNode key={nodeKey(child, index)} node={child} textStyle={props.textStyle} />
        ),
      )}
    </View>
  );
}

function NativeList(props: {
  readonly node: MarkdownNode;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly depth: number;
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
            style={{ alignItems: "flex-start", flexDirection: "row" }}
          >
            <View
              style={{
                width: markerWidth,
                height: props.textStyle.lineHeight,
                marginRight: 6,
                alignItems: ordered ? "flex-end" : "center",
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
                  textStyle={props.textStyle}
                  highlightCode={props.highlightCode}
                  depth={props.depth + 1}
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
  readonly textStyle: NativeMarkdownTextStyle;
  readonly highlightCode: MarkdownCodeHighlighter;
  readonly depth?: number;
  readonly compact?: boolean;
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
              textStyle={props.textStyle}
              highlightCode={props.highlightCode}
              depth={depth}
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
      return <NativeTable node={props.node} textStyle={props.textStyle} />;
    case "image":
      return <NativeMarkdownImage node={props.node} textStyle={props.textStyle} />;
    case "horizontal_rule":
      return (
        <View
          style={{
            height: 1,
            backgroundColor: props.textStyle.dividerColor,
          }}
        />
      );
    case "blockquote":
      return (
        <View
          style={{
            borderLeftColor: props.textStyle.quoteMarkerColor,
            borderLeftWidth: 2,
            marginVertical: props.compact ? 4 : 0,
            paddingLeft: 11,
            paddingVertical: 2,
            gap: 6,
          }}
        >
          {(props.node.children ?? []).map((child, index) => (
            <NativeMarkdownBlock
              key={nodeKey(child, index)}
              node={child}
              textStyle={props.textStyle}
              highlightCode={props.highlightCode}
              depth={depth}
              compact
            />
          ))}
        </View>
      );
    case "list":
      return (
        <NativeList
          node={props.node}
          textStyle={props.textStyle}
          highlightCode={props.highlightCode}
          depth={depth}
        />
      );
    case "paragraph":
      return (props.node.children ?? []).some((child) => child.type === "image") ? (
        <NativeMixedParagraph node={props.node} textStyle={props.textStyle} />
      ) : (
        <SelectableNode node={props.node} textStyle={props.textStyle} />
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
          <SelectableNode node={props.node} textStyle={props.textStyle} />
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
              textStyle={props.textStyle}
              highlightCode={props.highlightCode}
              depth={depth}
              compact
            />
          ))}
        </View>
      );
    default:
      return <SelectableNode node={props.node} textStyle={props.textStyle} />;
  }
}
