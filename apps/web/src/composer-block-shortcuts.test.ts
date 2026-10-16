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

const mac = typeof navigator !== "undefined" && /Mac|iP(hone|[oa]d)/.test(navigator.platform);

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

  it("still delivers the composer's own keys", () => {
    expect(press("**bold**", "Mod-b").handled).toBe(true);
  });

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
