import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";

import { languageOfInfoString, withInfoStringLanguage } from "~/composer-code-languages";

import { useRenderedAppearance } from "../../hooks/useTheme";
import { MarkdownCodeBlockFrame } from "../ChatMarkdown";
import { ComposerCodeBlockLanguagePicker } from "./ComposerCodeBlockLanguagePicker";

export function ComposerCodeBlockNodeView({
  node,
  editor,
  getPos,
  updateAttributes,
}: NodeViewProps) {
  const resolvedTheme = useRenderedAppearance();
  const info = typeof node.attrs.language === "string" ? node.attrs.language : "";
  const language = languageOfInfoString(info);

  const changeLanguage = (next: string) => {
    updateAttributes({ language: withInfoStringLanguage(info, next) });
    const position = getPos();
    if (typeof position === "number") {
      editor
        .chain()
        .focus(position + 1 + node.content.size)
        .run();
    }
  };

  return (
    <MarkdownCodeBlockFrame
      as={NodeViewWrapper}
      language={language || "text"}
      fenceTitle={null}
      theme={resolvedTheme}
      headerProps={{ contentEditable: false }}
      title={
        <ComposerCodeBlockLanguagePicker
          language={language}
          theme={resolvedTheme}
          disabled={!editor.isEditable}
          onChange={changeLanguage}
        />
      }
    >
      <div className="chat-markdown-shiki">
        <pre className="max-w-full overflow-x-auto px-3 pt-1 pb-2">
          {/* A caret needs a line to sit on even before any code is typed. */}
          <NodeViewContent<"code">
            as="code"
            className="block min-h-[1lh] font-mono whitespace-pre-wrap text-inherit [overflow-wrap:anywhere]"
          />
        </pre>
      </div>
    </MarkdownCodeBlockFrame>
  );
}
