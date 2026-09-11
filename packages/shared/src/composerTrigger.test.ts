import { describe, expect, it } from "vite-plus/test";

import {
  applyComposerSkillModePrefix,
  serializeComposerFileLink,
  startsWithProviderSlashCommand,
} from "./composerTrigger.ts";

describe("serializeComposerFileLink", () => {
  it("uses the basename as the markdown label", () => {
    expect(serializeComposerFileLink("path/to/package.json")).toBe(
      "[package.json](path/to/package.json)",
    );
  });

  it("encodes markdown-sensitive destination characters", () => {
    expect(serializeComposerFileLink("docs/My File (draft).md")).toBe(
      "[My File (draft).md](docs/My%20File%20%28draft%29.md)",
    );
  });

  it("supports windows paths", () => {
    expect(serializeComposerFileLink("C:\\repo\\src\\index.ts")).toBe(
      "[index.ts](C:%5Crepo%5Csrc%5Cindex.ts)",
    );
  });

  it("preserves paths that legitimately start with an at sign", () => {
    expect(serializeComposerFileLink("@scope/package.json")).toBe(
      "[package.json](@scope/package.json)",
    );
  });
});

describe("applyComposerSkillModePrefix", () => {
  it("returns the text unchanged when there is no mode", () => {
    expect(applyComposerSkillModePrefix("fix the flaky test", null)).toBe("fix the flaky test");
  });

  it("returns the text unchanged when the mode name is blank", () => {
    expect(
      applyComposerSkillModePrefix("fix the flaky test", { name: "   ", label: "Review" }),
    ).toBe("fix the flaky test");
  });

  it("returns empty text unchanged", () => {
    expect(applyComposerSkillModePrefix("", { name: "review", label: "Review" })).toBe("");
  });

  it("returns whitespace-only text unchanged, preserving the original whitespace", () => {
    expect(applyComposerSkillModePrefix("   ", { name: "review", label: "Review" })).toBe("   ");
  });

  it("does not double-prefix text that already starts with the mention", () => {
    expect(
      applyComposerSkillModePrefix("$review the diff", { name: "review", label: "Review" }),
    ).toBe("$review the diff");
  });

  it("does not double-prefix an exact, standalone mention token", () => {
    expect(applyComposerSkillModePrefix("$review", { name: "review", label: "Review" })).toBe(
      "$review",
    );
  });

  it("prefixes text that merely shares the mention as a prefix of a longer token", () => {
    expect(
      applyComposerSkillModePrefix("$reviewer look", { name: "review", label: "Review" }),
    ).toBe("$review $reviewer look");
  });

  it("does not prefix a provider slash command", () => {
    expect(applyComposerSkillModePrefix("/compact", { name: "review", label: "Review" })).toBe(
      "/compact",
    );
  });

  it("does not prefix a slash command surrounded by whitespace, preserving the original", () => {
    expect(
      applyComposerSkillModePrefix(" /review src/x.ts ", { name: "review", label: "Review" }),
    ).toBe(" /review src/x.ts ");
  });

  it("prefixes an absolute path that is not a slash command", () => {
    expect(
      applyComposerSkillModePrefix("/home/theo/app.ts crashed", {
        name: "review",
        label: "Review",
      }),
    ).toBe("$review /home/theo/app.ts crashed");
  });

  it("prefixes a plain prompt", () => {
    expect(
      applyComposerSkillModePrefix("fix the flaky test", { name: "review", label: "Review" }),
    ).toBe("$review fix the flaky test");
  });
});

describe("startsWithProviderSlashCommand", () => {
  it("recognizes a bare command", () => {
    expect(startsWithProviderSlashCommand("/compact")).toBe(true);
  });

  it("recognizes a command carrying arguments", () => {
    expect(startsWithProviderSlashCommand("/plugin:skill do the thing")).toBe(true);
  });

  it("ignores an absolute path", () => {
    expect(startsWithProviderSlashCommand("/home/theo/app.ts crashed")).toBe(false);
  });

  it("ignores prose", () => {
    expect(startsWithProviderSlashCommand("fix the flaky test")).toBe(false);
  });
});
