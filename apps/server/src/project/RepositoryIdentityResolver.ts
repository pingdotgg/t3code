// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { RepositoryIdentity } from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";

import * as ProcessRunner from "../processRunner.ts";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
const DEFAULT_REPOSITORY_IDENTITY_CONCURRENCY = 8;
const DEFAULT_REPOSITORY_IDENTITY_PROCESS_TIMEOUT = "2 seconds";
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(1);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly positiveCacheTtl?: Duration.Input;
  readonly negativeCacheTtl?: Duration.Input;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (cwd: string) => Effect.Effect<RepositoryIdentity | null>;
  }
>()("t3/project/RepositoryIdentityResolver") {}

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
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(input.remoteUrl);
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
    ...(sourceControlProvider ? { provider: sourceControlProvider.kind } : {}),
    ...(owner ? { owner } : {}),
    ...(repositoryName ? { name: repositoryName } : {}),
  };
}

const readOptionalTextFile = (path: string): Promise<string | null> =>
  NodeFSP.readFile(path, "utf8").catch(() => null);

const isDirectory = (path: string): Promise<boolean> =>
  NodeFSP.stat(path).then(
    (entry) => entry.isDirectory(),
    () => false,
  );

const isFile = (path: string): Promise<boolean> =>
  NodeFSP.stat(path).then(
    (entry) => entry.isFile(),
    () => false,
  );

const canonicalDirectoryPath = (path: string): Promise<string> =>
  NodeFSP.realpath(path).catch(() => path);

async function repositoryRootFromGitDir(
  rootPath: string,
  gitDirPath: string,
): Promise<string | null> {
  if (!(await isFile(NodePath.join(gitDirPath, "HEAD")))) {
    return null;
  }
  return canonicalDirectoryPath(rootPath);
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  let currentPath = NodePath.resolve(cwd);
  if (!(await isDirectory(currentPath))) {
    return null;
  }
  currentPath = await canonicalDirectoryPath(currentPath);

  // Bare repositories keep HEAD and config at their root instead of using a
  // .git entry. Projects rarely point at one, but retaining support costs only
  // two file stats and avoids changing the previous Git-based behavior.
  if (
    (await isFile(NodePath.join(currentPath, "HEAD"))) &&
    (await isFile(NodePath.join(currentPath, "config"))) &&
    (await isDirectory(NodePath.join(currentPath, "objects"))) &&
    (await isDirectory(NodePath.join(currentPath, "refs")))
  ) {
    return canonicalDirectoryPath(currentPath);
  }

  for (;;) {
    const dotGitPath = NodePath.join(currentPath, ".git");
    if (await isDirectory(dotGitPath)) {
      // Git stops discovery at a .git entry even when it is malformed. Match
      // that behavior and, importantly, do not spawn two doomed Git processes
      // for every project nested below an empty or stale .git directory.
      return repositoryRootFromGitDir(currentPath, dotGitPath);
    }

    if (await isFile(dotGitPath)) {
      const gitFile = await readOptionalTextFile(dotGitPath);
      const gitDir = /^gitdir:\s*(.+)$/im.exec(gitFile ?? "")?.[1]?.trim();
      if (!gitDir) {
        return null;
      }
      return repositoryRootFromGitDir(currentPath, NodePath.resolve(currentPath, gitDir));
    }

    const parentPath = NodePath.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
}

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* (
  cacheKey: string,
): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const remoteResult = yield* processRunner
    .run({
      command: "git",
      args: ["-C", cacheKey, "remote", "-v"],
      timeout: DEFAULT_REPOSITORY_IDENTITY_PROCESS_TIMEOUT,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.value.stdout));
  return remote ? buildRepositoryIdentity({ ...remote, rootPath: cacheKey }) : null;
});

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const resolutionSemaphore = yield* Semaphore.make(DEFAULT_REPOSITORY_IDENTITY_CONCURRENCY);

  const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cacheKey) =>
      resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
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

  // Cache the complete cwd lookup before resolving the canonical repository
  // identity. Walking .git metadata is dramatically cheaper than launching
  // Git for every stored project, especially during Windows reconnects where
  // a large project history can otherwise create hundreds of child processes.
  const repositoryIdentityByCwdCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cwd) =>
      resolutionSemaphore.withPermits(1)(
        Effect.promise(() => findRepositoryRoot(cwd)).pipe(
          Effect.flatMap((rootPath) =>
            rootPath === null ? Effect.succeed(null) : Cache.get(repositoryIdentityCache, rootPath),
          ),
        ),
      ),
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

  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fn(
    "RepositoryIdentityResolver.resolve",
  )(function* (cwd) {
    return yield* Cache.get(repositoryIdentityByCwdCache, cwd);
  });

  return RepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
