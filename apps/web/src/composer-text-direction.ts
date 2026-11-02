import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { type EditorState, Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { textDirection, type TextDirection } from "~/textDirection";

interface ComposerTextDirections {
  /** One entry per top-level block. */
  readonly blocks: ReadonlyArray<TextDirection | null>;
  readonly decorations: DecorationSet;
}

// Nodes are immutable and blocks are shared between documents, so a keystroke
// only recounts the block it changed, and every reader of one document shares
// one result.
const blockDirections = new WeakMap<ProseMirrorNode, TextDirection | null>();
const docDirections = new WeakMap<ProseMirrorNode, ComposerTextDirections>();

function proseText(block: ProseMirrorNode): string {
  let text = "";
  block.descendants((node) => {
    if (node.isText) {
      text += node.marks.some((mark) => mark.type.spec.code) ? " " : node.text;
    } else if (node.isBlock || node.isAtom) {
      text += " ";
    }
  });
  return text;
}

function blockDirection(block: ProseMirrorNode): TextDirection | null {
  let direction = blockDirections.get(block);
  if (direction === undefined) {
    direction = textDirection(proseText(block)) ?? null;
    blockDirections.set(block, direction);
  }
  return direction;
}

/**
 * Lines inside a list or quote follow the block around them, which keeps the
 * bullets and the quote rule on the same side as the text. A line without
 * letters yet continues the one above, so a new line after Arabic starts on
 * the right. Code blocks stay left to right.
 */
export function composerTextDirections(doc: ProseMirrorNode): ComposerTextDirections {
  const cached = docDirections.get(doc);
  if (cached) return cached;
  const blocks: Array<TextDirection | null> = [];
  const decorations: Decoration[] = [];
  let previous: TextDirection | null = null;
  doc.forEach((block, offset) => {
    if (block.type.spec.code) {
      blocks.push("ltr");
      return;
    }
    const dir = blockDirection(block) ?? previous;
    blocks.push(dir);
    if (dir) decorations.push(Decoration.node(offset, offset + block.nodeSize, { dir }));
    previous = dir;
  });
  const directions = { blocks, decorations: DecorationSet.create(doc, decorations) };
  docDirections.set(doc, directions);
  return directions;
}

export function caretLineDirection(state: EditorState): TextDirection | null {
  return composerTextDirections(state.doc).blocks[state.selection.$head.index(0)] ?? null;
}

export const ComposerTextDirectionExtension = Extension.create({
  name: "composer-text-direction",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("composer-text-direction"),
        props: {
          decorations: (state) => composerTextDirections(state.doc).decorations,
          // On Chrome, ProseMirror reads the arrow keys' direction from the
          // editor root, so the root follows the line holding the caret.
          attributes: (state): Record<string, string> => {
            const dir = caretLineDirection(state);
            return dir ? { dir } : {};
          },
        },
      }),
    ];
  },
});
