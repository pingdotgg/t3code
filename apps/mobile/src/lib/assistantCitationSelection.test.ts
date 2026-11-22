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
  const [first] = collectMobileAssistantTextSelectors(markdown, "0:0", "quote");
  const [second] = collectMobileAssistantTextSelectors(markdown, "1/1/0:0", "quote");
  expect([first?.index, first?.count, second?.index, second?.count]).toEqual([0, 2, 1, 2]);
  const rendered = `${"x".repeat(40)}quote${"x".repeat(40)} ${"x".repeat(40)}quote${"x".repeat(40)}`;
  expect(second?.selector.start).toBe(rendered.lastIndexOf("quote"));
  // Identical context on both sides stays ambiguous rather than guessing.
  expect(findAssistantCitationText(rendered, second!.selector)).toBeNull();
  const markers = [first!, second!].map(({ selector }) =>
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
  const [reference] = collectMobileAssistantTextSelectors(
    "before [label][id] after\n\n<details><summary>More</summary>\n\n[id]: https://example.com\n\n</details>",
    "0:0",
    "before label after",
  );
  expect(reference?.selector.text).toBe("before label after");
  const sameBlock = collectMobileAssistantTextSelectors(
    "first **quote** then **quote** last",
    "0:0",
    "quote",
  );
  expect(sameBlock[1]?.selector.start).toBe(17);
  expect(sameBlock[1]?.selector.prefix).toBe("first quote then ");
  const [leadingSpace] = collectMobileAssistantTextSelectors(
    "x\n\n<details><summary>More</summary>\n\n` quote`\n\n</details>",
    "1/0:0",
    "quote",
  );
  expect(leadingSpace?.selector.start).toBe(2);
  expect(leadingSpace?.count).toBe(1);
  const codeChoices = collectMobileAssistantTextSelectors(
    "quote\n\n```text\nquote\n```\n\nquote",
    "0:0",
    "quote",
  );
  expect(codeChoices.map((choice) => [choice.index, choice.count])).toEqual([
    [0, 3],
    [1, 3],
    [2, 3],
  ]);
  for (const { source, path } of [
    { source: "![before](image.png)\n\nquote quote\n\n![after](image.png)", path: "0:0" },
    {
      source: 'quote\n\n```mermaid\nflowchart TD\nA["quote"]\n```\n\nquote',
      path: "0:0",
    },
    {
      source:
        "![before](image.png)\n\n<details><summary>More</summary>\n\nquote quote\n\n</details>\n\n![after](image.png)",
      path: "1/0:0",
    },
  ]) {
    const selectors = collectMobileAssistantTextSelectors(source, path, "quote");
    expect(selectors).toHaveLength(2);
    for (const [index, { selector }] of selectors.entries()) {
      expect(findAssistantCitationText("quote quote", selector)).toEqual({
        start: index * 6,
        end: index * 6 + 5,
      });
    }
  }
});

it("rejects unmappable or blank selections instead of inventing a source", () => {
  expect(collectMobileAssistantTextSelectors("quote quote", "0:0", " ")).toEqual([]);
  expect(collectMobileAssistantTextSelectors("quote ".repeat(21), "0:0", "quote")).toEqual([]);
  expect(collectMobileAssistantTextSelectors("quote quote", "0:0", "other")).toEqual([]);
  expect(collectMobileAssistantTextSelectors("quote quote", "missing", "quote")).toEqual([]);
});

it("uses the web math representation around a selected passage", () => {
  for (const formula of ["$x$", "\\(x\\)"]) {
    const [choice] = collectMobileAssistantTextSelectors(`Before ${formula} after`, "0:0", "after");
    expect(choice?.selector.prefix).toBe("Before \\(x\\) ");
    expect(findAssistantCitationText("Before \\(x\\) after", choice!.selector)).toEqual({
      start: 13,
      end: 18,
    });
  }
  const [display] = collectMobileAssistantTextSelectors(
    "Before\n\n$$\nx\n$$\n\nafter",
    "0:0",
    "after",
  );
  expect(display?.selector.prefix).toBe("Before \\[ x \\] ");
});
