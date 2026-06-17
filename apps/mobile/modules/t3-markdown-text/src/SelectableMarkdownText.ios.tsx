import { useMemo } from "react";
import { View } from "react-native";
import { parseMarkdownWithOptions } from "react-native-nitro-markdown/headless";

import {
  nativeMarkdownChunkSpacing,
  nativeMarkdownDocumentChunks,
  nativeMarkdownDocumentRuns,
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
  marginTop = 0,
  marginBottom = 0,
}: SelectableMarkdownTextProps) {
  const chunks = useMemo(() => {
    const document = parseMarkdownWithOptions(markdown, {
      gfm: true,
      html: true,
      math: false,
    });
    return nativeMarkdownDocumentChunks(document).map((chunk) =>
      chunk.kind === "selectable"
        ? {
            ...chunk,
            runs: nativeMarkdownDocumentRuns(chunk.node, skills),
          }
        : chunk,
    );
  }, [markdown, skills]);

  return (
    <View style={{ width: "100%", marginTop, marginBottom }}>
      {chunks.map((chunk, index) => {
        const content =
          chunk.kind === "rich" ? (
            <NativeMarkdownBlock
              node={chunk.node}
              textStyle={textStyle}
              highlightCode={highlightCode}
            />
          ) : (
            <NativeMarkdownSelectableText runs={chunk.runs} textStyle={textStyle} />
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
