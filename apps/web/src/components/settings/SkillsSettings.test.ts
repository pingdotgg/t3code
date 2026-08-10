import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, ProviderInstanceId, type SkillInventory } from "@t3tools/contracts";

import {
  displayedSkillCount,
  filterSkillInventory,
  formatSkillCount,
  formatSkillPath,
  groupSkillsByHarness,
  setKeyCollapsed,
  skillContentForDisplay,
} from "@t3tools/client-runtime/state/skills";

const inventory: SkillInventory = {
  scannedAt: "2026-07-27T12:00:00.000Z",
  installations: [
    {
      providerInstanceId: ProviderInstanceId.make("codex"),
      harness: ProviderDriverKind.make("codex"),
      harnessDisplayName: "Codex",
      name: "review",
      description: "Review changes",
      directoryPath: "/home/test/.codex/skills/review",
      skillFilePath: "/home/test/.codex/skills/review/SKILL.md",
      content: "---\nname: review\n---\n\n# Review",
    },
    {
      providerInstanceId: ProviderInstanceId.make("claude"),
      harness: ProviderDriverKind.make("claudeAgent"),
      harnessDisplayName: "Claude",
      name: "deploy",
      directoryPath: "/home/test/.claude/skills/deploy",
      skillFilePath: "/home/test/.claude/skills/deploy/SKILL.md",
      content: "---\nname: deploy\n---\n\n# Deploy",
    },
  ],
};

describe("filterSkillInventory", () => {
  it("matches skill metadata, harnesses, and paths case-insensitively", () => {
    expect(
      filterSkillInventory(inventory, "REVIEW").installations.map((skill) => skill.name),
    ).toEqual(["review"]);
    expect(
      filterSkillInventory(inventory, "Claude").installations.map((skill) => skill.name),
    ).toEqual(["deploy"]);
    expect(
      filterSkillInventory(inventory, ".codex").installations.map((skill) => skill.name),
    ).toEqual(["review"]);
  });

  it("returns all installations for a blank query", () => {
    expect(filterSkillInventory(inventory, "  ")).toBe(inventory);
  });
});

describe("formatSkillPath", () => {
  it("shortens home-relative and deep paths for display", () => {
    expect(formatSkillPath("/home/theo/.claude/skills/review")).toBe("~/.claude/skills/review");
    expect(formatSkillPath("/home/theo/skills/review")).toBe("~/skills/review");
    expect(formatSkillPath("/var/lib/t3/skills/review")).toBe("…/t3/skills/review");
  });
});

describe("skill explorer helpers", () => {
  it("hides a previously loaded skill count after disconnecting", () => {
    expect(displayedSkillCount(inventory, true)).toBe(2);
    expect(displayedSkillCount(inventory, false)).toBeNull();
    expect(displayedSkillCount(null, true)).toBeNull();
  });

  it("labels filtered skill counts without hiding the installed total", () => {
    expect(formatSkillCount(12)).toBe("12 skills");
    expect(formatSkillCount(1)).toBe("1 skill");
    expect(formatSkillCount(12, 2)).toBe("2 of 12 skills");
  });

  it("applies the requested harness collapsed state without toggling blindly", () => {
    const collapsed = setKeyCollapsed(new Set<string>(), "codex", true);
    expect([...collapsed]).toEqual(["codex"]);
    expect([...setKeyCollapsed(collapsed, "codex", true)]).toEqual(["codex"]);
    expect([...setKeyCollapsed(collapsed, "codex", false)]).toEqual([]);
  });

  it("groups installations by harness instance and derives their shared root", () => {
    const groups = groupSkillsByHarness(inventory.installations);
    expect(
      groups.map((group) => ({
        name: group.harnessDisplayName,
        rootPath: group.rootPath,
        skills: group.skills.map((skill) => skill.name),
      })),
    ).toEqual([
      {
        name: "Codex",
        rootPath: "/home/test/.codex/skills",
        skills: ["review"],
      },
      {
        name: "Claude",
        rootPath: "/home/test/.claude/skills",
        skills: ["deploy"],
      },
    ]);
  });

  it("normalizes empty skill content for the detail view", () => {
    expect(skillContentForDisplay(" \n ")).toBeNull();
    expect(skillContentForDisplay("\n# Review\n")).toBe("# Review");
  });
});
