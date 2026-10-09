import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDocJson,
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerListExtensions,
  ComposerTaskItemExtension,
  ComposerTaskListExtension,
  serializeEditorDoc,
} from "./composer-rich-text-doc";

// The same modifier ProseMirror's keymap reads "Mod" as.
const mac = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

/** A key chord as the browser reports it: key, keyCode and modifiers. */
function chord(spec: string) {
  const parts = spec.split("-");
  const key = parts.pop()!;
  const has = (name: string) => parts.includes(name);
  const base = key.length === 1 ? key.toUpperCase() : key;
  return {
    key: has("Shift") && /^\d$/.test(key) ? "!@#$%^&*("[Number(key) - 1]! : key,
    keyCode: base.length === 1 ? base.charCodeAt(0) : 0,
    shiftKey: has("Shift"),
    altKey: has("Alt"),
    metaKey: has("Mod") && mac,
    ctrlKey: has("Mod") && !mac,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as KeyboardEvent;
}

/**
 * Presses `spec` with the caret inside `value`, the way the composer's
 * editor would receive it, and returns the stored Markdown.
 */
function press(value: string, spec: string) {
  const editor = new Editor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        bulletList: false,
        codeBlock: false,
        heading: false,
        horizontalRule: false,
        listItem: false,
        orderedList: false,
        trailingNode: false,
      }),
      ComposerCodeBlockExtension,
      ...ComposerBlockExtensions,
      ...ComposerListExtensions,
      ComposerTaskListExtension,
      ComposerTaskItemExtension,
    ],
    content: buildDocJson(value, (name) => ({ label: name, description: null })),
  });
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
  // What the view's `someProp("handleKeyDown")` does, without mounting one:
  // offer the key to each extension plugin in order until one handles it.
  // An unmounted editor's state does not carry them yet, so they come from
  // the extension manager.
  const event = chord(spec);
  const before = editor.state.doc;
  const handled = editor.extensionManager.plugins.some((plugin) =>
    plugin.props.handleKeyDown?.call(plugin, editor.view, event),
  );
  return {
    handled,
    changed: !editor.state.doc.eq(before),
    value: serializeEditorDoc(editor.state.doc).value,
  };
}

// Tiptap's own block shortcuts would nest a list, task list, code block or
// heading inside a quote, or restructure a list item. The serializers only
// write what the composer's grammar has, so the nested block, and the text
// in it, would vanish from the stored draft. None of these are the
// composer's shortcuts; they must do nothing.
const BLOCK_CHORDS = [
  "Mod-Shift-8",
  "Mod-Shift-7",
  "Mod-Shift-9",
  "Mod-Shift-b",
  "Mod-Alt-c",
  "Mod-Alt-1",
  "Mod-Alt-3",
];

describe("Tiptap's block shortcuts", () => {
  it.each(BLOCK_CHORDS)("leave a quote's text alone on %s", (spec) => {
    expect(press("> keep this text", spec).value).toBe("> keep this text");
  });

  it.each(BLOCK_CHORDS)("leave a list item alone on %s", (spec) => {
    expect(press("- item", spec).value).toBe("- item");
  });

  it.each(BLOCK_CHORDS)("leave a paragraph alone on %s", (spec) => {
    expect(press("plain text", spec).value).toBe("plain text");
  });

  // Guards the harness itself: a chord the composer keeps must still reach
  // the keymap, or every case above would pass without pressing anything.
  it("still delivers the composer's own keys", () => {
    expect(press("**bold**", "Mod-b").handled).toBe(true);
  });

  // Sinking or lifting an item moves it without touching its `indent`, so
  // the stored draft keeps the old nesting and the next rebuild undoes the
  // move. Nesting belongs to the composer's own Tab, which edits the source.
  it.each([
    ["- p\n- a", "Tab"],
    ["- p\n  - a", "Shift-Tab"],
    ["- [ ] p\n- [ ] a", "Tab"],
    ["- [ ] p\n  - [ ] a", "Shift-Tab"],
  ])("leave the nesting of %j alone on %s", (value, spec) => {
    const result = press(value, spec);
    expect(result.changed).toBe(false);
    expect(result.value).toBe(value);
  });
});
