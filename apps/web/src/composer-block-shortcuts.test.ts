import { Editor } from "@tiptap/core";
import { closeHistory, redo, undo } from "@tiptap/pm/history";
import { splitBlock } from "@tiptap/pm/commands";
import { TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { describe, expect, it, onTestFinished } from "vite-plus/test";

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

function createEditor(value: string) {
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
  // Headless editors need the plugins installed explicitly because there is no mounted view.
  editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
  onTestFinished(() => editor.destroy());
  return editor;
}

function press(value: string, spec: string) {
  const editor = createEditor(value);
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

describe("composer list normalization", () => {
  it("converts a dash edited on an earlier line and keeps the view equal to Markdown", () => {
    const editor = createEditor("");
    editor.view.dispatch(editor.state.tr.insertText("-get md"));
    splitBlock(editor.state, editor.view.dispatch);
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2)));
    editor.view.dispatch(editor.state.tr.insertText(" "));
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));

    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
    expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe("get md");
    expect(serializeEditorDoc(editor.state.doc).value).toBe("- get md\n");
    expect(
      editor.state.doc.eq(
        editor.schema.nodeFromJSON(
          buildDocJson(serializeEditorDoc(editor.state.doc).value, (name) => ({
            label: name,
            description: null,
          })),
        ),
      ),
    ).toBe(true);
  });

  it("converts a dash and space typed before existing text", () => {
    const editor = createEditor("existing text");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atStart(editor.state.doc)));
    editor.view.dispatch(editor.state.tr.insertText("-"));
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    editor.view.dispatch(editor.state.tr.insertText(" "));
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
    expect(editor.state.selection.$from.parentOffset).toBe(0);
    expect(serializeEditorDoc(editor.state.doc).value).toBe("- existing text");
  });

  it.each(["[link](url)", "[ordinary text]", "[x]text"])(
    "converts a dash before existing bracket-prefixed text %j",
    (text) => {
      const editor = createEditor(text);
      editor.view.dispatch(editor.state.tr.insertText("- ", 1));
      expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
      expect(editor.state.doc.firstChild?.firstChild?.textContent).toBe(text);
      expect(serializeEditorDoc(editor.state.doc).value).toBe(`- ${text}`);
    },
  );

  it.each(["- ", "* ", "+ ", "3) ", "4. ", "- [ ] ", "- [x] "])(
    "converts %j inserted in front of existing text",
    (marker) => {
      const editor = createEditor("existing text");
      editor.view.dispatch(editor.state.tr.insertText(marker, 1));
      const list = editor.state.doc.firstChild!;
      expect(list.type.name).toBe(
        marker.includes("[") ? "taskList" : /^\d/.test(marker) ? "orderedList" : "bulletList",
      );
      expect(list.firstChild?.textContent).toBe("existing text");
      expect(serializeEditorDoc(editor.state.doc).value).toBe(`${marker}existing text`);
    },
  );

  it.each(["a - b", "-x", "-"])("leaves %j as a paragraph", (text) => {
    const editor = createEditor("");
    editor.view.dispatch(editor.state.tr.insertText(text));
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe(text);
  });

  it("undoes the insertion and conversion together and can redo them", () => {
    const editor = createEditor("existing text");
    editor.view.dispatch(closeHistory(editor.state.tr).insertText("- ", 1));
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe("existing text");
    expect(redo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
  });

  it("keeps the dash gesture available until a task marker is complete", () => {
    const editor = createEditor("");
    for (const ch of "- [x]") {
      editor.view.dispatch(editor.state.tr.insertText(ch));
      expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    }
    editor.view.dispatch(editor.state.tr.insertText(" "));
    expect(editor.state.doc.firstChild?.type.name).toBe("taskList");
    expect(editor.state.doc.firstChild?.firstChild?.attrs.checked).toBe(true);
  });

  it("normalizes pasted markers without waiting for another keystroke", () => {
    const editor = createEditor("existing text");
    editor.view.dispatch(editor.state.tr.insertText("- ", 1).setMeta("uiEvent", "paste"));
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
  });

  it.each(["```\ncode\n```", "- outer\n  - inner", "> quoted"])(
    "does not convert paragraphs inside %j",
    (value) => {
      const editor = createEditor(value);
      let position = 0;
      editor.state.doc.descendants((node, pos) => {
        if (node.isText) position = pos;
      });
      const before: string[] = [];
      editor.state.doc.descendants((node) => {
        before.push(node.type.name);
      });
      editor.view.dispatch(editor.state.tr.insertText("- ", position));
      const after: string[] = [];
      editor.state.doc.descendants((node) => {
        after.push(node.type.name);
      });
      expect(after).toEqual(before);
      expect(editor.state.doc.textContent).toContain("- ");
    },
  );

  it("waits for a non-composition transaction before changing paragraph structure", () => {
    const editor = createEditor("");
    editor.view.dispatch(editor.state.tr.insertText("- text").setMeta("composition", 1));
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    editor.view.dispatch(editor.state.tr.insertText("日本語", 3, 7).setMeta("composition", 1));
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    editor.view.dispatch(editor.state.tr.insertText("確定", 3, 6).setMeta("composition", 1));
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atEnd(editor.state.doc)));
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
    expect(serializeEditorDoc(editor.state.doc).value).toBe("- 確定");
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.state.doc.textContent).toBe("");
    expect(redo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
  });

  it("does not immediately reconvert a literal marker restored by undo", () => {
    const editor = createEditor("");
    editor.view.dispatch(editor.state.tr.insertText("- "));
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    editor.view.dispatch(closeHistory(editor.state.tr).insertText("text"));
    expect(editor.state.doc.firstChild?.type.name).toBe("bulletList");
    expect(undo(editor.state, editor.view.dispatch)).toBe(true);
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.textContent).toBe("- ");
    editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atStart(editor.state.doc)));
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
  });

  it("preserves formatting and the caret when removing the literal prefix", () => {
    const editor = createEditor("**text**");
    editor.view.dispatch(editor.state.tr.insert(1, editor.schema.text("- ")));
    expect(editor.state.selection.$from.parent.type.name).toBe("paragraph");
    expect(editor.state.selection.$from.parentOffset).toBe(4);
    expect(serializeEditorDoc(editor.state.doc).value).toBe("- **text**");
  });

  it("does not turn an inline code marker into a list", () => {
    const editor = createEditor("`-text`");
    editor.view.dispatch(editor.state.tr.insertText(" ", 2));
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(serializeEditorDoc(editor.state.doc).value).toBe("`- text`");
  });

  it.each(["**- x**", "*-* x", "~~- x~~", "a\n**1.** b"])(
    "preserves styled markers when restoring %j",
    (value) => {
      const editor = createEditor("");
      editor.commands.setContent(
        buildDocJson(value, (name) => ({ label: name, description: null })),
        { emitUpdate: false },
      );
      expect(serializeEditorDoc(editor.state.doc).value).toBe(value);
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
      editor.view.dispatch(editor.state.tr.insertText("x", editor.state.doc.content.size - 1));
      expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
    },
  );

  it("only normalizes changed blocks", () => {
    const editor = createEditor("");
    editor.view.updateState(editor.state.reconfigure({ plugins: [] }));
    editor.view.dispatch(editor.state.tr.insertText("- untouched"));
    splitBlock(editor.state, editor.view.dispatch);
    editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
    editor.view.dispatch(editor.state.tr.insertText("changed"));
    expect(editor.state.doc.firstChild?.type.name).toBe("paragraph");
    expect(editor.state.doc.firstChild?.textContent).toBe("- untouched");
  });
});
