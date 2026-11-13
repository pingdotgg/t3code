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

describe("editable math source", () => {
  it.each(["app/routes/posts.$postId.tsx", "pages/posts/[id].tsx"])(
    "keeps a mentioned file whose name looks like TeX as a chip: %s",
    (path) => {
      const source = `fix ${serializeComposerFileLink(path)} please`;
      const map = roundTrip(source);
      expect(map.value).toBe(source);
      expect(
        map.runs.filter((run) => run.kind === "token" && run.nodeName === "composer-mention"),
      ).toHaveLength(1);
    },
  );

  it.each([
    "before $x + @README.md$ after",
    "before \\(x + @README.md\\) after",
    "\\[x + @README.md\\] after",
  ])("keeps a mention that ends a formula inside the formula: %s", (source) => {
    const map = roundTrip(source);
    expect(map.value).toBe(source);
    expect(map.runs.some((run) => run.kind === "token")).toBe(false);
  });

  it.each([
    "Area $x_i^2$ after",
    "before \\(\\frac{1}{2}\\) after",
    "before $$x^2$$ after",
    "\\[\nx = 1\ny = 2\n\\]",
    "\\[\\text{use $browser then @README.md and **literal**}\\]",
    "```math\nx_i + y_i\n```",
    "- **use** $x_i$ then @README.md",
    "**$x_i$** and **A $x_i$ B**",
    "| Name | Formula |\n| --- | --- |\n| Norm | $|x|$ |",
    "| Name | Formula |\n| --- | --- |\n| Norm | \\(\\|x\\|\\) |",
  ])("keeps TeX editable and round trips its source: %s", (source) => {
    const map = roundTrip(source);
    expect(map.value).toBe(source);
    expect(map.runs.some((run) => run.nodeName === "composer-math")).toBe(false);
    const doc = schema.nodeFromJSON(
      buildDocJson(source, (name) => ({ label: name, description: null })),
    );
    expect(serializeSelection(doc, 1, doc.content.size - 1)).toBe(source);
  });

  it("edits a command character directly without replacing a formula node", () => {
    const source = "before \\(\\frac{a}{b}\\) after";
    const doc = schema.nodeFromJSON(
      buildDocJson(source, (name) => ({ label: name, description: null })),
    );
    const map = serializeEditorDoc(doc);
    const offset = source.indexOf("{a}") + 1;
    const position = flatToPm(map, offset);
    const state = EditorState.create({ doc });
    const next = state.apply(state.tr.insertText("c", position, position + 1));
    expect(serializeEditorDoc(next.doc).value).toBe(source.replace("{a}", "{c}"));
  });
  it("preserves formula source as text when styling is disabled", () => {
    const source =
      "\\[\n\\text{use $browser, @README.md and [file](t3-context://v1/file/ctx_1)}\n\\]";
    const doc = plainSchema.nodeFromJSON(
      buildDocJson(source, (name) => ({ label: name, description: null }), { styling: false }),
    );
    const map = serializeEditorDoc(doc);
    expect(map.value).toBe(source);
    expect(map.runs.some((run) => run.kind === "token")).toBe(false);
  });
});

describe("literal editor answers", () => {
  const makeDoc = (value: string) =>
    ProseMirrorNode.fromJSON(
      plainSchema,
      buildDocJson(value, (name) => ({ label: name, description: null }), {
        literalText: true,
      }),
    );

  it.each([
    "",
    "\n\n",
    "  - [X] done\n\n**keep** €my-skill @README.md  \n",
    "line one\r\nline two\r\n",
    `- [X] done\n${"  detail €my-skill @README.md\n".repeat(100)}`,
  ])("preserves the complete answer through selection and serialization", (value) => {
    const doc = makeDoc(value);
    doc.check();
    const serialized = serializeEditorDoc(doc);
    expect(serialized.value).toBe(value);
    expect(serialized.contextIds).toEqual([]);
    expect(serializeSelection(doc, 1, doc.content.size - 1)).toBe(value);
    for (let offset = 0; offset <= value.length; offset += 1) {
      expect(collapseExpandedComposerCursor(value, flatToMarkdown(serialized, offset), true)).toBe(
        offset,
      );
    }
  });

  it("edits literal Markdown, inserts a newline, and preserves an explicitly cleared answer", () => {
    const value = "  - [X] done €my-skill @README.md  ";
    const doc = makeDoc(value);
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, doc.content.size - 1),
    });
    state = state.apply(state.tr.insertText(" edited"));
    expect(
      splitBlockKeepMarks(state, (transaction) => {
        state = state.apply(transaction);
      }),
    ).toBe(true);
    state = state.apply(state.tr.insertText("second line  "));
    expect(serializeEditorDoc(state.doc).value).toBe(`${value} edited\nsecond line  `);
    state = state.apply(state.tr.delete(1, state.doc.content.size - 1));
    expect(serializeEditorDoc(state.doc).value).toBe("");
  });
});

describe("composer rich text document model", () => {
  it.each(["€", "£", "¥", "₹", "₩", "₿", "𑿝"])(
    "canonicalizes %s skill aliases while preserving amounts",
    (prefix) => {
      const value = `Use ${prefix}my-skill for ${prefix}20 please`;
      const expected = `Use $my-skill for ${prefix}20 please`;
      expect(roundTrip(value).value).toBe(expected);
      expect(roundTripPlain(value).value).toBe(expected);
    },
  );

  it.each([
    "",
    "\n\n",
    "plain text",
    "hello **bold** world",
    "a *italic* word and `code` here",
    "struck ~~out~~ now",
    "**`x`**",
    "*`x`*",
    "~~`x`~~",
    "**a `code` c**",
    "***bold italic*** keeps nesting",
    "line one\nline two",
    "trailing newline\n",
    "1. foo\n2. asdf\n",
    "- [ ] buy milk",
    "-   [ ]  buy milk",
    "\t-\t[x]\t\titem",
    "- [ ]  ",
    "- [ ]\n  - [ ] child",
    "  - [ ] first\n - [ ] second\n  - [ ] child",
    "**before @README.md after**",
    "*a **b** c*",
    "*a**b***",
    "**a*b***",
    "**a *b* c**",
    "literal \uFFFC **before @README.md after**",
    "- [x] done\n- [ ] next",
    "- [ ] parent\n  - [ ] child\n  - [ ] sibling\n- [ ] uncle",
    "- [ ] empty task follows\n- [ ]",
    "- [ ] **bold** task with @README.md",
    "para\n- [ ] task\npara",
    "- [ ]No space stays literal",
    "-[ ] also literal",
    "@README.md explain this",
    '@"docs/My File.md" and $my-skill please',
    "snake_case stays literal",
    "unmatched ** stays literal",
    "**bold** then @README.md then *italic*",
  ])("round-trips %s through a real ProseMirror document", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it.each([
    "",
    "\n",
    "text\n\n",
    "- [ ]\n- [ ] next\n",
    "- [ ] parent\n  - [ ] child\n- [ ]",
    "para\n- [ ] task\npara",
    "**before @README.md after**",
  ])("maps editable positions in %s", (value) => {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson(value, (name) => ({ label: name, description: null })),
    );
    const map = serializeEditorDoc(doc);
    for (let flat = 0; flat <= map.docLength; flat += 1) {
      const position = flatToPm(map, flat);
      expect(doc.resolve(position).parent.isTextblock).toBe(true);
      expect(pmToFlat(map, position)).toBe(flat);
      expect(markdownToFlat(map, flatToMarkdown(map, flat))).toBe(flat);
    }
  });

  it("keeps the caret after a trailing hard break inside the same paragraph", () => {
    const doc = schema.node("doc", null, [
      schema.node("paragraph", null, [schema.text("a"), schema.node("hardBreak")]),
    ]);
    const map = serializeEditorDoc(doc);
    expect(flatToPm(map, map.docLength)).toBe(3);
    expect(doc.resolve(flatToPm(map, map.docLength)).parent.isTextblock).toBe(true);
  });

  it("renders a leading task dedent as siblings and nests under the new indent", () => {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson("  - [ ] first\n - [ ] second\n  - [ ] child", (name) => ({
        label: name,
        description: null,
      })),
    );
    const list = doc.firstChild!;
    expect(list.childCount).toBe(2);
    expect(list.child(0).childCount).toBe(1);
    expect(list.child(1).child(1).firstChild!.textContent).toBe("child");
  });

  it("applies a shared mark to text on both sides of a chip", () => {
    const doc = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson("**before @README.md after**", (name) => ({ label: name, description: null })),
    );
    expect(doc.firstChild!.childCount).toBe(3);
    doc.firstChild!.forEach((child) =>
      expect(child.marks.map((mark) => mark.type.name)).toContain("bold"),
    );
    expect(serializeEditorDoc(doc).value).toBe("**before @README.md after**");
  });

  it.each([
    [["bold"], ["bold", "italic"], ["italic"]],
    [["italic"], ["bold", "italic"], ["bold"]],
    [["bold"], ["bold", "strike"], ["strike"]],
    [["strike"], ["bold", "strike"], ["bold"]],
  ])("preserves crossing mark ranges %j through controlled rebuilds", (...marks) => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        marks.map((names, index) =>
          schema.text(
            String.fromCharCode(97 + index),
            names.map((name) => schema.mark(name)),
          ),
        ),
      ),
    ]);
    const serialized = serializeEditorDoc(doc).value;
    const rebuilt = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson(serialized, (name) => ({ label: name, description: null })),
    );
    expect(rebuilt.eq(doc)).toBe(true);
    expect(serializeEditorDoc(rebuilt).value).toBe(serialized);
  });

  it.each([
    { parts: [{ text: "hello ", marks: ["bold"] }], expected: "**hello** " },
    { parts: [{ text: "  ", marks: ["bold"] }], expected: "  " },
    { parts: [{ text: " left ", marks: ["bold", "italic"] }], expected: " ***left*** " },
    {
      parts: [
        { text: "one ", marks: ["bold"] },
        { text: " two ", marks: ["bold", "italic"] },
        { text: " three", marks: ["bold"] },
      ],
      expected: "**one  *two*  three**",
    },
    {
      parts: [
        { text: "hello ", marks: ["bold"] },
        { text: "world ", marks: ["bold", "italic"] },
      ],
      expected: "**hello *world*** ",
    },
    { parts: [{ text: " hello ", marks: ["code"] }], expected: "` hello `" },
    { parts: [{ text: " hello ", marks: ["bold", "code"] }], expected: "**` hello `**" },
    { parts: [{ text: " ", marks: ["bold", "code"] }], expected: "**` `**" },
  ])("keeps boundary whitespace outside emphasis in $expected", ({ parts, expected }) => {
    const doc = schema.node("doc", null, [
      schema.node(
        "paragraph",
        null,
        parts.map(({ text, marks }) =>
          schema.text(
            text,
            marks.map((name) => schema.mark(name)),
          ),
        ),
      ),
    ]);
    const map = serializeEditorDoc(doc);
    expect(map.value).toBe(expected);
    const rebuilt = ProseMirrorNode.fromJSON(
      schema,
      buildDocJson(map.value, (name) => ({ label: name, description: null })),
    );
    expect(rebuilt.textContent).toBe(doc.textContent);
    expect(serializeEditorDoc(rebuilt).value).toBe(map.value);
    for (let flat = 0; flat <= map.docLength; flat += 1) {
      expect(pmToFlat(map, flatToPm(map, flat))).toBe(flat);
      expect(markdownToFlat(map, flatToMarkdown(map, flat))).toBe(flat);
      if (flat < map.docLength && !/\s/.test(doc.textContent[flat]!)) {
        expect(rebuilt.resolve(flat + 1).nodeAfter!.marks.map((mark) => mark.type.name)).toEqual(
          doc.resolve(flat + 1).nodeAfter!.marks.map((mark) => mark.type.name),
        );
      }
    }
  });

  it.each([
    "plain text",
    "hello **bold** stays literal",
    "a *italic* stays literal",
    "some `code` stays literal",
    "struck ~~out~~ stays literal",
    "- [ ] stays a paragraph",
    "- [x] stays a paragraph",
    "line one\nline two",
    "@README.md explain this",
    "**bold** then @README.md then *italic*",
  ])("round-trips %s byte-identically in plain mode", (value) => {
    expect(roundTripPlain(value).value).toBe(value);
  });

  it.each([
    "- one\n- two",
    "* star\n* star two",
    "+ plus",
    "* star\n+ plus",
    "1. first\n2. second",
    "1) paren\n2) paren",
    "3. starts at three\n4. four",
    "01. zero padded\n02. two",
    "- parent\n  - child\n  - sibling\n- uncle",
    "1. ordered\n   - bullet child\n2. next",
    "- outer\n  1. inner ordered\n  2. more\n- outer again",
    "-   wide space item",
    "-",
    "1.",
    "- \n- second",
    "- **bold** item with @README.md",
    "- [ ] task\n- bullet after",
    "- bullet\n- [x] task after",
    "para\n- item\npara",
    "\t- tab indented\n\t- again",
    "  - leading indent only",
    "- item\n\n- after a blank",
    "- item one\n```ts\ncode\n```\n- item two",
    "-no space stays literal",
    "1.no space stays literal",
    "10. ten\n11. eleven",
  ])("round-trips the list %s through a real ProseMirror document", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it("clamps offsets inside a list marker to the start of the item text", () => {
    const value = "- item";
    const map = roundTrip(value);
    for (let markdown = 0; markdown <= "- ".length; markdown += 1) {
      expect(markdownToFlat(map, markdown)).toBe(0);
    }
    expect(markdownToFlat(map, "- it".length)).toBe(2);
    expect(flatToMarkdown(map, 0)).toBe("- ".length);
  });

  it.each([
    "> quoted",
    "> line one\n> line two",
    ">no space",
    ">  two spaces",
    "> a\n>b",
    ">",
    "> **bold** and @README.md inside",
    "> - looks like a list but stays quote text",
    "> > nested stays literal inside the quote",
    "before\n> quoted",
    "> quote\n\n> another",
    "- item\n> quote after list",
    "> quoted\n\ncomment",
    "> line one\n> line two\n\ncomment",
  ])("round-trips the quote %s through a real ProseMirror document", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it.each([
    "---",
    "***",
    "___",
    "- - -",
    "* * *",
    "-----",
    "---   ",
    "text\n---\nmore",
    "- item\n---\n- item two",
    "```\n---\n```",
    "--",
    "-- -",
    "---text",
  ])("round-trips the rule %s through a real ProseMirror document", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it("parses rules ahead of lists and emphasis", () => {
    const json = buildDocJson("- - -\n***\n___\ntext\n---\n- item", (n) => ({
      label: n,
      description: null,
    }));
    expect(json.content.map((block) => block.type)).toEqual([
      "horizontalRule",
      "horizontalRule",
      "horizontalRule",
      "paragraph",
      "horizontalRule",
      "bulletList",
    ]);
  });

  it.each([
    "# Heading",
    "## Two",
    "###### Six",
    "####### seven hashes stays a paragraph",
    "#  two spaces",
    "#\tTab",
    "# Trailing hashes stay literal #",
    "#1234",
    "#1234 is a pull request, not a heading",
    "# Heading with **bold** and @README.md",
    "#",
    "# ",
    "text\n# Heading\ntext",
    "# Heading\n- item\n> quote\n---",
  ])("round-trips the heading %s through a real ProseMirror document", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it.each([
    ["---", "---"],
    ["a\n---", "a\n---"],
    ["---\n", "---"],
  ])("gives the caret a line after the final rule of %j, written %j", (value, expected) => {
    const map = roundTrip(value);
    expect(map.value).toBe(expected);
    const json = buildDocJson(value, () => ({ label: "", description: null }));
    const doc = ProseMirrorNode.fromJSON(schema, json);
    expect(doc.resolve(flatToPm(map, map.docLength)).parent.isTextblock).toBe(true);
  });

  it.each([
    "```\ncode\n```",
    "```ts\nconst a = 1;\n```",
    "```ts\nconst a = 1;\n```\n",
    "before\n```ts\nconst a = 1;\n```\nafter",
    "```\n```",
    "```ts\nline one\nline two\nline three\n```",
    "```ts\n  indented\n    deeper\n```",
    "```js title=example\ncode\n```",
    "~~~py\ncode\n~~~",
    "````\n```\n````",
    "```ts\ncode without a closing fence",
    "```",
    "```ts\n**not bold** and @README.md stay literal\n```",
    "```ts\ncode\n````",
    "- [ ] task\n```ts\ncode\n```\n- [ ] after",
    "  ```ts\nindented fence stays a paragraph\n  ```",
  ])("round-trips the fenced block %s", (value) => {
    expect(roundTrip(value).value).toBe(value);
  });

  it("reads blocks written with CRLF line endings", () => {
    const value = "# Title\r\n> quote\r\n---\r\n```ts\r\nconst a = 1;\r\n```\r\nafter";
    const doc = buildDocJson(value, () => ({ label: "", description: null }));
    expect(doc.content.map((block) => block.type)).toEqual([
      "heading",
      "blockquote",
      "horizontalRule",
      "codeBlock",
      "paragraph",
    ]);
    expect(roundTrip(value).value).toBe(value);
  });

  it("keeps the caret inside an empty fence", () => {
    const value = "before\n```\n```";
    const map = roundTrip(value);
    const inside = "before\n".length;
    expect(flatToMarkdown(map, inside)).toBe("before\n```".length);
    expect(markdownToFlat(map, flatToMarkdown(map, inside))).toBe(inside);
  });

  it("clamps offsets inside a fence to the edge of the code", () => {
    const value = "```ts\nab\n```";
    const map = roundTrip(value);
    expect(map.value).toBe(value);
    for (let markdown = 0; markdown <= "```ts\n".length; markdown += 1) {
      expect(markdownToFlat(map, markdown)).toBe(0);
    }
    expect(markdownToFlat(map, "```ts\na".length)).toBe(1);
    for (let markdown = "```ts\nab".length; markdown <= value.length; markdown += 1) {
      expect(markdownToFlat(map, markdown)).toBe(2);
    }
  });

  it("keeps a chip in a fence info string as source and keeps later chips aligned", () => {
    const value = "```@README.md\ncode\n```\n$my-skill after";
    expect(roundTrip(value).value).toBe(value);
    const json = buildDocJson(value, (n) => ({ label: n, description: null }));
    const after = json.content[1] as {
      content: { type: string; attrs?: { skillName?: string } }[];
    };
    expect(after.content.map((n) => n.type)).toEqual(["composer-skill", "text"]);
    expect(after.content[0]?.attrs?.skillName).toBe("my-skill");
  });

  it("writes code holding a closing fence inside a longer fence", () => {
    const doc = ProseMirrorNode.fromJSON(schema, {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { fence: "```", close: "\n```" },
          content: [{ type: "text", text: "initial\n```\nsecret" }],
        },
      ],
    });
    const stored = serializeEditorDoc(doc).value;
    expect(stored).toBe("````\ninitial\n```\nsecret\n````");
    expect(buildDocJson(stored, () => ({ label: "", description: null })).content).toHaveLength(1);
    expect(roundTrip(stored).value).toBe(stored);
  });

  it("closes an unclosed fence that has a block after it", () => {
    const doc = ProseMirrorNode.fromJSON(schema, {
      type: "doc",
      content: [
        { type: "codeBlock", attrs: { close: "" }, content: [{ type: "text", text: "code" }] },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    });
    expect(serializeEditorDoc(doc).value).toBe("```\ncode\n```\nafter");
    expect(roundTrip("```\ncode").value).toBe("```\ncode");
  });

  it("keeps a chip's source in a fence as literal text", () => {
    const value = "```\nsee @b.md and $babysit now\n```\nafter";
    const known = () => ({ label: "Babysit", description: null });
    const doc = ProseMirrorNode.fromJSON(schema, buildDocJson(value, known));
    const map = serializeEditorDoc(doc);
    expect(map.value).toBe(value);
    expect(map.runs.filter((run) => run.kind === "token")).toEqual([]);
    for (let flat = 0; flat <= map.docLength; flat += 1) {
      expect(markdownToFlat(map, flatToMarkdown(map, flat))).toBe(flat);
    }
    // Reconciling against the provider's skills leaves the code alone too.
    expect(skillChipReplacements(doc, known)).toEqual([]);
  });

  it.each([
    "plain prose with no styling at all",
    "a chip @README.md counts one character in both modes",
    "$my-skill leads the line",
    "trailing newline\n",
  ])("resolves a collapsed cursor identically in both modes for %s", (value) => {
    const rich = roundTrip(value);
    const plain = roundTripPlain(value);
    expect(rich.value).toBe(value);
    expect(plain.value).toBe(value);
    for (let collapsed = 0; collapsed <= value.length; collapsed += 1) {
      const markdown = expandCollapsedComposerCursor(value, collapsed);
      expect(flatToMarkdown(rich, markdownToFlat(rich, markdown))).toBe(
        flatToMarkdown(plain, markdownToFlat(plain, markdown)),
      );
    }
  });

  it("clamps a cursor that was sitting inside a marker onto the styled text", () => {
    const value = "a **bold** c";
    const plain = roundTripPlain(value);
    const rich = roundTrip(value);
    expect(flatToMarkdown(plain, markdownToFlat(plain, 3))).toBe(3);
    expect(flatToMarkdown(rich, markdownToFlat(rich, 3))).toBe(4);
  });
});

describe("composer rich text document model", () => {
describe("a paragraph after a quote", () => {
    const paragraph = (text?: string) => ({
      type: "paragraph",
      ...(text ? { content: [{ type: "text", text }] } : {}),
    });

    const quote = (...lines: string[]) => ({
      type: "blockquote",
      attrs: { prefix: "> " },
      content: lines.map((line) => paragraph(line)),
    });

    const serialize = (...content: object[]) => {
      const doc = ProseMirrorNode.fromJSON(schema, { type: "doc", content });
      doc.check();
      return { doc, map: serializeEditorDoc(doc) };
    };

    it("is written after a blank line, or Markdown folds it into the quote", () => {
      expect(serialize(quote("quoted"), paragraph("Comment to it")).map.value).toBe(
        "> quoted\n\nComment to it",
      );
      expect(serialize(quote("a", "b"), paragraph("comment")).map.value).toBe(
        "> a\n> b\n\ncomment",
      );
    });

    it("does not double up on the empty line the user left themselves", () => {
      expect(serialize(quote("quoted"), paragraph(), paragraph("Comment to it")).map.value).toBe(
        "> quoted\n\nComment to it",
      );
    });

    it("settles on the blank line when a draft glued it to the quote", () => {
      const settled = "before\n> quoted\n\nafter";
      expect(roundTrip("before\n> quoted\nafter").value).toBe(settled);
      expect(roundTrip(settled).value).toBe(settled);
    });

    it.each(["# Heading", "- item", "3. item", "---", "```\ncode\n```"])(
      "leaves %s on the next line, since it opens its own block",
      (next) => {
        const value = `> quoted\n${next}`;
        expect(roundTrip(value).value).toBe(value);
      },
    );

    it("keeps every offset mapped through the blank line", () => {
      const { doc, map } = serialize(quote("quoted"), paragraph("Comment"));
      for (let flat = 0; flat <= map.docLength; flat += 1) {
        expect(markdownToFlat(map, flatToMarkdown(map, flat))).toBe(flat);
      }
      // The caret on the end of the quote stays on it, and the blank line is
      // not a place to type: it clamps to the start of the comment.
      expect(flatToMarkdown(map, "quoted".length)).toBe("> quoted".length);
      expect(markdownToFlat(map, "> quoted\n".length)).toBe("quoted".length + 1);
      expect(flatToMarkdown(map, "quoted".length + 1)).toBe("> quoted\n\n".length);
      expect(flatToPm(map, "quoted".length + 1)).toBe(doc.child(0).nodeSize + 1);
    });
});
});
