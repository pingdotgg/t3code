import remarkParse from "remark-parse";
import { unified } from "unified";
import { expect, it } from "vite-plus/test";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "./proposedPlanText.ts";

it("takes the plan title from headings outside code", () => {
  for (const [open, inner, close] of [
    ["```bash", "~~~", "```"],
    ["~~~bash", "```", "~~~"],
    ["````bash", "```", "````"],
    ["```html", "<!--", "```"],
    ["```md", "```\u00a0", "``` \t"],
    ["```md\u2028", "example", "```"],
  ]) {
    const code = `${open}\n# Back up database\n${inner}\n# Still code\n${close}\n`;
    expect(proposedPlanTitle(`${code}\n## Real Plan Title\n`)).toBe("Real Plan Title");
  }
  expect(proposedPlanTitle("```bash\n# Back up database\n")).toBeNull();
  expect(proposedPlanTitle("\t# Back up database\n\n## Real Plan Title")).toBe("Real Plan Title");
});

it("takes the plan title from headings outside HTML comments", () => {
  for (const comment of ["<!--\n```ts\n-->", "<!--\n# Hidden title\n-->", "   <!-- # Hidden -->"]) {
    expect(proposedPlanTitle(`${comment}\n# Release plan`)).toBe("Release plan");
    expect(stripDisplayedPlanMarkdown(`${comment}\n# Release plan\n\n## Summary\n\nBody`)).toBe(
      "Body",
    );
  }
  expect(proposedPlanTitle("<!--\n# Hidden title\n# Release plan")).toBeNull();
  expect(stripDisplayedPlanMarkdown("<!--\n# Hidden title\n# Release plan")).toBe("");
});

it("keeps text on a comment's closing line while removing the plan title", () => {
  for (const [preamble, titleBlock, displayedPreamble = preamble] of [
    ["<!-- notes --> note", "# Release plan\n"],
    ["<!--\n# Hidden title\n--> note", "\n#\n# Release plan\n\n## Summary\n"],
    [
      "<!-- first --> note\n#\n<!-- second --> more",
      "# Release plan\n",
      "<!-- first --> note\n<!-- second --> more",
    ],
  ]) {
    const markdown = `${preamble}\n${titleBlock}\nBody`;
    expect(proposedPlanTitle(markdown)).toBe("Release plan");
    expect(stripDisplayedPlanMarkdown(markdown)).toBe(`${displayedPreamble}\n\nBody`);
  }
});

it("skips empty plan headings without reading into the next line", () => {
  for (const [heading, title] of [
    ["#   \r\n###\t\r\n## ###\r\n## Real Title", "Real Title"],
    ["## # #", "#"],
    ["## ###\t###", "###"],
  ]) {
    const markdown = `${heading}\r\n\r\n## Summary\r\n\r\nBody text`;
    expect(proposedPlanTitle(markdown)).toBe(title);
    expect(stripDisplayedPlanMarkdown(markdown)).toBe("Body text");
  }
});

it("strips the displayed plan title and summary after leading blank lines", () => {
  const markdown = "\r\n# My Plan\r\n\r\n## Summary\r\n\r\nBody text";
  expect(proposedPlanTitle(markdown)).toBe("My Plan");
  expect(stripDisplayedPlanMarkdown(markdown)).toBe("Body text");
});

it("reads the plan title past a leading byte-order mark", () => {
  for (const markdown of [
    "\uFEFF# Rollout\n\nDeploy",
    "\uFEFF   # Rollout\r\n\r\n## Summary\r\n\r\nDeploy",
  ]) {
    expect(proposedPlanTitle(markdown)).toBe("Rollout");
    expect(stripDisplayedPlanMarkdown(markdown)).toBe("Deploy");
  }
  expect(proposedPlanTitle("\uFEFF    # Indented code")).toBeNull();
});

const parseDisplayedPlan = (markdown: string) =>
  unified().use(remarkParse).parse(stripDisplayedPlanMarkdown(markdown));

it("strips the summary after a title that follows a code example", () => {
  const code = "```sh\nnode x\n```";
  const markdown = `${code}\n\n# Release plan\n\n## Summary\n\nBody`;
  const body = parseDisplayedPlan(markdown);
  expect(body.children.filter((node) => node.type !== "definition")).toMatchObject([
    { type: "code", lang: "sh", value: "node x" },
    { type: "paragraph", children: [{ type: "text", value: "Body" }] },
  ]);
});

it("keeps the ordered lists on either side of the plan title separate", () => {
  const markdown = "```sh\nnode x\n```\n\n1. Check staging\n\n# Release plan\n\n1. Deploy";
  const body = parseDisplayedPlan(markdown);
  const lists = body.children.filter((node) => node.type === "list");
  expect(lists.map((list) => [list.ordered, list.start, list.children.length])).toEqual([
    [true, 1, 1],
    [true, 1, 1],
  ]);
});

it("keeps headings inside list items and uses only the top-level heading as the title", () => {
  const list = "- Review the example\n\n  ```sh\n  node x\n  ```\n\n  ## Expected output";
  const markdown = `${list}\n\n# Release plan`;
  expect(proposedPlanTitle(markdown)).toBe("Release plan");
  expect(stripDisplayedPlanMarkdown(markdown)).toBe(list);
});
