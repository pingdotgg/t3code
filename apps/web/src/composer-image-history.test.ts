import { getSchema } from "@tiptap/core";
import { history, redo, undo, undoDepth } from "@tiptap/pm/history";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  ComposerImageHistoryStep,
  extractComposerImageHistoryChanges,
  inlineContextReferenceRemovalRanges,
  type ComposerImageHistoryChange,
  type RetainedComposerImage,
} from "./composer-image-history";
import {
  COMPOSER_UNDO_GROUP_DELAY,
  type ComposerChangeKind,
  groupUndoByChangeKind,
  markAsClipboardEdit,
} from "./composer-undo-grouping";
import { formatInlineContextReference } from "./lib/composerContextReferences";

const schema = getSchema([StarterKit]);

function sampleRetained(id: string, index = 0): RetainedComposerImage {
  const file = new File([`bytes-${id}`], `${id}.png`, { type: "image/png" });
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    sizeBytes: file.size,
    file,
    index,
  };
}

function createHarness(initialText = "") {
  let clock = 0;
  let previous: ComposerChangeKind | null = null;
  let state = EditorState.create({
    schema,
    doc: schema.node("doc", null, [
      schema.node("paragraph", null, initialText ? [schema.text(initialText)] : []),
    ]),
    plugins: [history({ newGroupDelay: COMPOSER_UNDO_GROUP_DELAY })],
  });
  const appliedHistoryChanges: ComposerImageHistoryChange[][] = [];

  const dispatch = (tr: Transaction) => {
    tr.setTime(clock);
    previous = groupUndoByChangeKind(tr, previous);
    state = state.apply(tr);
    if (tr.getMeta("history$") != null) {
      const changes = extractComposerImageHistoryChanges([tr]);
      if (changes.length > 0) appliedHistoryChanges.push(changes);
    }
  };

  dispatch(state.tr.setSelection(TextSelection.atEnd(state.doc)));

  const api = {
    text: () => state.doc.textContent,
    undoDepth: () => undoDepth(state),
    appliedHistoryChanges: () => appliedHistoryChanges,
    type: (text: string) => {
      for (const ch of text) {
        clock += 80;
        dispatch(state.tr.insertText(ch));
      }
      return api;
    },
    pause: (ms = COMPOSER_UNDO_GROUP_DELAY + 50) => {
      clock += ms;
      return api;
    },
    addImages: (
      targetKey: string,
      images: ReadonlyArray<RetainedComposerImage>,
      inlineText?: string,
    ) => {
      clock += 80;
      const tr = inlineText ? state.tr.insertText(inlineText) : state.tr;
      tr.step(new ComposerImageHistoryStep("add", targetKey, images));
      dispatch(markAsClipboardEdit(tr, "paste"));
      return api;
    },
    removeImages: (targetKey: string, images: ReadonlyArray<RetainedComposerImage>) => {
      clock += 80;
      const tr = state.tr.step(new ComposerImageHistoryStep("remove", targetKey, images));
      dispatch(markAsClipboardEdit(tr, "cut"));
      return api;
    },
    undo: () => {
      undo(state, dispatch);
      return api;
    },
    redo: () => {
      redo(state, dispatch);
      return api;
    },
  };
  return api;
}

describe("ComposerImageHistoryStep", () => {
  it("records empty-prompt image additions and interleaves them with text edits", () => {
    const img = sampleRetained("img-1", 0);
    const editor = createHarness().addImages("draft-1", [img]).type("hello");

    expect(editor.text()).toBe("hello");
    expect(editor.undoDepth()).toBe(2);

    editor.undo();
    expect(editor.text()).toBe("");
    expect(editor.appliedHistoryChanges()).toEqual([]);

    editor.undo();
    expect(editor.text()).toBe("");
    expect(editor.appliedHistoryChanges()).toEqual([
      [{ kind: "remove", targetKey: "draft-1", images: [img] }],
    ]);

    editor.redo();
    expect(editor.text()).toBe("");
    expect(editor.appliedHistoryChanges()).toEqual([
      [{ kind: "remove", targetKey: "draft-1", images: [img] }],
      [{ kind: "add", targetKey: "draft-1", images: [img] }],
    ]);

    editor.redo();
    expect(editor.text()).toBe("hello");
  });

  it("pairs inline chip insertion with image payloads in one atomic undo/redo event", () => {
    const imgA = sampleRetained("img-a", 1);
    const imgB = sampleRetained("img-b", 2);
    const editor = createHarness("Check ").addImages("draft-1", [imgA, imgB], "[a] [b] ");

    expect(editor.text()).toBe("Check [a] [b] ");
    editor.undo();
    expect(editor.text()).toBe("Check ");
    expect(editor.appliedHistoryChanges()[0]).toEqual([
      { kind: "remove", targetKey: "draft-1", images: [imgA, imgB] },
    ]);

    editor.redo();
    expect(editor.text()).toBe("Check [a] [b] ");
    expect(editor.appliedHistoryChanges()[1]).toEqual([
      { kind: "add", targetKey: "draft-1", images: [imgA, imgB] },
    ]);
  });
});

describe("inlineContextReferenceRemovalRanges", () => {
  const ref = formatInlineContextReference({
    kind: "image",
    contextId: "image_1",
    label: "image.png",
  });

  it.each([
    { prompt: `Check ${ref} `, expected: "Check" },
    { prompt: `Check ${ref} carefully`, expected: "Check carefully" },
    { prompt: `${ref} ${ref}`, expected: "" },
  ])("removes every reference in $prompt", ({ prompt, expected }) => {
    let result = prompt;
    for (const range of inlineContextReferenceRemovalRanges(prompt, "image_1").toReversed()) {
      result = result.slice(0, range.start) + result.slice(range.end);
    }
    expect(result).toBe(expected);
  });
});
