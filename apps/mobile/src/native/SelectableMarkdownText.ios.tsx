import {
  SelectableMarkdownText as T3SelectableMarkdownText,
  type SelectableMarkdownTextProps,
} from "@t3tools/mobile-markdown-text/renderer";

import { highlightCodeSnippet } from "../features/review/shikiReviewHighlighter";
import { renderMermaidCodeBlock } from "../components/MermaidPreview";
import { hasClosedMermaidFence } from "@t3tools/client-runtime/mermaid-preview";

type MobileSelectableMarkdownTextProps = Omit<SelectableMarkdownTextProps, "highlightCode"> & {
  isStreaming?: boolean | undefined;
};

export type {
  MarkdownFileContextMenu,
  MarkdownFileContextMenuAction,
  MarkdownImageRenderer,
  MarkdownImageRequest,
  NativeMarkdownTextStyle,
  SelectableMarkdownSkill,
} from "@t3tools/mobile-markdown-text/types";

export function hasNativeSelectableMarkdownText(): boolean {
  return true;
}

export function SelectableMarkdownText(props: MobileSelectableMarkdownTextProps) {
  return (
    <T3SelectableMarkdownText
      {...props}
      renderCodeBlock={(source, language, children) =>
        !props.isStreaming && hasClosedMermaidFence(props.markdown, source)
          ? renderMermaidCodeBlock(source, language, children)
          : children
      }
      highlightCode={highlightCodeSnippet}
    />
  );
}
