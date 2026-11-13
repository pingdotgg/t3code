import { describe, expect, it } from "vite-plus/test";

import { serializeComposerFileLink } from "./composerTrigger.ts";
import { isTriagePrompt, replaceTriagePlaybookLink } from "./triagePrompt.ts";

const appPrompt = (playbookPath: string) =>
  `Read ${serializeComposerFileLink(playbookPath)} and follow it. `;

const MACHINE_A = "/Users/a/.t3/triage/1/triage-playbook.md";
const MACHINE_B = "/home/b/.t3/triage/2/triage-playbook.md";

describe("replaceTriagePlaybookLink", () => {
  it("replaces only the playbook link and keeps the text the user typed", () => {
    const other = serializeComposerFileLink("/Users/a/notes (old)/log.md");
    const prompt = `Before. ${appPrompt(MACHINE_A)}The app crashes, see ${other} (twice).`;

    expect(replaceTriagePlaybookLink(prompt, appPrompt(MACHINE_B))).toBe(
      `Before. ${appPrompt(MACHINE_B)}The app crashes, see ${other} (twice).`,
    );
  });

  it.each([
    ["spaces", "/Users/a b/My Data/triage-playbook.md"],
    ["parentheses", "/Users/a/t3 (dev)/triage-playbook.md"],
    ["hash and question mark", "/Users/a/#1/what?/triage-playbook.md"],
    ["a Windows path", "C:\\Users\\a b\\t3 (dev)\\triage-playbook.md"],
  ])("replaces a link whose path has %s", (_name, path) => {
    expect(replaceTriagePlaybookLink(`${appPrompt(path)}It is slow.`, appPrompt(MACHINE_B))).toBe(
      `${appPrompt(MACHINE_B)}It is slow.`,
    );
    expect(replaceTriagePlaybookLink(`${appPrompt(MACHINE_A)}It is slow.`, appPrompt(path))).toBe(
      `${appPrompt(path)}It is slow.`,
    );
  });

  it("replaces a link at the end of the prompt", () => {
    const link = serializeComposerFileLink(MACHINE_A);
    expect(replaceTriagePlaybookLink(`Follow ${link}`, appPrompt(MACHINE_B))).toBe(
      `Follow ${serializeComposerFileLink(MACHINE_B)}`,
    );
  });

  it("returns the prompt unchanged when it has no playbook link", () => {
    const prompt = `The app crashes, see ${serializeComposerFileLink("/Users/a/log.md")} please.`;
    expect(isTriagePrompt(prompt)).toBe(false);
    expect(replaceTriagePlaybookLink(prompt, appPrompt(MACHINE_B))).toBe(prompt);
  });

  it("returns the prompt unchanged when the prepared prompt has no playbook link", () => {
    expect(replaceTriagePlaybookLink(appPrompt(MACHINE_A), "Read the playbook.")).toBe(
      appPrompt(MACHINE_A),
    );
  });
});
