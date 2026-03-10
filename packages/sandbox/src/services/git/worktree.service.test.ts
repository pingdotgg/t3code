import { describe, expect, test } from "bun:test";

import { createBootstrapCommandPlan, createWorktreeDefaultPath } from "./worktree.service";

describe("createWorktreeDefaultPath", () => {
  test("uses the repo key namespace for managed worktrees", () => {
    expect(createWorktreeDefaultPath("openai-jevin", "soft-meadow-dawn")).toBe(
      "/workspace/worktrees/openai-jevin/soft-meadow-dawn",
    );
  });
});

describe("createBootstrapCommandPlan", () => {
  test("copies env files before running setup commands", () => {
    const plan = createBootstrapCommandPlan(
      [
        {
          sourcePath: "/workspace/.jevin/repos/openai-jevin/env/.env.local",
          targetPath: "/workspace/worktrees/openai-jevin/soft-meadow-dawn/.env.local",
        },
      ],
      ["bun install --frozen-lockfile", "bun test"],
    );

    expect(plan).toEqual([
      "mkdir -p '/workspace/worktrees/openai-jevin/soft-meadow-dawn' && cp '/workspace/.jevin/repos/openai-jevin/env/.env.local' '/workspace/worktrees/openai-jevin/soft-meadow-dawn/.env.local'",
      "bun install --frozen-lockfile",
      "bun test",
    ]);
  });
});
