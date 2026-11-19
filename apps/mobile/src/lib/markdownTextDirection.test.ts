import { describe, expect, it } from "vite-plus/test";
import { markdownWithTextDirection } from "./markdownDocument";

const LRM = "‎";
const RLM = "‏";

describe("markdownWithTextDirection", () => {
  it("leaves text without right-to-left letters untouched", () => {
    const markdown = "- **Plantur**, Haarserum 100 ml, 14,95 €.";
    expect(markdownWithTextDirection(markdown)).toBe(markdown);
  });

  it("marks Arabic list items that open with an English name", () => {
    const markdown = [
      "## للنمو والتقوية",
      "",
      "- **Plantur**، Haarserum 100 مل، 14,95 €. سيروم مخصص للشعر الطويل بالكافيين، أغلى واحد في القائمة.",
      "- **Bali Curls**، زيت إكليل الجبل للفروة والشعر، موجه للشعر اللي بيخف.",
    ].join("\n");

    expect(markdownWithTextDirection(markdown)).toBe(
      [
        "## للنمو والتقوية",
        "",
        `- **${RLM}Plantur**، Haarserum 100 مل، 14,95 €. سيروم مخصص للشعر الطويل بالكافيين، أغلى واحد في القائمة.`,
        `- **${RLM}Bali Curls**، زيت إكليل الجبل للفروة والشعر، موجه للشعر اللي بيخف.`,
      ].join("\n"),
    );
  });

  it("keeps an English list on one side when one item opens in Arabic", () => {
    const markdown = "- Install the package first.\n- مرحبا then run the build and tests.";
    expect(markdownWithTextDirection(markdown)).toBe(
      `- Install the package first.\n- ${LRM}مرحبا then run the build and tests.`,
    );
  });

  it("skips code and keeps task list checkboxes intact", () => {
    const markdown = "```\nconst a = 'مرحبا';\n```\n\n- [ ] npm تشغيل الأوامر من المجلد الرئيسي";
    expect(markdownWithTextDirection(markdown)).toBe(
      `\`\`\`\nconst a = 'مرحبا';\n\`\`\`\n\n- [ ] ${RLM}npm تشغيل الأوامر من المجلد الرئيسي`,
    );
  });
});
