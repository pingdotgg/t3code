import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";

import { createRepoKey } from "./github";
import { normalizeEnvFilePath, normalizeRepositorySetup } from "./repo.helpers";
import { createRepositorySyncCommands } from "./repo.service";

describe("normalizeEnvFilePath", () => {
  test("normalizes repo-relative env paths", () => {
    expect(normalizeEnvFilePath("./config/.env.local")).toBe("config/.env.local");
  });

  test("rejects absolute env paths", () => {
    expect(normalizeEnvFilePath("/tmp/.env")).toBeUndefined();
  });

  test("rejects parent traversal", () => {
    expect(normalizeEnvFilePath("../.env")).toBeUndefined();
    expect(normalizeEnvFilePath("config/../../.env")).toBeUndefined();
  });
});

describe("normalizeRepositorySetup", () => {
  test("trims setup commands and preserves env content", async () => {
    const result = await Effect.runPromise(
      normalizeRepositorySetup({
        setupCommands: [" bun install ", "bun test"],
        envFiles: [{ path: "./.env.local", content: "FOO=bar\n" }],
      }),
    );

    expect(result).toEqual({
      setupCommands: ["bun install", "bun test"],
      envFiles: [{ path: ".env.local", content: "FOO=bar\n" }],
    });
  });

  test("rejects duplicate env paths after normalization", async () => {
    await expect(
      Effect.runPromise(
        normalizeRepositorySetup({
          setupCommands: [],
          envFiles: [
            { path: ".env.local", content: "A=1\n" },
            { path: "./.env.local", content: "B=2\n" },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      message: 'Env file path ".env.local" was provided more than once.',
    });
  });

  test("rejects blank setup commands", async () => {
    await expect(
      Effect.runPromise(
        normalizeRepositorySetup({
          setupCommands: ["   "],
          envFiles: [],
        }),
      ),
    ).rejects.toMatchObject({
      message: "Setup commands must not be empty.",
    });
  });
});

describe("repo key and sync commands", () => {
  test("creates a stable sanitized repo key", () => {
    expect(
      createRepoKey({
        owner: "OpenAI Labs",
        repo: "Jevin_AI",
      }),
    ).toBe("openai-labs-jevin-ai");
  });

  test("returns the anti-drift sync command sequence in order", () => {
    expect(createRepositorySyncCommands("main")).toEqual([
      `git fetch origin --prune`,
      `git worktree prune`,
      `git checkout 'main'`,
      `git reset --hard 'origin/main'`,
      "git clean -ffd",
    ]);
  });
});
