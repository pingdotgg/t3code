import { useMemo } from "react";
import { View } from "react-native";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";

import {
  nativeMarkdownChunkSpacing,
  nativeMarkdownDocumentChunks,
  nativeMarkdownDocumentRuns,
  nativeMarkdownWithPreservedSoftBreaks,
} from "./nativeMarkdownText";
import { NativeMarkdownBlock } from "./NativeMarkdownBlock.ios";
import { NativeMarkdownSelectableText } from "./NativeMarkdownSelectableText.ios";
import type {
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";

const EMPTY_SKILLS: ReadonlyArray<SelectableMarkdownSkill> = [];

export type {
  MarkdownCodeHighlighter,
  MarkdownHighlightedToken,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
  SelectableMarkdownTextProps,
} from "./SelectableMarkdownText.types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText({
  markdown,
  skills = EMPTY_SKILLS,
  textStyle,
  highlightCode,
  preserveSoftBreaks = false,
  onLinkPress,
  marginTop = 0,
  marginBottom = 0,
}: SelectableMarkdownTextProps) {
  const chunks = useMemo(() => {
    const parsedDocument = parseMarkdownWithOptions(markdown, {
      gfm: true,
      html: true,
      math: false,
    });
    const document = preserveSoftBreaks
      ? nativeMarkdownWithPreservedSoftBreaks(parsedDocument)
      : parsedDocument;
    return nativeMarkdownDocumentChunks(document).map((chunk) =>
      chunk.kind === "selectable"
        ? {
            ...chunk,
            runs: nativeMarkdownDocumentRuns(chunk.node, skills),
          }
        : chunk,
    );
  }, [markdown, preserveSoftBreaks, skills]);

  return (
    // A percentage width here creates a cyclic intrinsic measurement inside
    // shrink-to-fit containers such as user-message bubbles. Yoga then gives
    // the native text node an unbounded second pass and the parent only clips
    // the resulting single-line width instead of reflowing it.
    <View style={{ flexShrink: 1, minWidth: 0, marginTop, marginBottom }}>
      {chunks.map((chunk, index) => {
        const content =
          chunk.kind === "rich" ? (
            <NativeMarkdownBlock
              node={chunk.node}
              textStyle={textStyle}
              highlightCode={highlightCode}
              onLinkPress={onLinkPress}
            />
          ) : (
            <NativeMarkdownSelectableText
              runs={chunk.runs}
              textStyle={textStyle}
              onLinkPress={onLinkPress}
            />
          );

        return (
          <View
            key={chunk.key}
            style={{ paddingTop: nativeMarkdownChunkSpacing(chunks[index - 1], chunk) }}
          >
            {content}
          </View>
        );
      })}
    </View>
  );
}
