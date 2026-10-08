import { EnvironmentId, MessageId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { serializeAssistantCitation } from "./assistantCitations.ts";
import { searchableMessageSegments } from "./threadFindText.ts";

it("excludes review attachments rendered as context chips", () => {
  const text = [
    "Before **review**",
    '<review_comment sectionId="turn:2" sectionTitle="Turn 2" filePath="hidden.ts" startIndex="3" endIndex="14" rangeLabel="L4">',
    "Keep **this literal** comment.",
    "```diff",
    "+ hidden patch content",
    "```",
    "</review_comment>",
    "After review",
  ].join("\n");
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([
    "Before review",
    " After review",
  ]);
});

it("keeps malformed review tags visible, matching the message renderer", () => {
  const text = "<review_comment>not a valid attachment</review_comment>";
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([text]);
});

it("excludes structured context chips without joining text across them", () => {
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text: "before[hidden label](t3-context://v1/terminal/terminal_1)after",
      context: { version: 1, records: [] },
    }),
  ).toEqual(["before", "after"]);
});

it("does not upgrade literal legacy tags in messages with structured context", () => {
  const text =
    "<terminal_context>\n- Terminal 1 line 12:\n  12 | visible output\n</terminal_context>";
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text,
      context: { version: 1, records: [] },
    })?.join("\n"),
  ).toContain("visible output");
  expect(searchableMessageSegments({ role: "user", streaming: false, text })).toEqual([]);
});

it("keeps context reference syntax inside code searchable", () => {
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text: "`[label](t3-context://v1/terminal/terminal_1)`",
    }),
  ).toEqual(["[label](t3-context://v1/terminal/terminal_1)"]);
});

it("excludes repeated legacy attachments containing literal context tags", () => {
  const context =
    "<terminal_context>\n- Terminal 1 line 12:\n  12 | <terminal_context>literal</terminal_context>\n</terminal_context>";
  expect(
    searchableMessageSegments({
      role: "user",
      streaming: false,
      text: `Fix this\n\n${context}\n\n${context}`,
    }),
  ).toEqual(["Fix this"]);
});

const assistantSegments = (text: string, cwd?: string) =>
  searchableMessageSegments({ role: "assistant", text, streaming: false }, cwd);

it("searches displayed prose and file-chip labels without hidden paths", () => {
  expect(
    assistantSegments("[important description](/tmp/actual.ts). `/tmp/inline-example.ts:42`"),
  ).toEqual(["important description actual.ts. inline-example.ts · L42"]);
  expect(assistantSegments("[label](src/main.ts#L3C2)", "/workspace/repo")).toEqual([
    "label main.ts · L3:C2",
  ]);
  expect(assistantSegments("[label](src/main.ts#L3C2)")).toEqual(["label"]);
});

it("includes the same parent suffixes for duplicate filenames as the renderer", () => {
  expect(
    assistantSegments(
      "[first](src/main.ts) and `/workspace/repo/tests/main.ts:2`",
      "/workspace/repo",
    ),
  ).toEqual(["first main.ts · repo/src and main.ts · repo/tests · L2"]);
  expect(
    assistantSegments(
      "[first](src/main.ts) and `/workspace/repo/src/main.ts:2`",
      "/workspace/repo",
    ),
  ).toEqual(["first main.ts and main.ts · L2"]);
});

it("keeps fence paths literal and indexes file-chip labels in user messages", () => {
  expect(assistantSegments("```text\n/tmp/file.ts:42\n```")).toEqual(["/tmp/file.ts:42\n"]);
  expect(
    searchableMessageSegments({ role: "user", text: "`/tmp/file.ts:42`", streaming: false }),
  ).toEqual(["file.ts · L42"]);
});

it("indexes nested disclosure summaries and bodies in rendered order", () => {
  expect(
    assistantSegments(
      "<details><summary>Outer</summary><p>first</p><details><summary>Inner</summary><p>second</p></details></details>",
    ),
  ).toEqual(["Outer", "first", "Inner", "second"]);
});

it("uses Insight line breaks without splitting ordinary assistant prose", () => {
  expect(assistantSegments("★ Insight ─────\nfirst line\nsecond line")).toEqual([
    "★ Insight ─────",
    " first line",
    " second line",
  ]);
  expect(assistantSegments("first line\nsecond line")).toEqual(["first line second line"]);
});

it("indexes skill labels in prose but leaves links and code literal", () => {
  expect(
    searchableMessageSegments(
      {
        role: "assistant",
        streaming: false,
        text: "Use $test-t3-app now.\n\n`$test-t3-app`\n\n[$test-t3-app](https://example.com)",
      },
      undefined,
      [{ name: "test-t3-app", displayName: "T3 App Testing" }],
    ),
  ).toEqual(["Use T3 App Testing now.", "$test-t3-app", "$test-t3-app"]);
});

it("indexes the citation chip label instead of its link text", () => {
  const citation = {
    version: 1 as const,
    environmentId: EnvironmentId.make("environment"),
    threadId: ThreadId.make("thread"),
    messageId: MessageId.make("message"),
    text: "cited   needle",
    start: 0,
    end: 14,
    prefix: "",
    suffix: "",
  };
  const text = `Please fix ${serializeAssistantCitation(citation)} thanks`;
  expect(searchableMessageSegments({ role: "user", text, streaming: false })).toEqual([
    "Please fix cited needle thanks",
  ]);
  const commented = serializeAssistantCitation({ ...citation, comment: "my note" });
  expect(searchableMessageSegments({ role: "user", text: commented, streaming: false })).toEqual([
    "my note",
  ]);
});
