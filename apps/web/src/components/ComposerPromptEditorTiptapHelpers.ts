import type { JSONContent } from "@tiptap/react";
import { buildTiptapContent } from "~/composer-rich-text-doc";
import type { SkillMeta } from "~/composer-rich-text-doc";
import type { TiptapEditor } from "./ComposerPromptEditorTiptapExtensions";

export function insertMarkdownParagraphs(
  value: string,
  skillLabelFor: (name: string) => SkillMeta | null,
  options: { styling: boolean; blocks?: boolean; literalText?: boolean; literalLength?: number },
  insertContent: (content: JSONContent[] | JSONContent) => void,
): void {
  const blocks = buildTiptapContent(value, skillLabelFor, options);
  if (blocks.length === 1 && blocks[0]?.type === "paragraph") {
    const inline = (blocks[0]?.content ?? []) as JSONContent[];
    if (inline.length === 0) return;
    insertContent(inline);
    return;
  }
  insertContent(blocks as JSONContent[]);
}

/** Native scrolling follows only real input; explicitly reveal programmatically placed carets. */
export function scrollTiptapCaretIntoView(editor: TiptapEditor): void {
  editor.view.dispatch(editor.state.tr.scrollIntoView());
}

export function caretLineRect(range: Range, edge: "start" | "end"): DOMRect | null {
  const collapsedRects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0);
  const collapsedRect = edge === "start" ? collapsedRects.at(-1) : collapsedRects[0];
  if (collapsedRect) return collapsedRect;

  const container = range.startContainer;
  if (container.nodeType === 3) {
    const textNode = container as Text;
    if (textNode.data.length === 0) return null;
    const probeStart = Math.max(
      0,
      Math.min(
        edge === "start" ? range.startOffset : range.startOffset - 1,
        textNode.data.length - 1,
      ),
    );
    const probeRange = document.createRange();
    probeRange.setStart(textNode, probeStart);
    probeRange.setEnd(textNode, probeStart + 1);
    const probeRect = Array.from(probeRange.getClientRects()).find((rect) => rect.height > 0);
    if (probeRect) return probeRect;
    const boundingRect = probeRange.getBoundingClientRect();
    return boundingRect.height > 0 ? boundingRect : null;
  }

  if (!(container instanceof HTMLElement)) return null;
  const neighbour =
    container.childNodes[Math.max(0, range.startOffset - 1)] ??
    container.childNodes[range.startOffset];
  if (neighbour instanceof HTMLElement) {
    const neighbourRect = neighbour.getBoundingClientRect();
    if (neighbourRect.height > 0) return neighbourRect;
  } else if (neighbour instanceof Text && neighbour.data.length > 0) {
    const isBeforeCaret = neighbour === container.childNodes[range.startOffset - 1];
    const probeStart = isBeforeCaret ? neighbour.data.length - 1 : 0;
    const probeRange = document.createRange();
    probeRange.setStart(neighbour, probeStart);
    probeRange.setEnd(neighbour, probeStart + 1);
    const probeRect = Array.from(probeRange.getClientRects()).find((rect) => rect.height > 0);
    if (probeRect) return probeRect;
  }
  const containerRect = container.getBoundingClientRect();
  return containerRect.height > 0 ? containerRect : null;
}
