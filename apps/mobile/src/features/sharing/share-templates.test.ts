import { describe, expect, it } from "vite-plus/test";

import { applyShareTemplate, shareTemplateLabel, usableShareTemplates } from "./share-templates";

describe("applyShareTemplate", () => {
  it.each([
    {
      name: "appends the shared text after a template without a placeholder",
      prompt: "Review this for bugs:\n",
      shared: "https://example.com/pr/1",
      expected: "Review this for bugs:\n\nhttps://example.com/pr/1",
    },
    {
      name: "preserves shared indentation and trailing newlines",
      prompt: "  {{shared}}  ",
      shared: "    code\n",
      expected: "    code\n",
    },
    {
      name: "fills every placeholder",
      prompt: "Summarize {{shared}} and cite {{shared}}.",
      shared: "the article",
      expected: "Summarize the article and cite the article.",
    },
    {
      name: "keeps replacement patterns in the shared text literally",
      prompt: "Explain: {{shared}}",
      shared: "cost is $& or $1",
      expected: "Explain: cost is $& or $1",
    },
    {
      name: "uses the template alone when only files were shared",
      prompt: "Describe these images.\n\n{{shared}}",
      shared: "",
      expected: "Describe these images.",
    },
    {
      name: "uses the template alone without a placeholder or shared text",
      prompt: "  Describe these images.  ",
      shared: "",
      expected: "Describe these images.",
    },
  ])("$name", ({ prompt, shared, expected }) => {
    expect(applyShareTemplate(prompt, shared)).toBe(expected);
  });
});

describe("shareTemplateLabel", () => {
  it.each([
    { prompt: "\nReview this for bugs:\nMore detail", expected: "Review this for bugs:" },
    { prompt: "Summarize {{shared}}", expected: "Summarize …" },
    { prompt: "{{shared}}", expected: "…" },
    { prompt: "   ", expected: "Template" },
  ])("labels $prompt as $expected", ({ prompt, expected }) => {
    expect(shareTemplateLabel(prompt)).toBe(expected);
  });
});

describe("usableShareTemplates", () => {
  it("skips blank templates", () => {
    expect(
      usableShareTemplates([
        { id: "a", prompt: "Review" },
        { id: "b", prompt: "  \n" },
      ]),
    ).toEqual([{ id: "a", prompt: "Review" }]);
  });
});
