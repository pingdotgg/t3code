import { describe, expect, it, vi } from "vitest";

import type { EnvironmentApi, ServerLocalAgentInventory } from "@forma/contracts";

import { expandProjectLocalAgentsPrompt } from "./localAgentPrompting";

const makeApi = (files: Record<string, string>): EnvironmentApi =>
  ({
    terminal: {} as EnvironmentApi["terminal"],
    filesystem: {} as EnvironmentApi["filesystem"],
    sourceControl: {} as EnvironmentApi["sourceControl"],
    git: {} as EnvironmentApi["git"],
    orchestration: {} as EnvironmentApi["orchestration"],
    preview: {} as EnvironmentApi["preview"],
    projects: {
      listEntries: vi.fn(),
      getLocalAgentInventory: vi.fn(),
      searchEntries: vi.fn(),
      writeFile: vi.fn(),
      readFile: vi.fn(async ({ relativePath }) => ({
        relativePath,
        contents: files[relativePath] ?? "",
        version: "a".repeat(64),
      })),
    },
  }) satisfies EnvironmentApi;

describe("expandProjectLocalAgentsPrompt", () => {
  it("expands standalone local commands from markdown files", async () => {
    const api = makeApi({
      ".agents/commands/review-pr.md": `---
description: Review PR
---

Review pull request $1 with urgency $2.`,
    });
    const inventory: ServerLocalAgentInventory = {
      skills: [],
      commands: [
        {
          name: "review-pr",
          path: ".agents/commands/review-pr.md",
          scope: "project",
          source: "local-agents",
        },
      ],
    };

    await expect(
      expandProjectLocalAgentsPrompt({
        api,
        cwd: "/tmp/project",
        prompt: "/review-pr 123 urgent",
        inventory,
      }),
    ).resolves.toBe("Review pull request 123 with urgency urgent.");
  });

  it("injects local skill contents ahead of the remaining user request", async () => {
    const api = makeApi({
      ".agents/skills/repo-review/SKILL.md": `---
description: Review repository changes
---

# Repo Review

Look for risky diffs first.`,
    });
    const inventory: ServerLocalAgentInventory = {
      skills: [
        {
          name: "repo-review",
          path: ".agents/skills/repo-review/SKILL.md",
          scope: "project",
          enabled: true,
          source: "local-agents",
        },
      ],
      commands: [],
    };

    await expect(
      expandProjectLocalAgentsPrompt({
        api,
        cwd: "/tmp/project",
        prompt: "Please $repo-review inspect this patch",
        inventory,
      }),
    ).resolves.toContain("User request:\nPlease inspect this patch");
  });

  it("expands local skills after rendering a local command template", async () => {
    const api = makeApi({
      ".agents/commands/review.md": `Use $repo-review to analyze the active diff.`,
      ".agents/skills/repo-review/SKILL.md": `---
description: Review repository changes
---

Inspect risky diffs first.`,
    });
    const inventory: ServerLocalAgentInventory = {
      skills: [
        {
          name: "repo-review",
          path: ".agents/skills/repo-review/SKILL.md",
          scope: "project",
          enabled: true,
          source: "local-agents",
        },
      ],
      commands: [
        {
          name: "review",
          path: ".agents/commands/review.md",
          scope: "project",
          source: "local-agents",
        },
      ],
    };

    await expect(
      expandProjectLocalAgentsPrompt({
        api,
        cwd: "/tmp/project",
        prompt: "/review",
        inventory,
      }),
    ).resolves.toContain("project-local skill");
  });
});
