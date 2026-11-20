import { msg, useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import type { MarkdownStyle } from "react-native-enriched-markdown";

import { Menu } from "../components/ui/Menu";
import { useMarkdownCodeHighlight } from "../features/threads/markdownCodeHighlightState";
import { copyTextWithHaptic } from "../lib/copyTextWithHaptic";
import type { HighlightScheme } from "../lib/highlights";
import { CodeBlockFrame, CodeBlockHeaderButton, useCopiedFlash } from "./CodeBlockFrame";
import { fencedCodeMarkdown } from "./codeBlockMarkdown";
import type { NativeMarkdownTextStyle } from "./SelectableMarkdownText.types";

// Header names from enriched-markdown's CodeBlockLanguages.cpp that are not the fence capitalized.
const FENCE_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  css: "CSS",
  html: "HTML",
  js: "JavaScript",
  json: "JSON",
  jsx: "JSX",
  md: "Markdown",
  py: "Python",
  rs: "Rust",
  sh: "Shell",
  ts: "TypeScript",
  tsx: "TSX",
  typescript: "TypeScript",
  javascript: "JavaScript",
  yaml: "YAML",
  yml: "YAML",
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
  {
    id: "copy-code",
    title: msg("Copy", { $context: "verb, copies the code" }),
    image: "doc.on.doc",
  },
  { id: "copy-markdown", title: msg("Copy as Markdown"), image: "doc.text" },
];

const CODE_INSET = 14;

/** A fence in a language enriched-markdown cannot colour, drawn like its native block. */
export function HighlightedCodeBlock(props: {
  readonly code: string;
  readonly fence: string;
  readonly language: string;
  /** False only while the library withholds an unclosed fence (`streamingAnimation`, which T3 never enables, so always true today); highlighting waits for it. */
  readonly complete: boolean;
  readonly scheme: HighlightScheme;
  readonly textStyle: NativeMarkdownTextStyle;
  readonly codeStyle: NonNullable<MarkdownStyle["codeBlock"]>;
}) {
  const { code, codeStyle, textStyle } = props;
  const gt = useGT();
  const resolve = useMessages();
  const [wrapped, setWrapped] = useState(false);
  const [viewportWidth, setViewportWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const { copied, flash } = useCopiedFlash();
  // Wrapping only matters for a line that overflows; a wrapped block keeps the toggle to undo it.
  const canWrap = wrapped || contentWidth > viewportWidth + 1;
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
  // Inside the scroller: on iOS an ancestor JS responder disables a ScrollView's panning.
  const content = (
    <Menu
      shouldOpenOnLongPress
      actions={CODE_MENU_ACTIONS.map((action) => ({ ...action, title: resolve(action.title) }))}
      style={{ flexGrow: 1 }}
      onPressAction={({ nativeEvent }) => {
        copyTextWithHaptic(
          nativeEvent.event === "copy-markdown" ? fencedCodeMarkdown(code, props.fence) : code,
        );
      }}
    >
      <Pressable
        style={{ paddingHorizontal: CODE_INSET, paddingTop: 2, paddingBottom: CODE_INSET }}
      >
        {text}
      </Pressable>
    </Menu>
  );
  return (
    <CodeBlockFrame
      // A fence without a language reads "Text", as on desktop, so the header row is never empty.
      label={
        fence.length === 0
          ? gt("Text")
          : (FENCE_DISPLAY_NAMES[fence] ?? fence.charAt(0).toUpperCase() + fence.slice(1))
      }
      textStyle={textStyle}
      actions={
        <>
          {canWrap ? (
            <CodeBlockHeaderButton
              icon="arrow.turn.down.left"
              label={wrapped ? gt("Disable line wrap") : gt("Wrap lines")}
              textStyle={textStyle}
              active={wrapped}
              onPress={() => setWrapped((value) => !value)}
            />
          ) : null}
          <CodeBlockHeaderButton
            icon={copied ? "checkmark" : "doc.on.doc"}
            label={gt("Copy code")}
            textStyle={textStyle}
            onPress={() => {
              copyTextWithHaptic(code);
              flash();
            }}
          />
        </>
      }
    >
      {wrapped ? (
        content
      ) : (
        <ScrollView
          horizontal
          // As in the thread feed: with the keyboard open, the first long-press reaches the copy menu.
          keyboardShouldPersistTaps="always"
          contentContainerStyle={{ flexGrow: 1 }}
          onLayout={({ nativeEvent }) => setViewportWidth(nativeEvent.layout.width)}
          onContentSizeChange={setContentWidth}
        >
          {content}
        </ScrollView>
      )}
    </CodeBlockFrame>
  );
}
