import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";

import { languageOfInfoString, withInfoStringLanguage } from "~/composer-code-languages";

import { useTheme } from "../../hooks/useTheme";
import { MarkdownCodeBlockFrame } from "../ChatMarkdown";
import { ComposerCodeBlockLanguagePicker } from "./ComposerCodeBlockLanguagePicker";

/**
 * Draws a composer fence in the chat view's own code block frame, so a draft
 * looks like the message it is about to become, with the language title
 * swapped for a picker that rewrites the fence's language in place.
 *
 * The chrome stops at the language. Chat's wrap and copy buttons act on text
 * the reader cannot change; here the text is the draft, and both are already
 * a selection away.
 */
export function ComposerCodeBlockNodeView({
  node,
  editor,
  getPos,
  updateAttributes,
}: NodeViewProps) {
  const { resolvedTheme } = useTheme();
  const info = typeof node.attrs.language === "string" ? node.attrs.language : "";
  const language = languageOfInfoString(info);

  const changeLanguage = (next: string) => {
    updateAttributes({ language: withInfoStringLanguage(info, next) });
    // Back into the code, at its end, the way a picker hands focus back.
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
