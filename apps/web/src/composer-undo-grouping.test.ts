import { getSchema } from "@tiptap/core";
import { history, undo } from "@tiptap/pm/history";
import { EditorState, TextSelection, type Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_UNDO_GROUP_DELAY,
  type ComposerChangeKind,
  groupUndoByChangeKind,
  markAsClipboardEdit,
} from "./composer-undo-grouping";

const schema = getSchema([StarterKit]);

/**
 * A composer-shaped editor state with the real history plugin, dispatching
 * through the same grouping rule the composer's extension applies. Keystrokes
 * land 80ms apart unless a gap says otherwise.
 */
function composer(text = "") {
  let clock = 0;
  let previous: ComposerChangeKind | null = null;
  let state = EditorState.create({
    schema,
    doc: schema.node("doc", null, [
      schema.node("paragraph", null, text ? [schema.text(text)] : []),
    ]),
    plugins: [history({ newGroupDelay: COMPOSER_UNDO_GROUP_DELAY })],
  });
  const dispatch = (tr: Transaction) => {
    tr.setTime(clock);
    previous = groupUndoByChangeKind(tr, previous);
    state = state.apply(tr);
  };
  dispatch(state.tr.setSelection(TextSelection.atEnd(state.doc)));
  const api = {
    text: () => state.doc.textContent,
    wait: (ms: number) => ((clock += ms), api),
    type: (s: string, gap = 80) => {
      for (const ch of s) {
        clock += gap;
        dispatch(state.tr.insertText(ch));
      }
      return api;
    },
    backspace: (n: number) => {
      for (let i = 0; i < n; i += 1) {
        clock += 80;
        const at = state.selection.from;
        dispatch(state.tr.delete(at - 1, at));
      }
      return api;
    },
    /**
     * The transaction the composer's `handlePaste` dispatches: a plain insert,
     * tagged by `markAsClipboardEdit`. ProseMirror's own paste path would tag
     * it, but the composer takes every text paste before that path runs.
     */
    paste: (s: string) => {
      clock += 80;
      dispatch(markAsClipboardEdit(state.tr.insertText(s), "paste"));
      return api;
    },
    /** The composer's cut handler: a plain delete of the selection, tagged. */
    cut: (n: number) => {
      clock += 80;
      const at = state.selection.from;
      dispatch(markAsClipboardEdit(state.tr.delete(at - n, at), "cut"));
      return api;
    },
    /** A store-driven rewrite: autocomplete inserting a chip, list continuation. */
    rewrite: (next: string) => {
      clock += 80;
      dispatch(
        state.tr.replaceWith(
          0,
          state.doc.content.size,
          schema.node("paragraph", null, [schema.text(next)]),
        ),
      );
      dispatch(state.tr.setSelection(TextSelection.atEnd(state.doc)));
      return api;
    },
    /** IME input replaces its own range on every keystroke. */
    compose: (s: string) => {
      const start = state.selection.from;
      for (let i = 1; i <= s.length; i += 1) {
        clock += 80;
        dispatch(
          state.tr.insertText(s.slice(0, i), start, start + i - 1).setMeta("composition", 1),
        );
      }
      return api;
    },
    undo: () => (undo(state, dispatch), api),
  };
  return api;
}

describe("composer undo grouping", () => {
  it("keeps a continuous run of typing as one step", () => {
    expect(composer().type("hello world").undo().text()).toBe("");
  });

  it("starts a new step when typing turns into deleting, and back", () => {
    const editor = composer().type("hello world").backspace(5).type("there");
    expect(editor.text()).toBe("hello there");
    expect(editor.undo().text()).toBe("hello ");
    expect(editor.undo().text()).toBe("hello world");
    expect(editor.undo().text()).toBe("");
  });

  it("gives a store rewrite its own step, and typing after it another", () => {
    const editor = composer("draft ").type("one").rewrite("draft one @chip ").type("then");
    expect(editor.undo().text()).toBe("draft one @chip ");
    expect(editor.undo().text()).toBe("draft one");
    expect(editor.undo().text()).toBe("draft ");
  });

  it("gives a paste its own step", () => {
    const editor = composer().type("see ").paste("pasted text").type(" ok");
    expect(editor.undo().text()).toBe("see pasted text");
    expect(editor.undo().text()).toBe("see ");
  });

  it("gives a cut its own step between deletions", () => {
    const editor = composer().type("hello world").backspace(1).cut(3).backspace(1);
    expect(editor.text()).toBe("hello ");
    expect(editor.undo().text()).toBe("hello w");
    expect(editor.undo().text()).toBe("hello worl");
    expect(editor.undo().text()).toBe("hello world");
  });

  it("keeps IME composition as one run of typing", () => {
    expect(composer().type("go ").compose("にほん").undo().text()).toBe("");
  });

  it("merges typing across a short pause and splits it across a long one", () => {
    expect(composer().type("hello").wait(700).type(" world").undo().text()).toBe("");
    expect(composer().type("hello").wait(1100).type(" world").undo().text()).toBe("hello");
  });
});
