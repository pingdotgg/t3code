import { useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import type { MarkdownStyle } from "react-native-enriched-markdown";

import { Menu } from "../components/ui/Menu";
import { useMarkdownCodeHighlight } from "../features/threads/markdownCodeHighlightState";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import { resolveHighlightLanguage } from "../lib/highlightLanguage";
import type { HighlightScheme } from "../lib/highlights";
import { CodeBlockFrame, CodeBlockHeaderButton } from "./CodeBlockFrame";
import { fencedCodeMarkdown } from "./codeBlockMarkdown";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

// Fences enriched-markdown colours itself: cpp/highlight/CodeBlockLanguages.cpp entries with a default grammar.
const NATIVE_HIGHLIGHT_FENCES = new Set([
  "bash",
  "c",
  "css",
  "go",
  "golang",
  "html",
  "java",
  "javascript",
  "js",
  "json",
  "jsx",
  "markdown",
  "md",
  "py",
  "python",
  "rs",
  "rust",
  "sh",
  "shell",
  "ts",
  "tsx",
  "typescript",
  "yaml",
  "yml",
  "zsh",
]);

// The same file's header names that are not the fence capitalized.
const FENCE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  cc: "C++",
  cpp: "C++",
  cxx: "C++",
  cs: "C#",
  csharp: "C#",
  graphql: "GraphQL",
  objc: "Objective-C",
  objectivec: "Objective-C",
  php: "PHP",
  rb: "Ruby",
  scss: "SCSS",
  sql: "SQL",
  toml: "TOML",
  xml: "XML",
};

// The native block's long-press menu, with its labels and iOS symbols.
const CODE_MENU_ACTIONS = [
  { id: "copy-code", title: "Copy", image: "doc.on.doc" },
  { id: "copy-markdown", title: "Copy as Markdown", image: "doc.text" },
];

/** The highlights language for a fence enriched-markdown leaves plain, or null to keep its block. */
export function fallbackHighlightLanguage(fence: string): string | null {
  const name = fence.toLowerCase();
  if (NATIVE_HIGHLIGHT_FENCES.has(name)) return null;
  const language = resolveHighlightLanguage({ language: name });
  return language === "text" ? null : language;
}

/** A fence in a language enriched-markdown cannot colour, drawn like its native block. */
export function HighlightedCodeBlock(props: {
  readonly code: string;
  readonly fence: string;
  readonly language: string;
  /** False only while the library withholds an unclosed fence (`streamingAnimation`); highlighting waits for it. */
  readonly complete: boolean;
  readonly scheme: HighlightScheme;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly codeStyle: NonNullable<MarkdownStyle["codeBlock"]>;
}) {
  const { code, codeStyle, textStyle } = props;
  const [wrapped, setWrapped] = useState(false);
  const lines = useMarkdownCodeHighlight({
    code,
    language: props.language,
    theme: props.scheme,
    enabled: props.complete,
  });
  const fence = props.fence.toLowerCase();
  let offset = 0;
  const text = (
    // Not selectable: as in the native block, a long-press opens the copy menu instead.
    <Text
      style={{
        color: codeStyle.color,
        fontFamily: codeStyle.fontFamily,
        fontSize: codeStyle.fontSize,
        lineHeight: codeStyle.lineHeight,
      }}
    >
      {lines?.flatMap((line, lineIndex) => {
        const separator = lineIndex > 0 ? "\n" : "";
        offset += separator.length;
        return [
          separator,
          ...line.map((token) => {
            const start = offset;
            offset += token.content.length;
            return (
              <Text key={start} style={token.color ? { color: token.color } : undefined}>
                {token.content}
              </Text>
            );
          }),
        ];
      }) ?? code}
    </Text>
  );
  const padding = { padding: codeStyle.padding };
  return (
    <CodeBlockFrame
      label={FENCE_DISPLAY_NAMES[fence] ?? fence.charAt(0).toUpperCase() + fence.slice(1)}
      textStyle={textStyle}
      actions={
        <>
          <CodeBlockHeaderButton
            icon="text.alignleft"
            label={wrapped ? "Disable line wrap" : "Wrap lines"}
            textStyle={textStyle}
            active={wrapped}
            onPress={() => setWrapped((value) => !value)}
          />
          <CodeBlockHeaderButton
            icon="doc.on.doc"
            label="Copy code"
            textStyle={textStyle}
            onPress={() => copyTextWithHaptic(code)}
          />
        </>
      }
    >
      <Menu
        shouldOpenOnLongPress
        actions={CODE_MENU_ACTIONS}
        onPressAction={({ nativeEvent }) => {
          copyTextWithHaptic(
            nativeEvent.event === "copy-markdown" ? fencedCodeMarkdown(code, props.fence) : code,
          );
        }}
      >
        <Pressable>
          {wrapped ? (
            <View style={padding}>{text}</View>
          ) : (
            <ScrollView horizontal contentContainerStyle={padding}>
              {text}
            </ScrollView>
          )}
        </Pressable>
      </Menu>
    </CodeBlockFrame>
  );
}
