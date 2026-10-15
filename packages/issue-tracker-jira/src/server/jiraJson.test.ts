import { describe, expect, it } from "vite-plus/test";

import { adfToText, isEditableAdf, buildJql, normalizeJiraIssue, textToAdf } from "./jiraJson.ts";

describe("Jira document conversion", () => {
  it("keeps paragraphs, line breaks, mentions, links and list text", () => {
    expect(
      adfToText({
        type: "doc",
        version: 1,
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Hello " },
              { type: "mention", attrs: { text: "@Ada", id: "user" } },
              { type: "hardBreak" },
              { type: "inlineCard", attrs: { url: "https://example.test/pr/1" } },
            ],
          },
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [{ type: "paragraph", content: [{ type: "text", text: "Do work" }] }],
              },
            ],
          },
        ],
      }),
    ).toBe("Hello @Ada\nhttps://example.test/pr/1\n\n- Do work");
  });

  it("writes user text as valid ADF without interpreting markup", () => {
    const text = "# Details\n\n<script>literal</script>\nsecond line";
    expect(adfToText(textToAdf(text))).toBe(text);
    expect(textToAdf("")).toEqual({
      type: "doc",
      version: 1,
      content: [{ type: "paragraph", content: [] }],
    });
  });

  it.each([
    { attrs: { order: 7 }, expected: "7. First\n8. Second" },
    { attrs: { order: 0 }, expected: "0. First\n1. Second" },
    { attrs: undefined, expected: "1. First\n2. Second" },
    { attrs: {}, expected: "1. First\n2. Second" },
    { attrs: { order: -1 }, expected: "1. First\n2. Second" },
    { attrs: { order: 1.5 }, expected: "1. First\n2. Second" },
    { attrs: { order: "7" }, expected: "1. First\n2. Second" },
  ])("uses the ordered list start for attrs $attrs", ({ attrs, expected }) => {
    expect(
      adfToText({
        type: "doc",
        version: 1,
        content: [
          {
            type: "orderedList",
            attrs,
            content: ["First", "Second"].map((text) => ({
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text }] }],
            })),
          },
        ],
      }),
    ).toBe(expected);
  });

  it("rejects malformed, excessive and unknown content instead of dropping it", () => {
    expect(() =>
      adfToText({ type: "doc", version: 1, content: [{ type: "unknownMedia" }] }),
    ).toThrow();
    expect(() =>
      adfToText({ type: "doc", version: 1, content: [{ type: "text", text: "x".repeat(65_537) }] }),
    ).toThrow();
    expect(() => adfToText({ type: "paragraph" })).toThrow();
    expect(() => textToAdf("\n".repeat(20_000))).toThrow();
  });
});

it("keeps link destinations in Jira text marks", () => {
  expect(
    adfToText({
      type: "doc",
      version: 1,
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "design",
              marks: [{ type: "link", attrs: { href: "https://example.test/design" } }],
            },
          ],
        },
      ],
    }),
  ).toBe("design (https://example.test/design)");
});

describe("Jira normalization", () => {
  it("preserves native state names, creator IDs and Jira dates", () => {
    const labels = Array.from({ length: 121 }, (_, index) => "label-" + index);
    const raw = {
      key: "ENG-1",
      fields: {
        summary: "Task",
        created: "2026-10-14T10:00:00.000+0000",
        updated: "2026-10-14T11:00:00.000+0000",
        status: { id: "4", name: "Review", statusCategory: { key: "indeterminate" } },
        creator: { accountId: "creator" },
        reporter: { accountId: "reporter" },
        assignee: { accountId: "assignee" },
        labels,
        comment: { total: 3 },
      },
    };
    const result = normalizeJiraIssue(raw, "example.atlassian.net");
    expect(result.labels.map((label) => label.name)).toEqual(labels);
    expect(result.state).toEqual({ name: "Review", category: "open" });
    expect(result.author?.login).toBe("creator");
    expect(result.assignees[0]?.login).toBe("assignee");
    expect(result.updatedAt).toBe("2026-10-14T11:00:00.000Z");
    expect(result.commentCount).toBe(3);
    expect(result.url).toBe("https://example.atlassian.net/browse/ENG-1");
    expect(
      normalizeJiraIssue(
        { ...raw, fields: { ...raw.fields, creator: null } },
        "example.atlassian.net",
      ).author,
    ).toBeNull();
  });

  it("builds one scoped open or closed query and filters the creator", () => {
    expect(buildJql({ scope: "ENG", state: "open", involvement: "authored" })).toBe(
      'project = "ENG" AND statusCategory != "done" AND creator = currentUser() ORDER BY updated DESC',
    );
    expect(buildJql({ scope: "ENG", state: "closed", involvement: "all" })).toBe(
      'project = "ENG" AND statusCategory = "done" ORDER BY updated DESC',
    );
    expect(() => buildJql({ scope: "ENG", state: "all", involvement: "mentioned" })).toThrow();
  });
});

it("allows only plain Jira descriptions that text edits can preserve", () => {
  for (const value of [null, textToAdf(""), textToAdf("One\nline\n\nNext")]) {
    expect(isEditableAdf(value)).toBe(true);
  }
  expect(isEditableAdf(undefined)).toBe(false);
  const text = { type: "text", text: "body" };
  const paragraph = { type: "paragraph", content: [text] };
  const doc = (content: unknown[]) => ({ type: "doc", version: 1, content });
  for (const node of [
    { ...paragraph, attrs: { localId: "paragraph-id" } },
    { ...paragraph, content: [{ ...text, marks: [{ type: "strong" }] }] },
    { ...paragraph, content: [{ ...text, attrs: { native: "metadata" } }] },
    { type: "heading", attrs: { level: 2 }, content: [text] },
    { type: "codeBlock", attrs: { language: "javascript" }, content: [text] },
    { ...paragraph, content: [{ type: "mention", attrs: { id: "native-account", text: "@Ada" } }] },
    {
      type: "mediaSingle",
      content: [{ type: "media", attrs: { type: "file", id: "native-media" } }],
    },
    {
      type: "table",
      content: [{ type: "tableRow", content: [{ type: "tableCell", content: [paragraph] }] }],
    },
  ]) {
    expect(isEditableAdf(doc([node]))).toBe(false);
  }
  expect(isEditableAdf({ ...doc([paragraph]), attrs: { native: "metadata" } })).toBe(false);
});

it("renders native tasks without accepting unknown or malformed task nodes", () => {
  const item = {
    type: "taskItem",
    attrs: { localId: "task-id", state: "TODO" },
    content: [{ type: "text", text: "Do this" }],
  };
  const list = {
    type: "taskList",
    attrs: { localId: "list-id" },
    content: [item, { ...item, attrs: { ...item.attrs, state: "DONE" } }],
  };
  const doc = (node: unknown) => ({ type: "doc", version: 1, content: [node] });
  expect(adfToText(doc(list))).toBe("- [ ] Do this\n- [x] Do this");
  expect(isEditableAdf(doc(list))).toBe(false);
  for (const node of [
    item,
    { ...list, attrs: {} },
    { ...list, content: [] },
    { ...list, content: [{ type: "paragraph", content: [] }] },
    { ...list, content: [{ ...item, attrs: { localId: "task-id", state: "unknown" } }] },
    { ...list, content: [{ ...item, attrs: { state: "TODO" } }] },
    { ...list, content: [{ ...item, content: [{ type: "unknownNode" }] }] },
    { ...list, content: [{ ...item, content: "not an array" }] },
  ]) {
    expect(() => adfToText(doc(node))).toThrow();
  }
  const nested = { ...list, content: [item, list] };
  expect(adfToText(doc(nested))).toContain("Do this");
  let deep: unknown = list;
  for (let i = 0; i < 33; i++) deep = { ...list, content: [item, deep] };
  expect(() => adfToText(doc(deep))).toThrow();
  expect(() =>
    adfToText(doc({ ...list, content: Array.from({ length: 10_001 }, () => item) })),
  ).toThrow();
  expect(() =>
    adfToText(
      doc({
        ...list,
        content: [{ ...item, content: [{ type: "text", text: "x".repeat(65_537) }] }],
      }),
    ),
  ).toThrow();
});
