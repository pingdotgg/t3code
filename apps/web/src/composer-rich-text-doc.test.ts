import { getSchemaByResolvedExtensions, Node, resolveExtensions } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { TaskList } from "@tiptap/extension-task-list";
import { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import { describe, expect, it } from "vite-plus/test";

import { collapseExpandedComposerCursor } from "./composer-logic";

import {
  buildDocJson,
  buildTiptapContent,
  caretTakesMarksBefore,
  ComposerBlockExtensions,
  ComposerCodeBlockExtension,
  ComposerListExtensions,
  collapsedToFlat,
  ComposerCodeExtension,
  ComposerTaskItemExtension,
  flatToCollapsed,
  flatToMarkdown,
  flatToPm,
  pmToFlat,
  serializeEditorDoc,
  serializeSelection,
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

it.each([
  "| Name | Value |\n| --- | --- |\n| one | two |",
  "```ts\nconst answer = 42;\n```",
  "<details>\n<summary>More</summary>\nBody\n</details>",
  "Read [the guide](https://example.com/guide?q=1) and ![diagram](https://example.com/a.png).",
  "Ask @alice about #123 before closing.",
])("keeps issue Markdown through the rich editor: %s", (body) => {
  expect(roundTrip(body).value).toBe(body);
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
      expect(collapsedToFlat(map, flatToCollapsed(map, flat))).toBe(flat);
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
      expect(collapsedToFlat(map, flatToCollapsed(map, flat))).toBe(flat);
      if (flat < map.docLength && !/\s/.test(doc.textContent[flat]!)) {
        expect(rebuilt.resolve(flat + 1).nodeAfter!.marks.map((mark) => mark.type.name)).toEqual(
          doc.resolve(flat + 1).nodeAfter!.marks.map((mark) => mark.type.name),
        );
      }
    }
  });

  it("keeps chip sources canonical through the document", () => {
    const map = roundTrip("explain @README.md with **care**\nsecond line *here*");
    expect(map.value).toBe("explain @README.md with **care**\nsecond line *here*");
    expect(
      map.runs.some((run) => run.kind === "token" && run.nodeName === "composer-mention"),
    ).toBe(true);
  });

  it("normalizes uppercase checkboxes to lowercase", () => {
    expect(roundTrip("- [X] done").value).toBe("- [x] done");
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

  it.each([
    "- one\n- two",
    "1. first\n2. second",
    "- parent\n  - child",
    "* star\n+ plus",
    "-no space stays literal",
  ])("keeps the list %s literal in plain mode", (value) => {
    expect(roundTripPlain(value).value).toBe(value);
  });

  it.each(["- one\n- two", "1. a\n   - b\n2. c", "- **bold** @README.md tail", "-"])(
    "maps every document offset of the list %s through collapsed coordinates and back",
    (value) => {
      const map = roundTrip(value);
      expect(map.value).toBe(value);
      for (let flat = 0; flat <= map.docLength; flat += 1) {
        expect(collapsedToFlat(map, flatToCollapsed(map, flat))).toBe(flat);
      }
    },
  );

  it("clamps offsets inside a list marker to the start of the item text", () => {
    const value = "- item";
    const map = roundTrip(value);
    // The marker owns no document characters, like a checkbox.
    for (let collapsed = 0; collapsed <= "- ".length; collapsed += 1) {
      expect(collapsedToFlat(map, collapsed)).toBe(0);
    }
    expect(collapsedToFlat(map, "- it".length)).toBe(2);
    expect(flatToCollapsed(map, 0)).toBe("- ".length);
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
    "before\n> quoted\nafter",
    "> quote\n\n> another",
    "- item\n> quote after list",
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

  it.each(["> quoted", "> a\n>b", "---", "- - -", "# Heading", "#1234"])(
    "keeps the block %s literal in plain mode",
    (value) => {
      expect(roundTripPlain(value).value).toBe(value);
    },
  );

  it("parses the blocks it renders as the right node types", () => {
    const json = buildDocJson("# Title\n> quote\n---\n#1234 ref\n- - -", (n) => ({
      label: n,
      description: null,
    }));
    expect(json.content.map((block) => block.type)).toEqual([
      "heading",
      "blockquote",
      "horizontalRule",
      "paragraph",
      "horizontalRule",
      // The empty line a final rule keeps for the caret.
      "paragraph",
    ]);
  });

  it.each([
    ["---", "---"],
    ["a\n---", "a\n---"],
    // That line and a trailing newline are the same document; the newline goes.
    ["---\n", "---"],
  ])("gives the caret a line after the final rule of %j, written %j", (value, expected) => {
    const map = roundTrip(value);
    expect(map.value).toBe(expected);
    const json = buildDocJson(value, () => ({ label: "", description: null }));
    const doc = ProseMirrorNode.fromJSON(schema, json);
    expect(doc.resolve(flatToPm(map, map.docLength)).parent.isTextblock).toBe(true);
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

  it.each(["> quoted", "> a\n>b", "---", "- - -", "# Heading", "#1234"])(
    "keeps the block %s literal in plain mode",
    (value) => {
      expect(roundTripPlain(value).value).toBe(value);
    },
  );

  it("parses a quote as a blockquote of one paragraph per line", () => {
    const json = buildDocJson("> a\n> b\n>c", (n) => ({ label: n, description: null }));
    expect(json.content.map((block) => block.type)).toEqual(["blockquote", "blockquote"]);
    expect((json.content[0] as { content: unknown[] }).content).toHaveLength(2);
  });

  it.each([
    "> a\n> b",
    "> **q** @README.md",
    "text\n---\nmore",
    "---\ntext",
    "# Heading text",
    "## **b** @README.md",
  ])(
    "maps every document offset of the block %s through collapsed coordinates and back",
    (value) => {
      const map = roundTrip(value);
      expect(map.value).toBe(value);
      for (let flat = 0; flat <= map.docLength; flat += 1) {
        expect(collapsedToFlat(map, flatToCollapsed(map, flat))).toBe(flat);
      }
    },
  );

  it("clamps offsets inside a quote or heading marker to the start of the text", () => {
    for (const [value, prefix] of [
      ["> quoted", "> "],
      ["# Heading", "# "],
    ] as const) {
      const map = roundTrip(value);
      for (let collapsed = 0; collapsed <= prefix.length; collapsed += 1) {
        expect(collapsedToFlat(map, collapsed)).toBe(0);
      }
      expect(flatToCollapsed(map, 0)).toBe(prefix.length);
    }
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

  it.each(["```ts\nconst a = 1;\n```", "```\n```", "before\n```ts\ncode\n```\nafter"])(
    "maps every document offset of %s through collapsed coordinates and back",
    (value) => {
      const map = roundTrip(value);
      expect(map.value).toBe(value);
      for (let flat = 0; flat <= map.docLength; flat += 1) {
        expect(collapsedToFlat(map, flatToCollapsed(map, flat))).toBe(flat);
      }
    },
  );

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

  it("keeps the end of the code inside the fence rather than after it", () => {
    const value = "```ts\nfunc();\n```";
    const map = roundTrip(value);
    const endOfCode = "func();".length;
    // Not the end of the string: the closing fence is a line of its own.
    expect(flatToCollapsed(map, endOfCode)).toBe("```ts\nfunc();".length);
    expect(flatToMarkdown(map, endOfCode)).toBe("```ts\nfunc();".length);
    expect(collapsedToFlat(map, flatToCollapsed(map, endOfCode))).toBe(endOfCode);
  });

  it("keeps the caret inside an empty fence", () => {
    const value = "before\n```\n```";
    const map = roundTrip(value);
    const inside = "before\n".length;
    expect(flatToCollapsed(map, inside)).toBe("before\n```".length);
    expect(collapsedToFlat(map, flatToCollapsed(map, inside))).toBe(inside);
  });

  it("still places the end of an inline mark after its markers", () => {
    // The fence rule must not leak into inline marks, whose trailing edge is
    // deliberately the position after the closing delimiter.
    const map = roundTrip("a **bold** c");
    expect(flatToMarkdown(map, 6)).toBe(10);
  });

  it("clamps offsets inside a fence to the edge of the code", () => {
    const value = "```ts\nab\n```";
    const map = roundTrip(value);
    expect(map.value).toBe(value);
    // The opening fence owns no document characters, so every offset in it
    // lands on the first character of the code.
    for (let collapsed = 0; collapsed <= "```ts\n".length; collapsed += 1) {
      expect(collapsedToFlat(map, collapsed)).toBe(0);
    }
    expect(collapsedToFlat(map, "```ts\na".length)).toBe(1);
    // Everything from the closing newline onwards clamps to the code's end.
    for (let collapsed = "```ts\nab".length; collapsed <= value.length; collapsed += 1) {
      expect(collapsedToFlat(map, collapsed)).toBe(2);
    }
  });

  it.each([
    ["```\n\n```", "```\n```"],
    ["```\n", "```"],
  ])("canonicalizes the empty fence %s", (value, expected) => {
    expect(roundTrip(value).value).toBe(expected);
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

  it("keeps chips in a fence's info string and body each in their own place", () => {
    const value = "``` @a.md\nsee @b.md\n```";
    expect(roundTrip(value).value).toBe(value);
    const json = buildDocJson(value, (n) => ({ label: n, description: null }));
    const code = json.content[0] as { attrs: { language: string } };
    expect(code.attrs.language).toBe(" @a.md");
  });

  it.each([
    ["listItem", { marker: "-", space: "" }, "bulletList", "- text"],
    ["listItem", { marker: "1.", space: "" }, "orderedList", "1. text"],
  ])("gives a bare %s a space once it has text", (item, attrs, list, expected) => {
    const doc = ProseMirrorNode.fromJSON(schema, {
      type: "doc",
      content: [
        {
          type: list,
          content: [
            {
              type: item,
              attrs,
              content: [{ type: "paragraph", content: [{ type: "text", text: "text" }] }],
            },
          ],
        },
      ],
    });
    expect(serializeEditorDoc(doc).value).toBe(expected);
    expect(roundTrip("-").value).toBe("-");
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
    // At the end of the draft it stays unclosed, as it was written.
    expect(roundTrip("```\ncode").value).toBe("```\ncode");
  });

  it("counts a chip's source in a fence as one cursor position, as the draft store does", () => {
    const value = "```\nsee @b.md now\n```\nafter";
    const map = roundTrip(value);
    expect(map.value).toBe(value);
    for (let flat = 0; flat <= map.docLength; flat += 1) {
      expect(flatToCollapsed(map, flat)).toBe(
        collapseExpandedComposerCursor(value, flatToMarkdown(map, flat)),
      );
    }
    const afterChip = "see @b.md".length;
    expect(collapsedToFlat(map, flatToCollapsed(map, afterChip))).toBe(afterChip);
    const end = map.docLength;
    expect(collapsedToFlat(map, flatToCollapsed(map, end))).toBe(end);
  });

  it("keeps fences literal in plain mode", () => {
    const value = "```ts\nconst a = 1;\n```";
    expect(roundTripPlain(value).value).toBe(value);
  });

  it("maps every document offset through collapsed coordinates and back", () => {
    const value = "hi **bold** @README.md bye";
    const map = roundTrip(value);
    expect(map.value).toBe(value);
    for (let flat = 0; flat <= map.docLength; flat += 1) {
      expect(collapsedToFlat(map, flatToCollapsed(map, flat))).toBe(flat);
    }
  });

  // Flipping the rich text setting remounts the editor, and the caret is
  // restored from the stored collapsed cursor. That only works because the
  // coordinate means the same thing on both sides of the flip.
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
      expect(flatToMarkdown(rich, collapsedToFlat(rich, collapsed))).toBe(
        flatToMarkdown(plain, collapsedToFlat(plain, collapsed)),
      );
    }
  });

  it("clamps a cursor that was sitting inside a marker onto the styled text", () => {
    const value = "a **bold** c";
    const plain = roundTripPlain(value);
    const rich = roundTrip(value);
    // Between the two asterisks: a real caret position in plain mode, and no
    // position at all in rich mode, where it lands on the first styled
    // character instead. The flip moves the caret by a marker's width at most.
    expect(flatToMarkdown(plain, collapsedToFlat(plain, 3))).toBe(3);
    expect(flatToMarkdown(rich, collapsedToFlat(rich, 3))).toBe(4);
  });

  it("maps markdown offsets at styled edges onto document text", () => {
    const value = "a **bold** c";
    const map = roundTrip(value);
    expect(map.value).toBe(value);
    // document text is "a bold c" (flat), markdown has the markers.
    expect(flatToMarkdown(map, 2)).toBe(4);
    expect(flatToMarkdown(map, 6)).toBe(10);
    expect(collapsedToFlat(map, 3)).toBe(2);
    expect(collapsedToFlat(map, 9)).toBe(6);
  });
});

describe("serializeSelection", () => {
  /** The stored Markdown of the selection from the start of `first` to the end of `last`. */
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

  it("keeps the prefix of the quote lines it spans", () => {
    expect(copy("> one\n> two", "one", "two")).toBe("> one\n> two");
  });

  it("copies text within one block without its marker", () => {
    expect(copy("- one two", "one", "one")).toBe("one");
  });

  it("copies across blocks as they are written", () => {
    expect(copy("intro\n- one", "intro", "one")).toBe("intro\n- one");
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
    // Already outside: the next ArrowLeft moves the caret as usual.
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

  it("offers both stops where styled text meets plain text mid-line", () => {
    // Caret after "a ": types plain until ArrowRight steps into the bold.
    const plain = stateAt("a **b** c", 3);
    expect(caretTakesMarksBefore(plain)).toBe(true);
    expect(typed(plain, "x")).toBe("a x**b** c");
    const bold = plain.apply(stepCaretAcrossStyledEdge(plain, 1)!);
    expect(typed(bold, "x")).toBe("a **xb** c");
  });

  it("offers the plain stop between bold text and a chip right after it", () => {
    // Markdown needs a space before a mention, but deleting it leaves them adjacent.
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

  it("leaves arrow keys alone away from styled edges", () => {
    expect(stepCaretAcrossStyledEdge(stateAt("**bold** tail", 3), -1)).toBeNull();
    expect(stepCaretAcrossStyledEdge(stateAt("plain text", 1), -1)).toBeNull();
    expect(caretTakesMarksBefore(stateAt("plain text", 1))).toBe(false);
  });
});
