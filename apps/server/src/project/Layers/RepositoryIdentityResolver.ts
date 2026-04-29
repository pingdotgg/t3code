import type { ExecutionTarget, RepositoryIdentity } from "@t3tools/contracts";
import { Cache, Duration, Effect, Exit, Layer } from "effect";
import { detectGitHostingProviderFromRemoteUrl, normalizeGitRemoteUrl } from "@t3tools/shared/git";

import { runProcess } from "../../processRunner.ts";
import { buildWslExecArgs } from "../../wsl/WslCli.ts";
import { isWslTarget } from "../../wsl/WslTarget.ts";
import {
  RepositoryIdentityResolver,
  type RepositoryIdentityResolveInput,
  type RepositoryIdentityResolverShape,
} from "../Services/RepositoryIdentityResolver.ts";

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(trimmed);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (direction !== "fetch" || remoteName.length === 0 || remoteUrl.length === 0) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  for (const preferredRemoteName of ["upstream", "origin"] as const) {
    const remoteUrl = remotes.get(preferredRemoteName);
    if (remoteUrl) {
      return { remoteName: preferredRemoteName, remoteUrl };
    }
  }

  const [remoteName, remoteUrl] =
    [...remotes.entries()].toSorted(([left], [right]) => left.localeCompare(right))[0] ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = normalizeGitRemoteUrl(input.remoteUrl);
  const hostingProvider = detectGitHostingProviderFromRemoteUrl(input.remoteUrl);
  const repositoryPath = canonicalKey.split("/").slice(1).join("/");
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);

  return {
    canonicalKey,
    locator: {
      source: "git-remote",
      remoteName: input.remoteName,
      remoteUrl: input.remoteUrl,
    },
    rootPath: input.rootPath,
    ...(repositoryPath ? { displayName: repositoryPath } : {}),
    ...(hostingProvider ? { provider: hostingProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
  readonly runGit?: (
    input: RepositoryIdentityResolveInput,
    args: ReadonlyArray<string>,
  ) => Promise<{ readonly code: number | null; readonly stdout: string }>;
}

function normalizeResolveInput(input: string | RepositoryIdentityResolveInput) {
  return typeof input === "string" ? { cwd: input } : input;
}

function cacheKeyFor(input: RepositoryIdentityResolveInput, rootPath: string): string {
  return JSON.stringify({
    cwd: rootPath,
    executionTarget: input.executionTarget ?? { kind: "local" },
  });
}

async function runGit(
  input: RepositoryIdentityResolveInput,
  args: ReadonlyArray<string>,
): Promise<{ readonly code: number | null; readonly stdout: string }> {
  if (isWslTarget(input.executionTarget)) {
    return runProcess("wsl.exe", buildWslExecArgs(input.executionTarget, input.cwd, "git", args), {
      allowNonZeroExit: true,
      shell: false,
    });
  }

  return runProcess("git", ["-C", input.cwd, ...args], {
    allowNonZeroExit: true,
    shell: false,
  });
}

async function resolveRepositoryIdentityCacheKey(
  input: RepositoryIdentityResolveInput,
  runGitCommand: NonNullable<RepositoryIdentityResolverOptions["runGit"]>,
): Promise<string> {
  let rootPath = input.cwd;

  try {
    const topLevelResult = await runGitCommand(input, ["rev-parse", "--show-toplevel"]);
    if (topLevelResult.code !== 0) {
      return cacheKeyFor(input, rootPath);
    }

    const candidate = topLevelResult.stdout.trim();
    if (candidate.length > 0) {
      rootPath = candidate;
    }
  } catch {
    return cacheKeyFor(input, rootPath);
  }

  return cacheKeyFor(input, rootPath);
}

async function resolveRepositoryIdentityFromCacheKey(
  cacheKey: string,
  runGitCommand: NonNullable<RepositoryIdentityResolverOptions["runGit"]>,
): Promise<RepositoryIdentity | null> {
  try {
    const parsed = JSON.parse(cacheKey) as {
      readonly cwd: string;
      readonly executionTarget?: ExecutionTarget | undefined;
    };
    const rootPath = parsed.cwd;
    const executionTarget =
      parsed.executionTarget?.kind === "wsl" ? parsed.executionTarget : undefined;
    const remoteResult = await runGitCommand({ cwd: rootPath, executionTarget }, ["remote", "-v"]);
    if (remoteResult.code !== 0) {
      return null;
    }

    const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.stdout));
    return remote ? buildRepositoryIdentity({ ...remote, rootPath }) : null;
  } catch {
    return null;
  }
}

export const makeRepositoryIdentityResolver = Effect.fn("makeRepositoryIdentityResolver")(
  function* (options: RepositoryIdentityResolverOptions = {}) {
    const runGitCommand = options.runGit ?? runGit;
    const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
      (cacheKey) =>
        Effect.promise(() => resolveRepositoryIdentityFromCacheKey(cacheKey, runGitCommand)),
      {
        capacity: options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY,
        timeToLive: Exit.match({
          onSuccess: (value) =>
            value === null
              ? (options.negativeCacheTtl ?? DEFAULT_NEGATIVE_CACHE_TTL)
              : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
          onFailure: () => Duration.zero,
        }),
      },
    );

    const resolve: RepositoryIdentityResolverShape["resolve"] = Effect.fn(
      "RepositoryIdentityResolver.resolve",
    )(function* (rawInput) {
      const input = normalizeResolveInput(rawInput);
      const cacheKey = yield* Effect.promise(() =>
        resolveRepositoryIdentityCacheKey(input, runGitCommand),
      );
      return yield* Cache.get(repositoryIdentityCache, cacheKey);
    });

    return {
      resolve,
    } satisfies RepositoryIdentityResolverShape;
  },
);

export const RepositoryIdentityResolverLive = Layer.effect(
  RepositoryIdentityResolver,
  makeRepositoryIdentityResolver(),
);
