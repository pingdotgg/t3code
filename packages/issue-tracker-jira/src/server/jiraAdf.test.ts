import { expect, it } from "@effect/vitest";
import { jiraRichBody, parseJiraRichBody, validateJiraAdf } from "./jiraAdf.ts";
import { jiraBodyEditable, jiraBodyText } from "./jiraJson.ts";

const doc = (content: unknown[]) => ({ type: "doc", version: 1, content });
it("preserves unknown native nodes, attributes and marks exactly", () => {
  const native = doc([
    {
      type: "nativeEmbed",
      attrs: { provider: "native", payload: { ids: ["a", "b"] } },
      marks: [{ type: "nativeMark", attrs: { color: "red" } }],
    },
  ]);
  expect(parseJiraRichBody(jiraRichBody(native)!)).toEqual(native);
  expect(jiraBodyText(native)).toBe("[Rich Jira content]");
  expect(jiraBodyEditable(native)).toBe(false);
});
it.each([
  null,
  [],
  "text",
  1,
  { type: "doc", version: 2, content: [] },
  { type: "doc", version: 1, content: {} },
  doc([null]),
  doc(["text"]),
  doc([{ type: "paragraph", content: {} }]),
  doc([{ type: "text", text: 1 }]),
  doc([{ type: "text", text: "x", marks: [null] }]),
  doc([{ type: "paragraph", attrs: [] }]),
  doc([{ type: "paragraph", content: [{ type: "doc", version: 1, content: [] }] }]),
  doc([{ type: "text", text: "x".repeat(65_537) }]),
])("rejects malformed or oversized native documents: %j", (value) => {
  expect(() => validateJiraAdf(value)).toThrow();
  expect(jiraRichBody(value)).toBeUndefined();
});
it("bounds nested attributes, nodes, and JSON wire size", () => {
  let deep: unknown = {};
  for (let index = 0; index < 42; index++) deep = { child: deep };
  for (const value of [
    doc([{ type: "native", attrs: { deep } }]),
    doc(Array.from({ length: 10_001 }, () => ({ type: "rule" }))),
    doc([{ type: "native", attrs: { data: "x".repeat(262_145) } }]),
  ])
    expect(() => validateJiraAdf(value)).toThrow();
  expect(() =>
    parseJiraRichBody({
      format: "adf",
      document: '{"type":"doc","version":1,"content":[],"__proto__":{}}',
    }),
  ).toThrow();
});

it.each([undefined, 0, 7, 1.5, "2", null])("rejects native heading level %j", (level) => {
  const value = doc([
    {
      type: "heading",
      ...(level === undefined ? {} : { attrs: { level } }),
      content: [{ type: "text", text: "Heading" }],
    },
  ]);
  expect(() => validateJiraAdf(value)).toThrow();
});
it.each([1, 2, 3, 4, 5, 6])(
  "preserves valid native heading level %i and unknown attributes",
  (level) => {
    const value = doc([
      {
        type: "heading",
        attrs: { level, native: { keep: true } },
        content: [{ type: "text", text: "Heading" }],
      },
    ]);
    expect(validateJiraAdf(value)).toEqual(value);
  },
);
it.each([
  "strong",
  "em",
  "strike",
  "underline",
  "subsup",
  "textColor",
  "backgroundColor",
  "nativeMark",
])("refuses code combined with %s", (type) => {
  const value = doc([
    {
      type: "paragraph",
      content: [{ type: "text", text: "Code", marks: [{ type: "code" }, { type }] }],
    },
  ]);
  expect(() => validateJiraAdf(value)).toThrow();
});
it("preserves code alone or with a native link in either order", () => {
  const code = { type: "code" };
  const link = { type: "link", attrs: { href: "https://example.test", native: true } };
  for (const marks of [[code], [code, link], [link, code]]) {
    const value = doc([{ type: "paragraph", content: [{ type: "text", text: "Code", marks }] }]);
    expect(parseJiraRichBody(jiraRichBody(value)!)).toEqual(value);
  }
});

it("bounds DC wiki source and keeps descriptions and comments exact", () => {
  const native = "h1. Title\r\n!file.png|width=400! [file.pdf^file.pdf]  ";
  expect(jiraRichBody(native, "data-center")).toEqual({ format: "jira-wiki", document: native });
  expect(parseJiraRichBody({ format: "jira-wiki", document: native }, "data-center", true)).toBe(
    native,
  );
  expect(
    parseJiraRichBody({ format: "jira-wiki", document: "x".repeat(65_536) }, "data-center"),
  ).toHaveLength(65_536);
  expect(parseJiraRichBody({ format: "jira-wiki", document: "" }, "data-center")).toBe("");
  expect(jiraRichBody(native, "cloud")).toBeUndefined();
  expect(jiraRichBody(doc([]), "data-center")).toBeUndefined();
  expect(jiraRichBody("x".repeat(65_537), "data-center")).toBeUndefined();
  expect(() => parseJiraRichBody({ format: "jira-wiki", document: native }, "cloud")).toThrow();
  expect(() =>
    parseJiraRichBody({ format: "adf", document: JSON.stringify(doc([])) }, "data-center"),
  ).toThrow();
  for (const document of ["", " \r\n\t", "x".repeat(65_537)])
    expect(() =>
      parseJiraRichBody({ format: "jira-wiki", document }, "data-center", true),
    ).toThrow();
});

it("exposes a null DC description as empty wiki without accepting malformed native bodies", () => {
  expect(jiraRichBody(null, "data-center")).toEqual({ format: "jira-wiki", document: "" });
  expect(jiraRichBody(null, "cloud")).toBeUndefined();
  for (const value of [undefined, {}, [], false, 0, doc([]), "x".repeat(65_537)])
    expect(jiraRichBody(value, "data-center")).toBeUndefined();
});

it.each(["textColor", "subsup", "strong", "em", "link", "code", "nativeMark"])(
  "rejects code block text with a %s mark",
  (type) => {
    const value = doc([
      {
        type: "codeBlock",
        attrs: { language: "text" },
        content: [{ type: "text", text: "code", marks: [{ type, attrs: { native: "kept" } }] }],
      },
    ]);
    expect(() => validateJiraAdf(value)).toThrow();
    expect(() => parseJiraRichBody({ format: "adf", document: JSON.stringify(value) })).toThrow();
  },
);
it.each(["paragraph", "nativeEmbed"])("rejects a %s child inside a native code block", (type) => {
  expect(() => validateJiraAdf(doc([{ type: "codeBlock", content: [{ type }] }]))).toThrow();
});
it("preserves unmarked code blocks and unknown native nodes and attributes", () => {
  const value = doc([
    {
      type: "codeBlock",
      attrs: { language: "text", wrap: true, native: { keep: true } },
      content: [
        { type: "text", text: "line 1\nline 2" },
        { type: "text", text: "end", marks: [] },
      ],
    },
    { type: "nativeEmbed", attrs: { body: { type: "codeBlock", opaque: true } } },
  ]);
  expect(parseJiraRichBody(jiraRichBody(value)!)).toEqual(value);
});
