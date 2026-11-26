import { expect, it } from "vite-plus/test";
import { proposedPlanTitle, stripDisplayedPlanMarkdown } from "./proposedPlanText.ts";

it("takes the plan title from headings outside code", () => {
  for (const [open, inner, close] of [
    ["```bash", "~~~", "```"],
    ["~~~bash", "```", "~~~"],
    ["````bash", "```", "````"],
  ]) {
    const code = `${open}\n# Back up database\n${inner}\n# Still code\n${close}\n`;
    expect(proposedPlanTitle(`${code}\n## Real Plan Title\n`)).toBe("Real Plan Title");
  }
  expect(proposedPlanTitle("```bash\n# Back up database\n")).toBeNull();
  expect(proposedPlanTitle("\t# Back up database\n\n## Real Plan Title")).toBe("Real Plan Title");
});

it("skips empty plan headings without reading into the next line", () => {
  const markdown = "#   \r\n###\t\r\n## Real Title\r\n\r\n## Summary\r\n\r\nBody text";
  expect(proposedPlanTitle(markdown)).toBe("Real Title");
  expect(stripDisplayedPlanMarkdown(markdown)).toBe("Body text");
});

it("strips the displayed plan title and summary after leading blank lines", () => {
  const markdown = "\r\n# My Plan\r\n\r\n## Summary\r\n\r\nBody text";
  expect(proposedPlanTitle(markdown)).toBe("My Plan");
  expect(stripDisplayedPlanMarkdown(markdown)).toBe("Body text");
});
