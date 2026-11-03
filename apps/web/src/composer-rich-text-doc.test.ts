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

// Plain mode: the same engine with the mark extensions off. Markers stay
// literal characters and task lines stay paragraphs.
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
