import type { Editor } from "@tiptap/core";
import type { Transaction } from "@tiptap/pm/state";
import {
  flatToMarkdown,
  flatToPm,
  markdownToFlat,
  pmToFlat,
  serializeEditorDoc,
} from "../composer-rich-text-doc";
import {
  type ComposerContextReference,
  formatInlineContextReference,
  inlineContextReferenceReplacement,
} from "../lib/composerContextReferences";
import { markAsClipboardEdit } from "../composer-undo-grouping";

export function captureComposerAttachmentInsertion(editor: Editor) {
  let { from, to } = editor.state.selection;
  const track = ({ transaction }: { transaction: Transaction }) => {
    // Keep the attachment before text typed at the paste point while its image is preparing.
    const start = transaction.mapping.mapResult(from, -1);
    const end = transaction.mapping.mapResult(to, -1);
    from = start.pos;
    to = start.deletedAfter || end.deletedBefore ? from : end.pos;
  };
  editor.on("transaction", track);
  const dispose = () => {
    editor.off("transaction", track);
  };
  return {
    insert: (references: ReadonlyArray<ComposerContextReference>): boolean => {
      dispose();
      if (editor.isDestroyed || references.length === 0) return false;
      const nodeType = editor.schema.nodes["composer-context-reference"];
      if (!nodeType) return false;
      const map = serializeEditorDoc(editor.state.doc);
      const edit = inlineContextReferenceReplacement(
        map.value,
        {
          start: flatToMarkdown(map, pmToFlat(map, from)),
          end: flatToMarkdown(map, pmToFlat(map, to)),
        },
        references,
      );
      const content = references.flatMap((reference) => [
        nodeType.create({ ...reference, source: formatInlineContextReference(reference) }),
        editor.schema.text(" "),
      ]);
      if (edit.text.startsWith(" ")) content.unshift(editor.schema.text(" "));
      const tr = editor.state.tr.replaceWith(
        from,
        flatToPm(map, markdownToFlat(map, edit.end)),
        content,
      );
      editor.view.dispatch(markAsClipboardEdit(tr, "paste"));
      return true;
    },
    dispose,
  };
}

export type ComposerAttachmentInsertion = ReturnType<typeof captureComposerAttachmentInsertion>;
