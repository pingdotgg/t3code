import { expect, it } from "vite-plus/test";
import { instructionSections, mergeInstructionSection } from "./instructions.ts";

it("keeps code fences and nested headings within the selected H2 section", () => {
  const text =
    "# Guide\nIntro\n\n## Build\n```md\n## Example\n```\n### Details\nRun it.\n\n## Deploy\nShip it.\n";
  const sections = instructionSections(text);
  expect(sections.map((section) => section.title)).toEqual(["Introduction", "Build", "Deploy"]);
  expect(sections[1]?.contents).toContain("## Example\n```\n### Details");
});
it("keeps repeated heading identities distinct", () => {
  expect(
    instructionSections("## Rules\nOne\n## Rules\nTwo\n").map((section) => section.id),
  ).toEqual(["Rules:0", "Rules:1"]);
});
it("excludes imported sections from a source to prevent re-export loops", () => {
  const sections = instructionSections(
    `<!-- t3-sync:${"a".repeat(64)} -->\n## Rules\nImported\n<!-- /t3-sync:${"a".repeat(64)} -->\n## Rules\nLocal\n`,
  );
  expect(sections.map((section) => section.id)).toEqual(["Rules:0"]);
  expect(sections[0]?.contents).toBe("## Rules\nLocal\n");
});
it("refuses malformed markers without changing local text", () => {
  const id = "b".repeat(64);
  expect(mergeInstructionSection(`Local\n<!-- t3-sync:${id} -->\nBroken`, id, "New")).toBeNull();
  expect(
    mergeInstructionSection(`<!-- /t3-sync:${id} -->\n<!-- t3-sync:${id} -->`, id, "New"),
  ).toBeNull();
});
