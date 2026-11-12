import { expect, it } from "vite-plus/test";
import { collectMobileAssistantTextSelectors } from "./assistantCitationSelection";
import {
  findAssistantCitationText,
  serializeAssistantCitation,
  expandAssistantCitationsForProvider,
} from "@t3tools/shared/assistantCitations";
import { EnvironmentId, ThreadId, MessageId } from "@t3tools/contracts";

it("offers distinct source choices within a block and maps recursive folds without merging occurrences", () => {
  const paragraph = `${"x".repeat(40)}**quote**${"x".repeat(40)}`;
  const markdown = `${paragraph}\n\n<details><summary>Outer</summary>\n\n<details><summary>Inner</summary>\n\n${paragraph}\n\n</details>\n\n</details>`;
  const first = collectMobileAssistantTextSelectors(markdown, "0:0", "quote")[0];
  const second = collectMobileAssistantTextSelectors(markdown, "1/1/0:0", "quote")[0];
  expect(first?.occurrence).toEqual({ index: 0, count: 2 });
  expect(second?.occurrence).toEqual({ index: 1, count: 2 });
  const rendered = `${"x".repeat(40)}quote${"x".repeat(40)} ${"x".repeat(40)}quote${"x".repeat(40)}`;
  expect(findAssistantCitationText(rendered, second!)).toEqual({
    start: rendered.lastIndexOf("quote"),
    end: rendered.lastIndexOf("quote") + 5,
  });
  const markers = [first!, second!].map((selector) =>
    serializeAssistantCitation({
      version: 1,
      environmentId: EnvironmentId.make("env"),
      threadId: ThreadId.make("thread"),
      messageId: MessageId.make("assistant"),
      ...selector,
    }),
  );
  expect(markers[0]).not.toBe(markers[1]);
  expect(expandAssistantCitationsForProvider(markers.join(" "))).toContain(
    '"id": "assistant-quote-2"',
  );
  const sameBlock = collectMobileAssistantTextSelectors(
    "first **quote** then **quote** last",
    "0:0",
    "quote",
  );
  expect(sameBlock[1]?.start).toBe(17);
  expect(sameBlock[1]?.prefix).toBe("first quote then ");
});

it("rejects unmappable or blank selections instead of inventing a source", () => {
  expect(collectMobileAssistantTextSelectors("quote quote", "0:0", " ")).toEqual([]);
  expect(collectMobileAssistantTextSelectors("quote ".repeat(21), "0:0", "quote")).toEqual([]);
  expect(collectMobileAssistantTextSelectors("quote quote", "0:0", "other")).toEqual([]);
  expect(collectMobileAssistantTextSelectors("quote quote", "missing", "quote")).toEqual([]);
});

it("uses the web math representation around a selected passage", () => {
  for (const formula of ["$x$", "\\(x\\)"]) {
    const [selector] = collectMobileAssistantTextSelectors(
      `Before ${formula} after`,
      "0:0",
      "after",
    );
    expect(selector?.prefix).toBe("Before \\(x\\) ");
    expect(findAssistantCitationText("Before \\(x\\) after", selector!)).toEqual({
      start: 13,
      end: 18,
    });
  }
  const [display] = collectMobileAssistantTextSelectors(
    "Before\n\n$$\nx\n$$\n\nafter",
    "0:0",
    "after",
  );
  expect(display?.prefix).toBe("Before \\[ x \\] ");
});
