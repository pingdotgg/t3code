import {
  SelectableMarkdownText as T3SelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@t3tools/mobile-markdown-text/renderer";
import { useMemo } from "react";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";
import { renderMermaidCodeBlock } from "../components/MermaidPreview";
import { hasClosedMermaidFence } from "@t3tools/client-runtime/mermaid-preview";
import { themeColorWithAlpha } from "../lib/mobileTheme";
import { useUniwindTheme } from "../lib/useUniwindTheme";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode"> & {
  isStreaming?: boolean | undefined;
};

export type {
  MarkdownImageRequest,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@t3tools/mobile-markdown-text/types";

// The renderer falls back to React Native Text outside iOS, so Android can use
// the same Markdown chunking while retaining native text selection.
export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  const theme = useUniwindTheme();
  const selectionColor = themeColorWithAlpha(theme["--color-focus"], 0.32);
  const selectionHandleColor = theme["--color-focus"];
  const textStyle = useMemo(
    () => ({ selectionColor, selectionHandleColor, ...props.textStyle }),
    [props.textStyle, selectionColor, selectionHandleColor],
  );
  return (
    <T3SelectableMarkdownText
      {...props}
      renderCodeBlock={(source, language, children) =>
        !props.isStreaming && hasClosedMermaidFence(props.markdown, source)
          ? renderMermaidCodeBlock(source, language, children)
          : children
      }
      textStyle={textStyle}
      highlightCode={highlightCodeSnippet}
    />
  );
}
