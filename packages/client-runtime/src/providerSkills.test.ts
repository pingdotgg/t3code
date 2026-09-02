import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  dedupeProviderSkillsByName,
  formatProviderSkillDisplayName,
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
  resolveProviderSkillsForCwd,
  resolveProviderSlashCommandsForCwd,
  resolveProviderSkillSourceKind,
} from "./providerSkills.ts";

const provider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [],
  slashCommands: [{ name: "global" }],
  skills: [{ name: "global", path: "/global/SKILL.md", enabled: true }],
  workspaceSnapshots: [
    {
      cwd: "/workspace/project-a",
      checkedAt: "2026-01-01T00:01:00.000Z",
      slashCommands: [{ name: "project" }],
      skills: [{ name: "project", path: "/workspace/project-a/SKILL.md", enabled: true }],
    },
  ],
} satisfies ServerProvider;

describe("formatProviderSkillDisplayName", () => {
  it("prefers the provider display name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
        displayName: "Review Follow-up",
      }),
    ).toBe("Review Follow-up");
  });

  it("falls back to a title-cased skill name", () => {
    expect(
      formatProviderSkillDisplayName({
        name: "review-follow-up",
      }),
    ).toBe("Review Follow Up");
  });
});

describe("dedupeProviderSkillsByName", () => {
  it("keeps the first resolved skill and preserves unrelated skill order", () => {
    const firstSkill = {
      name: "branch-audit",
      path: "/Users/matt/.codex/skills/branch-audit/SKILL.md",
      enabled: true,
    };
    const otherSkill = {
      name: "browser",
      path: "/Users/matt/.agents/skills/browser/SKILL.md",
      enabled: true,
    };
    const duplicateSkill = {
      name: "Branch-Audit",
      path: "/Users/matt/.agents/skills/branch-audit/SKILL.md",
      enabled: true,
    };

    expect(dedupeProviderSkillsByName([firstSkill, otherSkill, duplicateSkill])).toEqual([
      firstSkill,
      otherSkill,
    ]);
  });
});

describe("getProviderSkillsForSlashMenu", () => {
  it("keeps the skill alias when the provider also exposes it as a slash command", () => {
    const askMatt = {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    };
    expect(getProviderSkillsForSlashMenu([askMatt], true).map((skill) => skill.name)).toEqual([
      "ask-matt",
    ]);
  });

  it("shows one row when enabled skills share a name", () => {
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: true,
      },
      {
        name: "browser",
        path: "/Users/matt/.agents/skills/browser/SKILL.md",
        enabled: true,
      },
      {
        name: "babysit-pr",
        path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
        enabled: true,
      },
    ];

    expect(getProviderSkillsForSlashMenu(skills, true).map((skill) => skill.name)).toEqual([
      "babysit-pr",
      "browser",
    ]);
  });

  it("keeps an enabled skill when a disabled duplicate appears first", () => {
    const enabledSkill = {
      name: "babysit-pr",
      path: "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
      enabled: true,
    };
    const skills = [
      {
        name: "babysit-pr",
        path: "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
        enabled: false,
      },
      enabledSkill,
    ];

    expect(getProviderSkillsForSlashMenu(skills, true)).toEqual([enabledSkill]);
  });
});

describe("getProviderSkillsForSlashMenu", () => {
  it("drops a skill the provider reserves for the agent", () => {
    const skills = [
      {
        name: "legacy-system-context",
        path: "/Users/matt/.claude/skills/legacy-system-context/SKILL.md",
        enabled: true,
        userInvocable: false,
      },
      {
        name: "deploy",
        path: "/Users/matt/.claude/skills/deploy/SKILL.md",
        enabled: true,
        // Reserved for the user, not the agent: still a valid pick.
        userInvocationOnly: true,
      },
    ];

    expect(getProviderSkillsForSlashMenu(skills, true).map((skill) => skill.name)).toEqual([
      "deploy",
    ]);
  });
});

describe("getProviderSlashCommandsForSlashMenu", () => {
  const commands = [
    { name: "ask-matt", description: "Ask which skill fits your situation." },
    { name: "compact", description: "Compact the conversation." },
  ];
  const skills = [
    {
      name: "ask-matt",
      path: "/Users/matt/.agents/skills/ask-matt/SKILL.md",
      enabled: true,
    },
  ];

  it("lets the skill alias win when a provider command has the same name", () => {
    expect(
      getProviderSlashCommandsForSlashMenu(commands, skills).map((command) => command.name),
    ).toEqual(["compact"]);
  });

  it("keeps the provider command when the matching skill alias is hidden", () => {
    const visibleSkills = getProviderSkillsForSlashMenu(skills, false);

    expect(
      getProviderSlashCommandsForSlashMenu(commands, visibleSkills).map((command) => command.name),
    ).toEqual(["ask-matt", "compact"]);
  });
});

describe("resolveProviderSkillSourceKind", () => {
  it("marks plugin-backed skills as app installs", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.codex/plugins/cache/openai-curated/github/skills/gh-fix-ci/SKILL.md",
        scope: "user",
      }),
    ).toBe("app");
  });

  it("maps standard scopes to source kinds", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "repo",
      }),
    ).toBe("repo");
    expect(
      resolveProviderSkillSourceKind({
        path: "/workspace/.codex/skills/review-follow-up/SKILL.md",
        scope: "project",
      }),
    ).toBe("project");
    expect(
      resolveProviderSkillSourceKind({
        path: "/Users/julius/.agents/skills/agent-browser/SKILL.md",
        scope: "user",
      }),
    ).toBe("personal");
    expect(
      resolveProviderSkillSourceKind({
        path: "/usr/local/share/codex/skills/imagegen/SKILL.md",
        scope: "system",
      }),
    ).toBe("system");
  });

  it("keeps unknown and missing scopes usable", () => {
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
        scope: "team_shared",
      }),
    ).toBe("other");
    expect(
      resolveProviderSkillSourceKind({
        path: "/opt/skills/team-review/SKILL.md",
      }),
    ).toBe("other");
  });
});

describe("workspace provider snapshots", () => {
  it("uses the cwd snapshot after a provider session has populated it", () => {
    expect(resolveProviderSkillsForCwd(provider, "/workspace/project-a")).toEqual([
      { name: "project", path: "/workspace/project-a/SKILL.md", enabled: true },
    ]);
    expect(resolveProviderSlashCommandsForCwd(provider, "/workspace/project-a")).toEqual([
      { name: "project" },
    ]);
  });

  it("keeps the machine snapshot before this cwd has a provider snapshot", () => {
    expect(resolveProviderSkillsForCwd(provider, "/workspace/project-b")).toEqual(provider.skills);
    expect(resolveProviderSlashCommandsForCwd(provider, null)).toEqual(provider.slashCommands);
  });
});
