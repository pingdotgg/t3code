import {
  ChatAttachmentId,
  ComposerContextId,
  type ChatFileAttachment,
  type ChatImageAttachment,
  type PreviewAnnotationPayload,
} from "@t3tools/contracts";
import { getSchema } from "@tiptap/core";
import { history, redo, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_UNDO_GROUP_DELAY,
  type ComposerChangeKind,
  composerHistoryRevisionOf,
  createComposerHistoryRevisionPlugin,
  groupUndoByChangeKind,
  markAsClipboardEdit,
} from "../../composer-undo-grouping";
import type { ComposerImageAttachment } from "../../composerDraftStore";
import { buildMessageContext, previewAnnotationContextId } from "../../lib/composerContextRecords";
import {
  createQueuedImageHistoryState,
  type QueuedAttachmentContextBinding,
  reconcileAttachmentContextReferences,
  recordChiplessQueuedImageRemoval,
  recordQueuedImageHistoryRevision,
  type RetainedAttachmentContextPayloads,
} from "./composerContextUndo";

const binary = new File(["binary"], "context.png", { type: "image/png" });
const image = {
  type: "image",
  id: "annotation-1",
  name: "annotation.png",
  mimeType: "image/png",
  sizeBytes: binary.size,
  previewUrl: "blob:annotation",
  file: binary,
} satisfies ComposerImageAttachment;
const annotation = {
  id: "annotation-1",
  pageUrl: "https://example.com",
  pageTitle: "Example",
  comment: "Fix this",
  elements: [],
  regions: [],
  strokes: [],
  styleChanges: [],
  screenshot: {
    dataUrl: "data:image/png;base64,YmluYXJ5",
    width: 1,
    height: 1,
    cropRect: { x: 0, y: 0, width: 1, height: 1 },
  },
  createdAt: "2026-01-01T00:00:00.000Z",
} satisfies PreviewAnnotationPayload;

function retention(): RetainedAttachmentContextPayloads {
  return {
    files: new Map(),
    previewAnnotations: new Map(),
    queuedImageHistory: createQueuedImageHistoryState(),
  };
}

const schema = getSchema([StarterKit]);

function createQueuedEditHarness(input: {
  initialText: string;
  attachments: ReadonlyArray<QueuedAttachmentContextBinding>;
}) {
  let clock = 0;
  let previous: ComposerChangeKind | null = null;
  const retained = retention();
  const original = input.attachments;
  let live = [...original];
  let removed: QueuedAttachmentContextBinding[] = [];

  const docFor = (text: string) =>
    schema.node("doc", null, [schema.node("paragraph", null, text ? [schema.text(text)] : [])]);

  let state = EditorState.create({
    schema,
    doc: docFor(input.initialText),
    plugins: [
      history({ newGroupDelay: COMPOSER_UNDO_GROUP_DELAY }),
      createComposerHistoryRevisionPlugin(),
    ],
  });

  const referencedIn = (text: string): Set<string> => {
    const ids = new Set<string>();
    for (const entry of original) {
      for (const contextId of entry.contextIds) {
        if (text.includes(`<<${contextId}>>`)) ids.add(contextId);
      }
    }
    return ids;
  };

  const applyAttachmentChanges = (
    result: ReturnType<typeof reconcileAttachmentContextReferences>,
  ) => {
    for (const attachmentId of result.queuedAttachmentIdsToRemove) {
      const removedEntry = live.find((entry) => entry.attachment.id === attachmentId);
      if (!removedEntry) continue;
      live = live.filter((entry) => entry.attachment.id !== attachmentId);
      removed.push(removedEntry);
    }
    for (const restoredAttachment of result.queuedAttachmentsToRestore) {
      const restoredEntry = removed.find((entry) => entry.attachment.id === restoredAttachment.id);
      if (!restoredEntry) continue;
      removed = removed.filter((entry) => entry.attachment.id !== restoredAttachment.id);
      live = original.filter(
        (entry) =>
          live.some((item) => item.attachment.id === entry.attachment.id) ||
          entry.attachment.id === restoredAttachment.id,
      );
    }
  };

  const dispatchUser = (tr: Transaction) => {
    clock += 80;
    const prevText = state.doc.textContent;
    tr.setTime(clock);
    previous = groupUndoByChangeKind(tr, previous);
    state = state.apply(tr);
    const nextText = state.doc.textContent;
    const result = reconcileAttachmentContextReferences({
      referencedContextIds: referencedIn(nextText),
      files: [],
      queuedAttachments: live,
      removedQueuedAttachments: removed,
      history: composerHistoryRevisionOf(state),
      textChanged: prevText !== nextText,
      images: [],
      previewAnnotations: [],
      retained,
    });
    applyAttachmentChanges(result);
  };

  const dispatchControlledRewrite = (nextText: string) => {
    clock += 80;
    const tr = state.tr.replaceWith(
      0,
      state.doc.content.size,
      schema.node("paragraph", null, nextText ? [schema.text(nextText)] : []),
    );
    tr.setTime(clock);
    previous = groupUndoByChangeKind(tr, previous);
    state = state.apply(tr);
    state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));
    recordQueuedImageHistoryRevision(
      retained.queuedImageHistory,
      composerHistoryRevisionOf(state),
      removed,
    );
  };

  recordQueuedImageHistoryRevision(
    retained.queuedImageHistory,
    composerHistoryRevisionOf(state),
    removed,
  );
  state = state.apply(state.tr.setSelection(TextSelection.atEnd(state.doc)));

  return {
    text: () => state.doc.textContent,
    liveIds: () => live.map((entry) => entry.attachment.id),
    clickRowRemove: (attachmentId: string) => {
      const entry = live.find((item) => item.attachment.id === attachmentId);
      if (!entry) return;
      const currentText = state.doc.textContent;
      let nextText = currentText;
      for (const contextId of entry.contextIds) {
        nextText = nextText.replaceAll(`<<${contextId}>>`, "");
      }
      live = live.filter((item) => item.attachment.id !== attachmentId);
      removed = [...removed, entry];
      if (nextText !== currentText) {
        dispatchControlledRewrite(nextText);
      } else {
        recordChiplessQueuedImageRemoval(retained.queuedImageHistory, attachmentId);
      }
    },
    pasteQueuedImageChip: (attachmentId: string, contextId: ComposerContextId) => {
      const restoredEntry = removed.find((item) => item.attachment.id === attachmentId);
      if (restoredEntry) {
        retained.queuedImageHistory.pendingRestoredIds.add(attachmentId);
      }
      dispatchUser(markAsClipboardEdit(state.tr.insertText(`<<${contextId}>>`), "paste"));
      if (restoredEntry) {
        removed = removed.filter((item) => item.attachment.id !== attachmentId);
        live = original.filter(
          (entry) =>
            live.some((item) => item.attachment.id === entry.attachment.id) ||
            entry.attachment.id === attachmentId,
        );
      }
    },
    deleteChipText: (contextId: ComposerContextId) => {
      const token = `<<${contextId}>>`;
      const idx = state.doc.textContent.indexOf(token);
      if (idx === -1) throw new Error(`Chip ${token} not found in "${state.doc.textContent}"`);
      dispatchUser(state.tr.delete(idx + 1, idx + 1 + token.length));
    },
    typeGroup: (s: string) => {
      clock += COMPOSER_UNDO_GROUP_DELAY + 100;
      dispatchUser(state.tr.insertText(s, state.doc.content.size - 1));
    },
    undo: () => {
      expect(undo(state, dispatchUser)).toBe(true);
    },
    redo: () => {
      expect(redo(state, dispatchUser)).toBe(true);
    },
  };
}

describe("reconcileAttachmentContextReferences", () => {
  it("restores an annotation and its screenshot attachment after undo", () => {
    const retained = retention();
    const removed = reconcileAttachmentContextReferences({
      referencedContextIds: new Set(),
      files: [],
      images: [image],
      previewAnnotations: [annotation],
      retained,
    });
    expect(removed.annotationIdsToRemove).toEqual(["annotation-1"]);

    const restored = reconcileAttachmentContextReferences({
      referencedContextIds: new Set([previewAnnotationContextId(annotation.id)]),
      files: [],
      images: [],
      previewAnnotations: [],
      retained,
    });
    expect(restored.annotationsToRestore).toEqual([{ annotation, image }]);
    expect(restored.annotationsToRestore[0]?.annotation.screenshot?.dataUrl).toBe(
      "data:image/png;base64,YmluYXJ5",
    );
    expect(restored.annotationsToRestore[0]?.image?.file).toBe(binary);
    expect(
      buildMessageContext({
        terminalContexts: [],
        reviewComments: [],
        previewAnnotations: restored.annotationsToRestore.map((entry) => entry.annotation),
        attachments: [
          {
            attachment: restored.annotationsToRestore[0]!.image!,
            attachmentId: "uploaded-screenshot",
          },
        ],
      })?.records,
    ).toEqual([
      expect.objectContaining({
        kind: "preview-annotation",
        screenshotContextId: "image_annotation-1",
      }),
      expect.objectContaining({
        kind: "image",
        contextId: "image_annotation-1",
        attachmentId: "uploaded-screenshot",
      }),
    ]);
  });

  it("reconciles queued files and images across keyboard deletion, row removal, paste, undo, redo, branching, and history trimming", () => {
    const chipFile: ChatFileAttachment = {
      type: "file",
      id: ChatAttachmentId.make("server-file-1"),
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
    };
    const plainFile: ChatFileAttachment = {
      type: "file",
      id: ChatAttachmentId.make("server-file-2"),
      name: "legacy.pdf",
      mimeType: "application/pdf",
      sizeBytes: 40,
    };
    const imageA: ChatImageAttachment = {
      type: "image",
      id: ChatAttachmentId.make("server-image-a"),
      name: "a.png",
      mimeType: "image/png",
      sizeBytes: 67,
    };
    const imageB: ChatImageAttachment = {
      type: "image",
      id: ChatAttachmentId.make("server-image-b"),
      name: "b.png",
      mimeType: "image/png",
      sizeBytes: 68,
    };
    const chipContextId = ComposerContextId.make("file_local-1");
    const imageAContextId = ComposerContextId.make("image_local-a");
    const imageBContextId = ComposerContextId.make("image_local-b");

    // Deleting a chip-backed file removes it; unreferenced files and backspaced image chips stay attached.
    const basic = createQueuedEditHarness({
      initialText: `Check <<${chipContextId}>> <<${imageAContextId}>>`,
      attachments: [
        { attachment: chipFile, contextIds: [chipContextId] },
        { attachment: plainFile, contextIds: [] },
        { attachment: imageA, contextIds: [imageAContextId] },
      ],
    });
    basic.deleteChipText(chipContextId);
    expect(basic.liveIds()).toEqual([plainFile.id, imageA.id]);
    basic.undo();
    expect(basic.liveIds()).toEqual([chipFile.id, plainFile.id, imageA.id]);
    basic.redo();
    expect(basic.liveIds()).toEqual([plainFile.id, imageA.id]);

    // × -> Paste -> Backspace -> Undo x3 -> Redo x3 keeps image A attached after the final redo.
    basic.clickRowRemove(imageA.id);
    expect(basic.liveIds()).toEqual([plainFile.id]);
    basic.pasteQueuedImageChip(imageA.id, imageAContextId);
    expect(basic.liveIds()).toEqual([plainFile.id, imageA.id]);
    basic.deleteChipText(imageAContextId);
    expect(basic.liveIds()).toEqual([plainFile.id, imageA.id]);
    basic.undo();
    expect(basic.liveIds()).toEqual([plainFile.id, imageA.id]);
    basic.undo();
    expect(basic.liveIds()).toEqual([plainFile.id]);
    basic.undo();
    expect(basic.liveIds()).toEqual([plainFile.id, imageA.id]);
    basic.redo();
    expect(basic.liveIds()).toEqual([plainFile.id]);
    basic.redo();
    expect(basic.liveIds()).toEqual([plainFile.id, imageA.id]);
    basic.redo();
    expect(basic.liveIds()).toEqual([plainFile.id, imageA.id]);

    // Branching via a controlled row removal: × on A -> Undo -> × on B -> Backspace A -> Undo -> Redo
    // must keep A attached and B removed.
    const branched = createQueuedEditHarness({
      initialText: `Compare <<${imageAContextId}>> <<${imageBContextId}>>`,
      attachments: [
        { attachment: imageA, contextIds: [imageAContextId] },
        { attachment: imageB, contextIds: [imageBContextId] },
      ],
    });
    branched.clickRowRemove(imageA.id);
    expect(branched.liveIds()).toEqual([imageB.id]);
    branched.undo();
    expect(branched.liveIds()).toEqual([imageA.id, imageB.id]);
    branched.clickRowRemove(imageB.id);
    expect(branched.liveIds()).toEqual([imageA.id]);
    branched.deleteChipText(imageAContextId);
    expect(branched.liveIds()).toEqual([imageA.id]);
    branched.undo();
    expect(branched.liveIds()).toEqual([imageA.id]);
    branched.redo();
    expect(branched.liveIds()).toEqual([imageA.id]);

    // Overflow trimming: after 119 undo groups, × (depth 120) -> Paste (trims 121 -> 100) -> Undo
    // must still remove image A.
    const trimmed = createQueuedEditHarness({
      initialText: `Start <<${imageAContextId}>>`,
      attachments: [{ attachment: imageA, contextIds: [imageAContextId] }],
    });
    for (let i = 0; i < 119; i += 1) {
      trimmed.typeGroup("x");
    }
    trimmed.clickRowRemove(imageA.id);
    expect(trimmed.liveIds()).toEqual([]);
    trimmed.pasteQueuedImageChip(imageA.id, imageAContextId);
    expect(trimmed.liveIds()).toEqual([imageA.id]);
    trimmed.undo();
    expect(trimmed.liveIds()).toEqual([]);
    trimmed.redo();
    expect(trimmed.liveIds()).toEqual([imageA.id]);
  });
});
