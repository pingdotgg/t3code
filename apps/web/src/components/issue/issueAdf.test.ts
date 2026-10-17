import { EditorState } from "@tiptap/pm/state";
import { expect, it } from "vite-plus/test";
import type { IssueRichBody } from "@t3tools/contracts";
import {
  isEditableIssueRichBody,
  readIssueAdf,
  safeIssueExternalUrl,
  type AdfNode,
} from "./issueAdf";

const document = {
  version: 1,
  type: "doc",
  attrs: { extension: "keep" },
  content: [
    {
      type: "heading",
      attrs: { level: 3, localId: "heading-id" },
      content: [
        {
          type: "text",
          text: "Title",
          marks: [{ type: "em", attrs: { future: true } }, { type: "strong" }],
        },
      ],
    },
    {
      type: "paragraph",
      attrs: { localId: "p-id" },
      content: [
        {
          type: "text",
          text: "Hello",
          attrs: { future: "text-data" },
          marks: [
            { type: "link", attrs: { href: "https://example.com", id: "link-id", future: [1, 2] } },
            { type: "textColor", attrs: { color: "#123456" } },
          ],
        },
        { type: "mention", attrs: { id: "account-id", text: "Mention", accessLevel: "CONTAINER" } },
        { type: "emoji", attrs: { shortName: ":smile:", id: "emoji-id" } },
      ],
    },
    {
      type: "mediaSingle",
      attrs: { layout: "center", width: 50 },
      content: [
        {
          type: "media",
          attrs: { id: "media-id", collection: "private-collection", type: "file" },
        },
      ],
    },
    {
      type: "extension",
      attrs: { extensionKey: "unknown", parameters: { nested: { id: "keep" } } },
    },
    {
      type: "orderedList",
      attrs: { order: 4, localId: "list-id" },
      content: [
        {
          type: "listItem",
          attrs: { localId: "item-id" },
          content: [{ type: "paragraph", content: [{ type: "text", text: "Item" }] }],
        },
      ],
    },
    {
      type: "codeBlock",
      attrs: { language: "ts", localId: "code-id" },
      content: [{ type: "text", text: "const x = 1;" }],
    },
  ],
};
const rich = (value: unknown) => ({ format: "adf" as const, document: JSON.stringify(value) });

it("round-trips all native content and metadata without a change", () => {
  const bridge = readIssueAdf(rich(document))!;
  expect(bridge).not.toBeNull();
  expect(JSON.parse(bridge.serialize(bridge.doc).document)).toEqual(document);
});

it("edits text and retains untouched native nodes, marks, attrs and media IDs", () => {
  const bridge = readIssueAdf(rich(document))!;
  let position = 0;
  bridge.doc.descendants((node, pos) => {
    if (node.isText && node.text === "Hello") position = pos;
  });
  const state = EditorState.create({ doc: bridge.doc });
  const next = JSON.parse(
    bridge.serialize(state.apply(state.tr.insertText("!", position + 2)).doc).document,
  );
  const expected = structuredClone(document) as AdfNode;
  expected.content![1]!.content![0]!.text = "He!llo";
  expect(next).toEqual(expected);
});

it.each([
  { content: [] },
  { content: [{ type: "paragraph" }] },
  { content: [{ type: "paragraph", content: [] }] },
])("preserves empty documents and paragraphs (%j)", ({ content }) => {
  const value = { type: "doc", version: 1, content };
  const bridge = readIssueAdf(rich(value))!;
  expect(JSON.parse(bridge.serialize(bridge.doc).document)).toEqual(value);
});

it("preserves unknown inline and block content while another paragraph changes", () => {
  const original = {
    type: "doc",
    version: 1,
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Edit" }] },
      {
        type: "futureNode",
        attrs: { payload: "verbatim" },
        content: [{ type: "futureChild", attrs: { id: "opaque" } }],
      },
      { type: "paragraph", content: [{ type: "futureInline", attrs: { id: "inline" } }] },
    ],
  };
  const bridge = readIssueAdf(rich(original))!;
  const state = EditorState.create({ doc: bridge.doc });
  const next = JSON.parse(bridge.serialize(state.apply(state.tr.insertText("X", 2)).doc).document);
  expect(next.content.slice(1)).toEqual(original.content.slice(1));
  expect(next.content[0].content[0].text).toBe("EXdit");
});

it.each([
  "not json",
  JSON.stringify({ type: "doc", version: 2, content: [] }),
  JSON.stringify({ type: "doc", version: 1, content: "bad" }),
  " ".repeat(262_145),
])("refuses invalid native input", (value) => {
  expect(readIssueAdf({ format: "adf", document: value })).toBeNull();
});

it.each(["javascript:alert(1)", "data:text/html,bad", "file:///tmp/private", "invalid"])(
  "rejects unsafe external links (%s)",
  (url) => expect(safeIssueExternalUrl(url)).toBeNull(),
);
it("accepts native HTTP and HTTPS links", () => {
  expect(safeIssueExternalUrl("https://tracker.example/issue/1")).toBe(
    "https://tracker.example/issue/1",
  );
  expect(safeIssueExternalUrl("http://tracker.example/issue/1")).toBe(
    "http://tracker.example/issue/1",
  );
});

it("does not interpret Jira wiki as ADF even when the source contains valid ADF JSON", () => {
  expect(readIssueAdf({ format: "jira-wiki", document: JSON.stringify(document) })).toBeNull();
  expect(readIssueAdf({ format: "jira-wiki", document: "h2. Native wiki\n!media-id!" })).toBeNull();
});

it("keeps Azure HTML as bounded source and refuses unknown formats", () => {
  const html = {
    format: "azure-html",
    document: '<table><tr><td><img src="a.png"></td></tr></table>',
  } as const;
  expect(readIssueAdf(html)).toBeNull();
  expect(isEditableIssueRichBody(html)).toBe(true);
  expect(isEditableIssueRichBody({ ...html, document: "" })).toBe(true);
  expect(isEditableIssueRichBody({ ...html, document: "x".repeat(65_537) })).toBe(false);
  expect(
    isEditableIssueRichBody({ format: "html", document: "<p>A</p>" } as unknown as IssueRichBody),
  ).toBe(false);
});
