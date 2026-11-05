import { Decoration, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { ReactWidgetRenderer } from "@tiptap/react";

import { type ComposerLink, findComposerLinks } from "~/composer-links";
import { MARKDOWN_SOURCE_MARK } from "~/composer-rich-text";
import { MarkdownLinkFavicon } from "./chat/MarkdownLinkFavicon";

// Revealed Markdown source shows inline code as backtick text without the code mark.
const CODE_SPAN = /(?<!`)(`+)(?!`)[^]*?(?<!`)\1(?!`)/gu;

function collectComposerLinks(doc: ProseMirrorNode): ComposerLink[] {
  const links: ComposerLink[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    if (node.type.spec.code) return false;
    // A URL can span several text nodes (part of it bold, say), but not a
    // chip, a hard break, or inline code.
    let run = "";
    let runStart = 0;
    const flush = () => {
      for (const link of findComposerLinks(run)) {
        links.push({ from: runStart + link.from, to: runStart + link.to, host: link.host });
      }
      run = "";
    };
    node.forEach((child, offset) => {
      if (child.isText && !child.marks.some((mark) => mark.type.spec.code)) {
        if (run === "") runStart = pos + 1 + offset;
        run += child.marks.some((mark) => mark.type.name === MARKDOWN_SOURCE_MARK)
          ? child.text!.replace(CODE_SPAN, (span) => " ".repeat(span.length))
          : child.text;
      } else {
        flush();
      }
    });
    flush();
    return false;
  });
  return links;
}

/** Colors bare URLs like the sent message's links and leads each with its site icon. */
export const ComposerLinkExtension = Extension.create({
  name: "composerLinks",
  addDecorations() {
    const editor = this.editor;
    return {
      create: ({ state }) => {
        const decorations: Decoration[] = [];
        const occurrencesByHost = new Map<string, number>();
        for (const link of collectComposerLinks(state.doc)) {
          // Widget keys must be unique and should not follow positions, or
          // typing before a link would remount its icon on every keystroke.
          const occurrence = occurrencesByHost.get(link.host) ?? 0;
          occurrencesByHost.set(link.host, occurrence + 1);
          decorations.push(
            ReactWidgetRenderer(MarkdownLinkFavicon, {
              editor,
              pos: link.from,
              key: `composer-link-favicon:${link.host}:${occurrence}`,
              props: { host: link.host },
              className: "composer-link-icon",
              side: -1,
            }),
            Decoration.Inline(link.from, link.to, { class: "composer-link" }),
          );
        }
        return decorations;
      },
    };
  },
});
