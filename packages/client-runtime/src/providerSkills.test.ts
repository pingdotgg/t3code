import {
  PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { describe, expect, it } from "vite-plus/test";

import {
  dedupeProviderSkillsByPath,
  formatProviderSkillMenuDescription,
  formatProviderSkillMention,
  getProviderSlashCommandsForSlashMenu,
  getProviderSkillsForSlashMenu,
  hasCompleteProviderWorkspaceSnapshot,
  hasCurrentProviderWorkspaceSnapshot,
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

const personalReview = {
  name: "code-review",
  path: "/Users/matt/.agents/skills/code-review/SKILL.md",
  scope: "user",
  enabled: true,
  shortDescription: "Standards and spec review",
};
const pluginReview = {
  name: "code-review",
  path: "/Users/matt/.codex/plugins/cache/review/skills/code-review/SKILL.md",
  enabled: true,
};
const browser = {
  name: "browser",
  path: "/Users/matt/.agents/skills/browser/SKILL.md",
  enabled: true,
};

describe("dedupeProviderSkillsByPath", () => {
  it("keeps same-name skills from different files and drops repeats of one file", () => {
    const repeated = { ...personalReview, path: personalReview.path.replaceAll("/", "\\") };
    expect(dedupeProviderSkillsByPath([personalReview, browser, pluginReview, repeated])).toEqual([
      personalReview,
      browser,
      pluginReview,
    ]);
  });
});

describe("formatProviderSkillMention", () => {
  it("keeps the plain mention when the name is unique", () => {
    expect(formatProviderSkillMention(browser, [personalReview, browser])).toBe("$browser");
  });

  it("links the mention to the picked file when another skill shares the name", () => {
    const skills = [personalReview, pluginReview, browser];
    expect(formatProviderSkillMention(personalReview, skills)).toBe(
      `[$code-review](${personalReview.path})`,
    );
    expect(formatProviderSkillMention(pluginReview, skills)).toBe(
      `[$code-review](${pluginReview.path})`,
    );
  });

  it("links any SKILL.md path, encoding what Markdown cannot hold", () => {
    const parenthesized = { ...personalReview, path: "/Users/matt/skills (old)/review/SKILL.md" };
    expect(formatProviderSkillMention(parenthesized, [parenthesized, pluginReview])).toBe(
      "[$code-review](/Users/matt/skills%20%28old%29/review/SKILL.md)",
    );
  });

  it("refuses a shared name when the skill has no SKILL.md to link", () => {
    const synthetic = { ...personalReview, path: "pi:skill:code-review" };
    const skills = [synthetic, pluginReview];
    expect(formatProviderSkillMention(synthetic, skills)).toBeNull();
    expect(formatProviderSkillMenuDescription(synthetic, skills)).toContain("Can't be picked");
  });

  it("ignores a same-name skill that cannot be picked", () => {
    expect(
      formatProviderSkillMention(personalReview, [
        personalReview,
        { ...pluginReview, enabled: false },
      ]),
    ).toBe("$code-review");
  });
});

describe("formatProviderSkillMenuDescription", () => {
  it("leads with the file path only when the name alone is ambiguous", () => {
    expect(formatProviderSkillMenuDescription(personalReview, [personalReview, browser])).toBe(
      "Standards and spec review",
    );
    expect(formatProviderSkillMenuDescription(personalReview, [personalReview, pluginReview])).toBe(
      `${personalReview.path} · Standards and spec review`,
    );
    expect(formatProviderSkillMenuDescription(pluginReview, [personalReview, pluginReview])).toBe(
      pluginReview.path,
    );
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

  it("shows a row per file when enabled skills share a name", () => {
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

    expect(getProviderSkillsForSlashMenu(skills, true).map((skill) => skill.path)).toEqual([
      "/Users/matt/.codex/skills/babysit-pr/SKILL.md",
      "/Users/matt/.agents/skills/browser/SKILL.md",
      "/Users/matt/.agents/skills/babysit-pr/SKILL.md",
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

  it("uses partial workspace skills and commands while keeping discovery retryable", () => {
    const partial = {
      ...provider,
      workspaceSnapshots: provider.workspaceSnapshots.map((snapshot) => ({
        ...snapshot,
        slashCommands: [{ name: "compact" }],
        slashCommandsPending: true,
      })),
    } satisfies ServerProvider;
    expect(resolveProviderSkillsForCwd(partial, "/workspace/project-a")).toEqual(
      provider.workspaceSnapshots[0]?.skills,
    );
    expect(resolveProviderSlashCommandsForCwd(partial, "/workspace/project-a")).toEqual([
      { name: "compact" },
    ]);
    expect(hasCompleteProviderWorkspaceSnapshot(partial, "/workspace/project-a")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, "/workspace/project-a")).toBe(true);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, "/workspace/project-b")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(undefined, "/workspace/project-a")).toBe(false);
    expect(hasCompleteProviderWorkspaceSnapshot(provider, null)).toBe(false);
  });

  it("asks for a rescan once the workspace snapshot outlives its TTL", () => {
    const scannedAt = Date.parse("2026-01-01T00:01:00.000Z");
    const cwd = "/workspace/project-a";
    expect(hasCurrentProviderWorkspaceSnapshot(provider, cwd, scannedAt)).toBe(true);
    expect(
      hasCurrentProviderWorkspaceSnapshot(
        provider,
        cwd,
        scannedAt + PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS - 1,
      ),
    ).toBe(true);
    expect(
      hasCurrentProviderWorkspaceSnapshot(
        provider,
        cwd,
        scannedAt + PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS,
      ),
    ).toBe(false);
    expect(hasCurrentProviderWorkspaceSnapshot(provider, "/workspace/project-b", scannedAt)).toBe(
      false,
    );
  });
});
