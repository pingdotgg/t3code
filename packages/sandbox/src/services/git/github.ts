import { posix as path } from "node:path";
import { randomInt } from "node:crypto";
import * as Effect from "effect/Effect";

import { GitHubRepositoryParseError } from "./repo.errors";
import type { GitHubRepository } from "./repo.service";

const NATURE_ADJECTIVES = [
  "sunlit",
  "quiet",
  "mossy",
  "silver",
  "wild",
  "misty",
  "autumn",
  "windy",
  "golden",
  "amber",
  "cool",
  "soft",
] as const;

const NATURE_LANDSCAPES = [
  "cedar",
  "river",
  "meadow",
  "grove",
  "canyon",
  "forest",
  "harbor",
  "valley",
  "summit",
  "brook",
  "reef",
  "prairie",
] as const;

const NATURE_SKIES = [
  "dawn",
  "sparrow",
  "moon",
  "rain",
  "breeze",
  "stone",
  "pine",
  "trail",
  "wave",
  "thunder",
  "owl",
  "glow",
] as const;

function pickRandomWord(words: ReadonlyArray<string>): string {
  return words[randomInt(words.length)] ?? "meadow";
}

export function parseGitHubRepository(
  url: string,
): Effect.Effect<GitHubRepository, GitHubRepositoryParseError> {
  const httpsMatch = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/iu.exec(url);
  if (httpsMatch) {
    const owner = httpsMatch[1]?.trim();
    const repo = httpsMatch[2]?.trim();

    if (owner && repo) {
      return Effect.succeed({
        owner,
        repo,
      } satisfies GitHubRepository);
    }
  }

  const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/iu.exec(url);
  if (sshMatch) {
    const owner = sshMatch[1]?.trim();
    const repo = sshMatch[2]?.trim();

    if (owner && repo) {
      return Effect.succeed({
        owner,
        repo,
      } satisfies GitHubRepository);
    }
  }

  return Effect.fail(
    new GitHubRepositoryParseError({
      message:
        "Only github.com repository URLs are supported. Use https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git).",
    }),
  );
}

export function repositoryLabel(repository: GitHubRepository): string {
  return `${repository.owner}/${repository.repo}`;
}

export function sanitizeRepoSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function createRepoKey(repository: GitHubRepository): string {
  const owner = sanitizeRepoSegment(repository.owner);
  const repo = sanitizeRepoSegment(repository.repo);

  return [owner, repo].filter((segment) => segment.length > 0).join("-") || "repo";
}

export function createRepositoryStatePaths(repoKey: string) {
  const stateRoot = path.join("/workspace/.jevin/repos", repoKey);
  return {
    stateRoot,
    statePath: path.join(stateRoot, "state.json"),
    envRoot: path.join(stateRoot, "env"),
  };
}

export function sanitizeBranchPrefix(rawPrefix: string): string {
  return rawPrefix
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/g, "");
}

export function sanitizeWorktreeSuffix(rawName: string): string {
  return rawName
    .trim()
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
}

export function normalizeListedBranchName(branch: string): ReadonlyArray<string> {
  const trimmed = branch.trim();
  if (trimmed.length === 0 || trimmed.includes(" -> ")) {
    return [];
  }

  if (trimmed.startsWith("remotes/")) {
    const withoutRemotes = trimmed.slice("remotes/".length);
    return [trimmed, withoutRemotes];
  }

  if (trimmed.startsWith("origin/")) {
    const withoutOrigin = trimmed.slice("origin/".length);
    return [trimmed, withoutOrigin];
  }

  return [trimmed];
}

export function createBranchName(prefix: string, suffix: string): string {
  return `${prefix}/${suffix}`;
}

export function generateNatureCodename(): string {
  return [
    pickRandomWord(NATURE_ADJECTIVES),
    pickRandomWord(NATURE_LANDSCAPES),
    pickRandomWord(NATURE_SKIES),
  ].join("-");
}
