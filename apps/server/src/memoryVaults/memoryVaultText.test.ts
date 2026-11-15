import { describe, expect, it } from "vite-plus/test";

import {
  asksForWholeVault,
  redactSecrets,
  renderVaultContext,
  selectVaultSections,
  slugifyVaultName,
  splitSections,
} from "./memoryVaultText.ts";

const vault = [
  ...splitSections(
    "PROJECT.md",
    "# Project\n\nA recipe sharing web app built with React and Supabase.\n",
  ),
  ...splitSections(
    "DECISIONS.md",
    "# Decisions\n\n## Authentication\nUse Supabase magic links; passwords were dropped in March.\n\n## Styling\nTailwind with a custom palette.\n",
  ),
  ...splitSections("TASKS.md", "# Tasks\n\n## In progress\n\n## Done\n"),
];

describe("memory vault text", () => {
  it("names vault folders safely", () => {
    expect(slugifyVaultName("My Web Application!")).toBe("my-web-application");
    expect(slugifyVaultName("../../etc")).toBe("etc");
    expect(slugifyVaultName("***")).toBe("vault");
  });

  it("never stores credentials", () => {
    const { text, redacted } = redactSecrets(
      "Use OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456 and token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    );
    expect(redacted).toBe(2);
    expect(text).not.toContain("sk-proj-abc");
    expect(text).not.toContain("ghp_abc");
    expect(redactSecrets("The auth flow uses magic links.").redacted).toBe(0);
  });

  it("adds the overview and the matching sections, not the whole vault", () => {
    const { sections } = selectVaultSections({
      sections: vault,
      userText: "Fix the login authentication bug",
      budgetChars: 4000,
      full: false,
    });
    expect(sections.map((section) => section.heading)).toEqual(["Project", "Authentication"]);
  });

  it("skips untouched template sections and respects the budget", () => {
    const { sections, omitted } = selectVaultSections({
      sections: vault,
      userText: "anything",
      budgetChars: 4000,
      full: true,
    });
    expect(sections.some((section) => section.path === "TASKS.md")).toBe(false);
    const tight = selectVaultSections({
      sections: vault,
      userText: "x",
      budgetChars: 80,
      full: true,
    });
    expect(
      tight.sections.reduce((sum, section) => sum + section.text.length, 0),
    ).toBeLessThanOrEqual(80);
    expect(omitted).toBe(0);
  });

  it("recognizes a request to read the whole vault", () => {
    expect(asksForWholeVault("Please read the entire memory vault first")).toBe(true);
    expect(asksForWholeVault("Fix the vault door animation")).toBe(false);
  });

  it("tells read-only threads not to write and others how to", () => {
    const base = {
      vaultName: "Recipes",
      autoUpdate: true,
      detailLevel: "standard" as const,
      files: ["PROJECT.md"],
      sections: [],
      omittedSections: 0,
    };
    expect(renderVaultContext({ ...base, access: "read-write" })).toContain(
      "continuum_memory_update",
    );
    expect(renderVaultContext({ ...base, access: "read-only" })).toContain("read-only");
  });
});
