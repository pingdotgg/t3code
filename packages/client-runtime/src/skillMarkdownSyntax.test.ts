import {
  collectComposerSkillTokens,
  serializeComposerSkillToken,
} from "@t3tools/shared/composerInlineTokens";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { describe, expect, it } from "vite-plus/test";

import { remarkSkillTokens } from "./skillMarkdownSyntax.ts";

const parser = unified().use(remarkParse).use(remarkSkillTokens).freeze();

describe("quoted skill Markdown syntax", () => {
  it.each(["\t", "\u00a0", "\v", "\uFEFF"])(
    "preserves tokens beside %j whitespace",
    (separator) => {
      const name = "Review \\Tools";
      const paragraph = parser.parse(
        `Use${separator}${serializeComposerSkillToken(name)}${separator}next`,
      ).children[0];
      if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
      const text = paragraph.children
        .filter((child) => child.type === "text")
        .map((child) => child.value)
        .join("");
      expect(collectComposerSkillTokens(text).map((skill) => skill.value)).toEqual([name]);
    },
  );

  it.each(["€", "£", "¥", "₹", "₩", "₿", "𑿝"])("preserves %s quoted skill aliases", (prefix) => {
    const name = "Review **UI**";
    const source = `${prefix}${serializeComposerSkillToken(name).slice(1)}`;
    const paragraph = parser.parse(`Use ${source} next`).children[0];
    if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
    const text = paragraph.children
      .filter((child) => child.type === "text")
      .map((child) => child.value)
      .join("");
    expect(collectComposerSkillTokens(text).map((skill) => skill.value)).toEqual([name]);
  });

  it.each([
    'Review "UI"',
    "Review \\Tools",
    "Review **UI**",
    "Review [UI](file)",
    "Review\nUI",
    "Review\rUI",
    "Review\r\nUI",
  ])("preserves %s as literal source while parsing surrounding Markdown", (name) => {
    const token = serializeComposerSkillToken(name);
    const paragraph = parser.parse(`**Use** ${token} next`).children[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
    expect(paragraph.children[0]?.type).toBe("strong");
    const text = paragraph.children
      .filter((child) => child.type === "text")
      .map((child) => child.value)
      .join("");
    expect(collectComposerSkillTokens(text).map((skill) => skill.value)).toEqual([name]);
  });

  it("keeps quoted skill examples inside inline and fenced code as code", () => {
    const token = serializeComposerSkillToken('Review "UI"');
    const root = parser.parse(`\`${token}\`\n\n\`\`\`text\n${token}\n\`\`\``);
    const paragraph = root.children[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
    expect(paragraph.children).toMatchObject([{ type: "inlineCode", value: token }]);
    expect(root.children[1]).toMatchObject({ type: "code", value: token });
  });

  it.each(['$""', '$"unclosed', '$"skill"suffix', 'prefix$"skill"'])(
    "leaves malformed or adjacent %s outside the skill grammar",
    (source) => {
      const paragraph = parser.parse(source).children[0];
      expect(paragraph?.type).toBe("paragraph");
      if (paragraph?.type !== "paragraph") throw new Error("Missing paragraph");
      expect(paragraph.children).toMatchObject([{ type: "text", value: source }]);
      expect(collectComposerSkillTokens(source)).toEqual([]);
    },
  );
});
