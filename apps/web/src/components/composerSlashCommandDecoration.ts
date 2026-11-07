import { Extension, type Editor } from "@tiptap/core";
import { type Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { leadingSlashCommand, type NamedSlashCommand } from "../composer-logic";

const SlashCommandPluginKey = new PluginKey<ReadonlyArray<NamedSlashCommand>>(
  "composer-slash-command",
);

function slashCommandDecorations(
  doc: ProseMirrorNode,
  commands: ReadonlyArray<NamedSlashCommand>,
): DecorationSet {
  const block = doc.firstChild;
  const first = block?.firstChild;
  // A marked or fenced token serializes with its markers, so it no longer opens the prompt.
  // That includes a token only partly marked, which runs past the first unmarked text node.
  if (block?.type.name !== "paragraph" || !first?.text?.startsWith("/") || first.marks.length > 0) {
    return DecorationSet.empty;
  }
  const text = block.textBetween(0, block.content.size, undefined, (leaf) =>
    leaf.type.name === "hardBreak" ? "\n" : "\ufffc",
  );
  const command = leadingSlashCommand(text, commands);
  if (!command || command.length > first.nodeSize) return DecorationSet.empty;
  return DecorationSet.create(doc, [
    Decoration.inline(1, 1 + command.length, { class: "text-info-foreground" }),
  ]);
}

const SlashCommandPlugin = new Plugin<ReadonlyArray<NamedSlashCommand>>({
  key: SlashCommandPluginKey,
  state: {
    init: () => [],
    apply: (transaction, commands) => transaction.getMeta(SlashCommandPluginKey) ?? commands,
  },
  props: {
    decorations(state) {
      return slashCommandDecorations(state.doc, SlashCommandPluginKey.getState(state) ?? []);
    },
  },
});

export const ComposerSlashCommandExtension = Extension.create({
  name: "composer-slash-command",
  addProseMirrorPlugins() {
    return [SlashCommandPlugin];
  },
});

export function setComposerSlashCommands(
  editor: Editor,
  commands: ReadonlyArray<NamedSlashCommand>,
): void {
  editor.view.dispatch(
    editor.state.tr.setMeta(SlashCommandPluginKey, commands).setMeta("addToHistory", false),
  );
}
