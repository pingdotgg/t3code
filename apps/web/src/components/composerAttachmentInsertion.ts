import type { Editor, EditorEvents } from "@tiptap/core";
import { closeHistory } from "@tiptap/pm/history";
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
import { ComposerImageHistoryStep, type RetainedComposerImage } from "../composer-image-history";
import { markAsClipboardEdit } from "../composer-undo-grouping";

export interface ComposerImageHistoryAttachment {
  readonly targetKey: string;
  readonly images: ReadonlyArray<RetainedComposerImage>;
}

const INSERTION_ORDER_META = "composerAttachmentInsertionOrder";
let nextInsertionOrder = 0;

export function insertComposerContextReferencesInEditor(
  editor: Editor,
  references: ReadonlyArray<ComposerContextReference>,
  options?: {
    readonly from?: number;
    readonly to?: number;
    readonly imageHistory?: ComposerImageHistoryAttachment | undefined;
    readonly insertionOrder?: number | undefined;
  },
): boolean {
  if (editor.isDestroyed || references.length === 0) return false;
  const nodeType = editor.schema.nodes["composer-context-reference"];
  if (!nodeType) return false;
  // Default to a collapsed caret when no explicit range is passed, so a delayed
  // attachment whose captured range was lost never replaces a later user selection.
  const from = options?.from ?? editor.state.selection.from;
  const to = options?.to ?? from;
  const map = serializeEditorDoc(editor.state.doc);
  const edit = inlineContextReferenceReplacement(
    map.value,
    {
      start: flatToMarkdown(map, pmToFlat(map, from)),
      end: flatToMarkdown(map, pmToFlat(map, to)),
    },
    references,
  );
  const acceptsReference =
    editor.state.doc.resolve(from).parent.type.contentMatch.matchType(nodeType) !== null;
  const content = acceptsReference
    ? references.flatMap((reference) => [
        nodeType.create({ ...reference, source: formatInlineContextReference(reference) }),
        editor.schema.text(" "),
      ])
    : [editor.schema.text(edit.text)];
  if (acceptsReference && edit.text.startsWith(" ")) content.unshift(editor.schema.text(" "));
  const replaceEnd = flatToPm(map, markdownToFlat(map, edit.end));
  const tr = editor.state.tr.replaceWith(from, replaceEnd, content);
  if (options?.imageHistory && options.imageHistory.images.length > 0) {
    closeHistory(tr);
    tr.step(
      new ComposerImageHistoryStep(
        "add",
        options.imageHistory.targetKey,
        options.imageHistory.images,
      ),
    );
  }
  markAsClipboardEdit(tr, "paste");
  if (options?.insertionOrder !== undefined) {
    tr.setMeta(INSERTION_ORDER_META, {
      order: options.insertionOrder,
      from,
      end: tr.mapping.map(replaceEnd, 1),
    });
  }
  editor.view.dispatch(tr);
  return true;
}

export function captureComposerAttachmentInsertion(editor: Editor) {
  const order = nextInsertionOrder++;
  let { from, to } = editor.state.selection;
  let lost = false;
  const track = ({ transaction, appendedTransactions }: EditorEvents["transaction"]) => {
    for (const tr of [transaction, ...appendedTransactions]) {
      // Stay before text typed at the paste point, but after an earlier capture's references.
      const insertion: { order: number; from: number; end: number } | undefined =
        tr.getMeta(INSERTION_ORDER_META);
      const followsEarlier = insertion !== undefined && insertion.order < order;
      const start = tr.mapping.mapResult(from, followsEarlier ? 1 : -1);
      const end = tr.mapping.mapResult(to, followsEarlier ? 1 : -1);
      // Replacing the following space maps its start left regardless of association.
      if (followsEarlier && from === to && from === insertion.from) {
        from = to = insertion.end;
        continue;
      }
      // A replacement spanning the paste point (such as a controlled setContent) leaves no
      // position to keep, so the caller falls back to the current caret.
      lost ||= start.deletedAcross || end.deletedAcross;
      from = start.pos;
      to = start.deletedAfter || end.deletedBefore ? from : end.pos;
    }
  };
  editor.on("transaction", track);
  const dispose = () => {
    editor.off("transaction", track);
  };
  return {
    insert: (
      references: ReadonlyArray<ComposerContextReference>,
      options?: { readonly imageHistory?: ComposerImageHistoryAttachment | undefined },
    ): boolean => {
      dispose();
      if (lost) return false;
      return insertComposerContextReferencesInEditor(editor, references, {
        from,
        to,
        imageHistory: options?.imageHistory,
        insertionOrder: order,
      });
    },
    dispose,
  };
}

export type ComposerAttachmentInsertion = ReturnType<typeof captureComposerAttachmentInsertion>;
