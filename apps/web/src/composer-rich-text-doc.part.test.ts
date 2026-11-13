import { Editor, getSchemaByResolvedExtensions, Node, resolveExtensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskList } from "@tiptap/extension-task-list";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { splitBlockKeepMarks } from "@tiptap/pm/commands";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import {
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  pastedPathQueryLength,
} from "./composer-logic";
import {
  buildDocJson,
  buildTiptapContent,
  caretTakesMarksBefore,
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerListExtensions,
  ComposerBoldExtension,
  ComposerCodeExtension,
  ComposerItalicExtension,
  ComposerStrikeExtension,
  ComposerTaskItemExtension,
  flatToMarkdown,
  flatToPm,
  markdownToFlat,
  pmToFlat,
  serializeEditorDoc,
  serializeSelection,
  skillChipReplacements,
  stepCaretAcrossStyledEdge,
} from "./composer-rich-text-doc";

function stubAtom(name: string, attrs: Record<string, { default: unknown }>) {
  return Node.create({
    name,
    group: "inline",
    inline: true,
    atom: true,
    addAttributes: () => attrs,
  });
}

const schema = getSchemaByResolvedExtensions(
  resolveExtensions([
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      code: false,
    }),
    ComposerCodeExtension,
    stubAtom("composer-mention", { path: { default: "" }, source: { default: "" } }),
    stubAtom("composer-skill", {
      skillName: { default: "" },
      skillLabel: { default: "" },
      skillDescription: { default: null },
    }),
    stubAtom("composer-citation", {
      citation: { default: null },
      source: { default: "" },
      citeKey: { default: "" },
    }),
    stubAtom("composer-context-reference", {
      kind: { default: "" },
      contextId: { default: "" },
      label: { default: "" },
      source: { default: "" },
    }),
    TaskList,
    ComposerTaskItemExtension,
    ComposerCodeBlockExtension,
    ...ComposerListExtensions,
    ...ComposerBlockExtensions,
  ]),
);

function roundTrip(value: string) {
  const json = buildDocJson(value, (name) => ({ label: name, description: null }));
  const doc = ProseMirrorNode.fromJSON(schema, json);
  // `insertContent` validates every node against the schema; `fromJSON` does not.
  doc.check();
  return serializeEditorDoc(doc);
}

const plainSchema = getSchemaByResolvedExtensions(
  resolveExtensions([
    StarterKit.configure({
      blockquote: false,
      bulletList: false,
      codeBlock: false,
      heading: false,
      horizontalRule: false,
      listItem: false,
      orderedList: false,
      dropcursor: false,
      gapcursor: false,
      trailingNode: false,
      bold: false,
      italic: false,
      strike: false,
      code: false,
    }),
    stubAtom("composer-mention", { path: { default: "" }, source: { default: "" } }),
    stubAtom("composer-skill", {
      skillName: { default: "" },
      skillLabel: { default: "" },
      skillDescription: { default: null },
    }),
    stubAtom("composer-citation", {
      citation: { default: null },
      source: { default: "" },
      citeKey: { default: "" },
    }),
    stubAtom("composer-context-reference", {
      kind: { default: "" },
      contextId: { default: "" },
      label: { default: "" },
      source: { default: "" },
    }),
    TaskList,
    ComposerTaskItemExtension,
  ]),
);

function roundTripPlain(value: string) {
  const json = buildDocJson(value, (name) => ({ label: name, description: null }), {
    styling: false,
  });
  const doc = ProseMirrorNode.fromJSON(plainSchema, json);
  return serializeEditorDoc(doc);
}

describe("serializeSelection", () => {
  function copy(value: string, first: string, last: string) {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson(value, (name) => ({ label: name, description: null })),
    );
    let from = -1;
    let to = -1;
    doc.descendants((node, pos) => {
      if (!node.isText) return true;
      const text = node.text ?? "";
      if (from < 0 && text.includes(first)) from = pos + text.indexOf(first);
      if (text.includes(last)) to = pos + text.lastIndexOf(last) + last.length;
      return false;
    });
    return serializeSelection(doc, from, to);
  }

  it("keeps the markers of the list items it spans", () => {
    expect(copy("- one\n- two\n- three", "one", "two")).toBe("- one\n- two");
    expect(copy("3) one\n4) two", "one", "two")).toBe("3) one\n4) two");
    expect(copy("- [ ] one\n- [x] two", "one", "two")).toBe("- [ ] one\n- [x] two");
  });

  it("keeps the nesting of an item and its children", () => {
    expect(copy("- p\n  - a\n  - b", "p", "a")).toBe("- p\n  - a");
  });
});

describe("pasting into a list item or quote", () => {
  it("keeps inline marks but builds no blocks", () => {
    const content = buildTiptapContent(
      "**bold** text\n- item\n> quote",
      () => ({ label: "", description: null }),
      { styling: true, blocks: false },
    );
    expect(content.map((block) => block.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    const first = content[0] as { content: { text: string; marks?: { type: string }[] }[] };
    expect(first.content[0]).toMatchObject({ text: "bold", marks: [{ type: "bold" }] });
    expect(JSON.stringify(content[1])).toContain("- item");
    expect(JSON.stringify(content[2])).toContain("> quote");
  });
});

describe("pasting into a path query", () => {
  const skillLabelFor = (name: string) => ({ label: name, description: null });

  function paste(prompt: string | ProseMirrorNode, pasted: string, pathQueryActive = true) {
    const promptDoc =
      typeof prompt === "string"
        ? ProseMirrorNode.fromJSON(schema, buildDocJson(prompt, skillLabelFor))
        : prompt;
    const line = promptDoc.lastChild!;
    const lineBefore = line.textBetween(0, line.content.size, undefined, "\uFFFC");
    const literalLength = pastedPathQueryLength(lineBefore, pasted, pathQueryActive);
    const blocks = buildTiptapContent(pasted, skillLabelFor, { literalLength });
    const [first, ...rest] = blocks.map((block) => ProseMirrorNode.fromJSON(schema, block));
    const head = promptDoc.lastChild!.content.append(first!.content);
    const doc = schema.node("doc", null, [first!.copy(head), ...rest]);
    doc.check();
    return doc;
  }

  function boldText(doc: ProseMirrorNode) {
    const bold: string[] = [];
    doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === "bold")) {
        bold.push(node.text!);
      }
    });
    return bold;
  }

  it.each(["src/__test__.tsx", "src/__tests__/a.ts", "pkg/__init__.py", "a/**b**/c"])(
    "keeps %s literal after @ so file search can match it",
    (path) => {
      const doc = paste("Open @", path);
      expect(boldText(doc)).toEqual([]);
      expect(serializeEditorDoc(doc).value).toBe(`Open @${path}`);
    },
  );

  it("still styles the text after the path", () => {
    const doc = paste("Open @", "src/__test__.tsx and **this**\n- [ ] then __that__");
    expect(boldText(doc)).toEqual(["this", "that"]);
    expect(doc.lastChild!.type.name).toBe("taskList");
    expect(serializeEditorDoc(doc).value).toBe(
      "Open @src/__test__.tsx and **this**\n- [ ] then **that**",
    );
  });

  it("parses markdown after Escape dismisses the path query", () => {
    const doc = paste("Open @", "__hello__ world", false);
    expect(boldText(doc)).toEqual(["hello"]);
    expect(serializeEditorDoc(doc).value).toBe("Open @**hello** world");
  });

  it("keeps the rest of the path's line on that line", () => {
    const doc = paste("Open @", "src/a.ts - not a list item");
    expect(doc.childCount).toBe(1);
    expect(serializeEditorDoc(doc).value).toBe("Open @src/a.ts - not a list item");
  });

  it("parses markdown when the paste does not continue a path query", () => {
    expect(boldText(paste("Open ", "src/__test__.tsx"))).toEqual(["test"]);
    expect(boldText(paste("Open @a ", "__b__"))).toEqual(["b"]);
    expect(boldText(paste("Open @", " __b__"))).toEqual(["b"]);
  });

  it("keeps a path literal after a partly styled query", () => {
    const doc = paste("Open @**src/**", "__test__.tsx");
    expect(boldText(doc)).toEqual(["src/"]);
    expect(serializeEditorDoc(doc).value).toBe("Open @**src/**__test__.tsx");
  });

  // regression: #16619 paths pasted after @ lost their underscores to markdown parsing
  it("parses markdown pasted right after a mention chip", () => {
    const withSpace = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson("Open @README.md ", skillLabelFor),
    );
    const paragraph = withSpace.firstChild!;
    expect(paragraph.lastChild!.text).toBe(" ");
    const chipLast = schema.node("doc", null, [
      paragraph.copy(paragraph.content.cut(0, paragraph.content.size - 1)),
    ]);
    expect(chipLast.firstChild!.lastChild!.type.name).toBe("composer-mention");
    expect(boldText(paste(chipLast, "__b__"))).toEqual(["b"]);
  });
});

describe("caret stops at styled edges", () => {
  function stateAt(value: string, pmPos: number) {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson(value, (name) => ({ label: name, description: null })),
    );
    return EditorState.create({ doc, selection: TextSelection.create(doc, pmPos) });
  }

  function typed(state: EditorState, text: string) {
    return serializeEditorDoc(state.apply(state.tr.insertText(text)).doc).value;
  }

  it("lets the caret step out in front of bold that starts the line", () => {
    const inside = stateAt("**bold** tail", 1);
    expect(caretTakesMarksBefore(inside)).toBe(false);
    expect(typed(inside, "x")).toBe("**xbold** tail");

    const step = stepCaretAcrossStyledEdge(inside, -1);
    expect(step).not.toBeNull();
    const outside = inside.apply(step!);
    expect(caretTakesMarksBefore(outside)).toBe(true);
    expect(typed(outside, "x")).toBe("x**bold** tail");
    expect(stepCaretAcrossStyledEdge(outside, -1)).toBeNull();

    const back = outside.apply(stepCaretAcrossStyledEdge(outside, 1)!);
    expect(typed(back, "x")).toBe("**xbold** tail");
  });

  it("lets the caret step out after bold that ends the line", () => {
    const inside = stateAt("head **bold**", 10);
    expect(caretTakesMarksBefore(inside)).toBe(true);
    expect(typed(inside, "x")).toBe("head **boldx**");
    expect(stepCaretAcrossStyledEdge(inside, -1)).toBeNull();

    const outside = inside.apply(stepCaretAcrossStyledEdge(inside, 1)!);
    expect(caretTakesMarksBefore(outside)).toBe(false);
    expect(typed(outside, "x")).toBe("head **bold**x");
  });

  // regression: #13217 could not type in front of bold that starts a composer line
  it("offers both stops where styled text meets plain text mid-line", () => {
    const plain = stateAt("a **b** c", 3);
    expect(caretTakesMarksBefore(plain)).toBe(true);
    expect(typed(plain, "x")).toBe("a x**b** c");
    const bold = plain.apply(stepCaretAcrossStyledEdge(plain, 1)!);
    expect(typed(bold, "x")).toBe("a **xb** c");
  });

  it("offers the plain stop between bold text and a chip right after it", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [
        schema.text("bold", [schema.marks.bold!.create()]),
        schema.nodes["composer-mention"]!.create({ path: "README.md", source: "@README.md" }),
      ]),
    ]);
    const inside = EditorState.create({ doc, selection: TextSelection.create(doc, 5) });
    expect(caretTakesMarksBefore(inside)).toBe(true);
    const outside = inside.apply(stepCaretAcrossStyledEdge(inside, 1)!);
    expect(caretTakesMarksBefore(outside)).toBe(false);
    const withText = outside.apply(outside.tr.insertText("x")).doc;
    expect(withText.child(0).child(1).text).toBe("x");
    expect(withText.child(0).child(1).marks).toEqual([]);
  });

  it("steps out of inline code at the end of a line without inserting a space", () => {
    expect(ComposerCodeExtension.config.exitable).toBe(false);
    const inside = stateAt("`code`", 5);
    const outside = inside.apply(stepCaretAcrossStyledEdge(inside, 1)!);
    expect(typed(outside, "x")).toBe("`code`x");
    expect(stepCaretAcrossStyledEdge(outside, 1)).toBeNull();
  });

  it("keeps marks the user toggled at an edge and lets the arrow move", () => {
    const inside = stateAt("a **b** c", 3);
    const toggled = inside.apply(
      inside.tr.setStoredMarks([schema.marks.bold!.create(), schema.marks.italic!.create()]),
    );
    expect(stepCaretAcrossStyledEdge(toggled, 1)).toBeNull();
    expect(stepCaretAcrossStyledEdge(toggled, -1)).toBeNull();
  });
});

describe("inline code entry", () => {
  function editorFor(block = "paragraph", mark?: string) {
    const editor = new Editor({
      element: null,
      extensions: [
        StarterKit.configure({
          bold: false,
          code: false,
          codeBlock: false,
          italic: false,
          strike: false,
          trailingNode: false,
        }),
        ComposerBoldExtension,
        ComposerItalicExtension,
        ComposerStrikeExtension,
        ComposerCodeExtension,
        ComposerCodeBlockExtension,
        stubAtom("composer-mention", { path: { default: "" }, source: { default: "" } }),
      ],
      content: { type: "doc", content: [{ type: block }] },
    });
    // Unmounted editors need the same plugins that Tiptap installs on mount.
    editor.view.updateState(editor.state.reconfigure({ plugins: editor.extensionManager.plugins }));
    if (mark) editor.commands.setMark(mark);
    onTestFinished(() => editor.destroy());
    return editor;
  }

  function type(editor: Editor, text: string) {
    for (const ch of text) {
      const { from, to } = editor.state.selection;
      const insert = () => editor.state.tr.insertText(ch, from, to);
      const handled = editor.state.plugins.some((plugin) =>
        plugin.props.handleTextInput?.call(plugin, editor.view, from, to, ch, insert),
      );
      if (!handled) editor.view.dispatch(insert());
    }
  }

  function marked(editor: Editor, name: string) {
    const text: string[] = [];
    editor.state.doc.descendants((node) => {
      if (node.isText && node.marks.some((mark) => mark.type.name === name)) {
        text.push(node.text ?? "");
      }
    });
    return text;
  }

  /** Types `text` into a backtick pair and steps the caret out so it formats. */

  function typeCode(editor: Editor, text: string) {
    const offset = editor.state.selection.from;
    type(editor, "``");
    editor.commands.setTextSelection(offset + 1);
    type(editor, text);
    editor.commands.setTextSelection(offset + text.length + 2);
    expect(marked(editor, "code")).toContain(text);
  }

  it.each(["", "this is a "])(
    "formats code after %j when the opening backtick is typed last",
    (prefix) => {
      const editor = editorFor();
      type(editor, `${prefix}test\` after`);
      editor.commands.setTextSelection(prefix.length + 1);
      type(editor, "`");

      expect(editor.state.doc.textContent).toBe(`${prefix}test after`);
      expect(serializeEditorDoc(editor.state.doc).value).toBe(`${prefix}\`test\` after`);
      expect(editor.state.selection.from).toBe(prefix.length + 1);
      type(editor, "new ");
      expect(serializeEditorDoc(editor.state.doc).value).toBe(`${prefix}\`new test\` after`);
      editor.commands.setTextSelection(editor.state.doc.content.size - 1);
      type(editor, " plain");
      expect(serializeEditorDoc(editor.state.doc).value).toBe(`${prefix}\`new test\` after plain`);
      const formatted = editor.state.doc.toJSON();
      let undos = 0;
      while (editor.commands.undo()) undos += 1;
      expect(undos).toBeGreaterThan(0);
      expect(editor.state.doc.textContent).toBe("");
      for (let i = 0; i < undos; i += 1) expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(formatted);
    },
  );

  it.each([
    { name: "doubled closing ticks", text: "test``" },
    { name: "a code block", text: "test`", block: "codeBlock" },
    { name: "bold text", text: "test`", mark: "bold" },
    { name: "existing inline code", text: "test`", mark: "code" },
  ])("keeps an opening tick literal before $name", ({ text, block, mark }) => {
    const editor = editorFor(block, mark);
    type(editor, text);
    editor.commands.setTextSelection(1);
    type(editor, "`");
    expect(editor.state.doc.textContent).toBe(`\`${text}`);
  });

  it.each(["hardBreak", "composer-mention"])("does not pair ticks across a %s", (nodeType) => {
    const editor = editorFor();
    type(editor, "before");
    editor.commands.insertContent({ type: nodeType });
    type(editor, "after`");
    editor.commands.setTextSelection(1);
    type(editor, "`");
    expect(editor.state.doc.firstChild?.firstChild?.marks).toEqual([]);
    expect(editor.state.doc.textContent).toBe("`beforeafter`");

    const local = editorFor();
    type(local, "a ` ");
    local.commands.insertContent({ type: nodeType });
    type(local, "`local`");
    expect(local.state.doc.firstChild?.lastChild?.toJSON()).toEqual({
      type: "text",
      marks: [{ type: "code" }],
      text: "local",
    });
  });

  it.each(["", "prefix ", "@README.md", "a ``` "])(
    "formats a filled pair after %j, leaves following text plain, and keeps the normal input rule",
    (prefix) => {
      const editor = editorFor();
      if (prefix === "@README.md") {
        editor.commands.insertContent({
          type: "composer-mention",
          attrs: { path: "README.md", source: prefix },
        });
      } else {
        type(editor, prefix);
      }
      const offset = editor.state.selection.from - 1;
      type(editor, "``");
      editor.commands.setTextSelection(offset + 2);
      type(editor, "hello world");
      expect(serializeEditorDoc(editor.state.doc).value).toBe(`${prefix}\`hello world\``);
      expect(editor.state.doc.firstChild?.lastChild?.marks).toEqual([]);

      editor.commands.setTextSelection(offset + 14);
      expect(editor.state.doc.textContent).toBe(
        `${prefix === "@README.md" ? "" : prefix}hello world`,
      );
      expect(serializeEditorDoc(editor.state.doc).value).toBe(`${prefix}\`hello world\``);
      type(editor, " next `typed`");
      expect(serializeEditorDoc(editor.state.doc).value).toBe(
        `${prefix}\`hello world\` next \`typed\``,
      );
      const formatted = editor.state.doc.toJSON();
      let undos = 0;
      while (editor.commands.undo()) undos += 1;
      expect(undos).toBeGreaterThan(0);
      expect(serializeEditorDoc(editor.state.doc).value).toBe("");
      for (let i = 0; i < undos; i += 1) expect(editor.commands.redo()).toBe(true);
      expect(editor.state.doc.toJSON()).toEqual(formatted);
    },
  );

  it.each([
    [
      "formats a pair",
      "do ",
      [
        { type: "text", text: "do " },
        { type: "text", marks: [{ type: "code" }], text: "xyz" },
      ],
    ],
    [
      "keeps a pair literal after an unmatched backtick",
      "a ` ",
      [{ type: "text", text: "a ` `xyz`" }],
    ],
  ])("%s whose backticks came from a dead key", (_name, prefix, content) => {
    const editor = editorFor();
    type(editor, prefix);
    editor.view.dispatch(editor.state.tr.insertText("`").setMeta("composition", 1));
    editor.view.dispatch(editor.state.tr.insertText("`").setMeta("composition", 2));
    editor.commands.setTextSelection(prefix.length + 2);
    type(editor, "xyz");
    expect(editor.state.doc.textContent).toBe(`${prefix}\`xyz\``);

    editor.commands.setTextSelection(prefix.length + 6);
    expect(editor.state.doc.firstChild?.toJSON().content).toEqual(content);
  });

  it("does not reuse the closing backtick of a literal pair to open code", () => {
    const editor = editorFor();
    editor.view.dispatch(editor.state.tr.insertText("is `enabled`", 1));
    type(editor, " and `");
    expect(editor.state.doc.firstChild?.toJSON().content).toEqual([
      { type: "text", text: "is `enabled` and `" },
    ]);

    type(editor, "persist`");
    expect(editor.state.doc.firstChild?.toJSON().content).toEqual([
      { type: "text", text: "is `enabled` and " },
      { type: "text", marks: [{ type: "code" }], text: "persist" },
    ]);
  });

  it("keeps composition edits literal until the caret leaves the typed pair", () => {
    const editor = editorFor();
    type(editor, "``");
    editor.commands.setTextSelection(2);
    editor.view.dispatch(editor.state.tr.insertText("世").setMeta("composition", 1));
    editor.view.dispatch(editor.state.tr.insertText("世界", 2, 3).setMeta("composition", 1));
    expect(editor.state.doc.textContent).toBe("`世界`");
    expect(editor.state.doc.firstChild?.firstChild?.marks).toEqual([]);
    editor.commands.setTextSelection(5);
    expect(editor.state.doc.textContent).toBe("世界");
    expect(serializeEditorDoc(editor.state.doc).value).toBe("`世界`");
  });

  it.each(["paste", "setContent"])("keeps a %s pair literal after moving through it", (source) => {
    const editor = editorFor();
    const literal = "`literal`";
    if (source === "paste") {
      editor.view.dispatch(editor.state.tr.insertText(literal).setMeta("uiEvent", "paste"));
    } else {
      type(editor, "``");
      editor.commands.setContent({
        type: "doc",
        content: [{ type: "paragraph", content: [{ type: "text", text: literal }] }],
      });
    }
    const before = editor.state.doc.toJSON();
    editor.commands.setTextSelection(2);
    editor.commands.setTextSelection(literal.length + 1);
    expect(editor.state.doc.toJSON()).toEqual(before);
  });

  it.each([
    { name: "doubled delimiters", delimiters: "````", caret: 3 },
    { name: "doubled closing delimiters", delimiters: "```", caret: 2 },
    { name: "bold text", delimiters: "``", caret: 2, mark: "bold" },
    { name: "existing inline code", delimiters: "``", caret: 2, mark: "code" },
    { name: "a code block", delimiters: "``", caret: 2, block: "codeBlock" },
  ])("leaves $name unchanged on caret movement", ({ delimiters, caret, mark, block }) => {
    const editor = editorFor(block, mark);
    type(editor, delimiters);
    editor.commands.setTextSelection(caret);
    type(editor, "literal");
    const before = editor.state.doc.toJSON();
    // Visit both the gap between closing ticks and the end of the pair.
    editor.commands.setTextSelection(caret + "literal".length + 1);
    expect(editor.state.doc.toJSON()).toEqual(before);
    editor.commands.setTextSelection(editor.state.doc.content.size - 1);
    expect(editor.state.doc.toJSON()).toEqual(before);
  });

  it.each([
    { mark: "italic", open: "*" },
    { mark: "bold", open: "**" },
    { mark: "strike", open: "~~" },
  ])("keeps a $mark delimiter inside an earlier code span literal", ({ mark, open }) => {
    const editor = editorFor();
    typeCode(editor, `${open}foo`);
    type(editor, ` bar \`${open}`);
    expect(serializeEditorDoc(editor.state.doc).value).toBe(`\`${open}foo\` bar \`${open}`);
    expect(marked(editor, mark)).toEqual([]);
    expect(marked(editor, "code")).toEqual([`${open}foo`]);
  });

  it.each([
    { mark: "italic", open: "*" },
    { mark: "bold", open: "**" },
    { mark: "strike", open: "~~" },
  ])("still wraps a code span in $mark when both delimiters are outside it", ({ mark, open }) => {
    const editor = editorFor();
    type(editor, open);
    typeCode(editor, "foo");
    type(editor, ` bar${open}`);
    expect(serializeEditorDoc(editor.state.doc).value).toBe(`${open}\`foo\` bar${open}`);
    expect(marked(editor, mark)).toEqual(["foo", " bar"]);

    editor.commands.setContent({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: `${open}foo tail ` },
            { type: "text", text: "x", marks: [{ type: "code" }] },
          ],
        },
      ],
    });
    editor.commands.setTextSelection({
      from: open.length + 4,
      to: editor.state.doc.content.size - 1,
    });
    type(editor, open);
    expect(serializeEditorDoc(editor.state.doc).value).toBe(`${open}foo${open}`);
    expect(marked(editor, mark)).toEqual(["foo"]);
  });
});
