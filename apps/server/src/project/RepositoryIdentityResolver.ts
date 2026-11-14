import type { RepositoryIdentity, SourceControlProviderError } from "@t3tools/contracts";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";
import { repositoryPathFromRemoteUrl } from "@t3tools/source-control-core/server/SourceControlProvider";
import { normalizeGitRemoteUrl } from "@t3tools/shared/git";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";
import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { explicitBareRepositoryEnv, unsetInheritedRepositoryEnv } from "../vcs/VcsProcess.ts";
import * as HostProcess from "@t3tools/shared/HostProcess";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
// Minute-by-minute sweeps need cached hits; clone, publish and PR discovery force refresh.
const DEFAULT_POSITIVE_CACHE_TTL = Duration.minutes(15);
const DEFAULT_NEGATIVE_CACHE_TTL = Duration.minutes(1);

export interface RepositoryIdentityResolverOptions {
  readonly cacheCapacity?: number;
  readonly refine?: (
    identity: RepositoryIdentity,
  ) => Effect.Effect<RepositoryIdentity, SourceControlProviderError>;
}

export class RepositoryIdentityResolver extends Context.Service<
  RepositoryIdentityResolver,
  {
    readonly resolve: (
      cwd: string,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<RepositoryIdentity | null>;
  }
>()("t3/project/RepositoryIdentityResolver") {}

// Local paths such as GitButler's gb-local=. would give unrelated repos the same identity.
function isLocalRemoteUrl(url: string): boolean {
  if (/^file:/i.test(url)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false;
  if (/^[a-z]:[\\/]/i.test(url)) return true;
  // Git treats `host:path` as scp-style only when the colon precedes any slash.
  const colonIndex = url.indexOf(":");
  const slashIndex = url.search(/[\\/]/);
  return colonIndex === -1 || (slashIndex !== -1 && slashIndex < colonIndex);
}

function parseRemoteFetchUrls(stdout: string): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    // Git uses a tab before the URL and one space before the direction; both can occur in URLs.
    // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
    const match = /^(\S+)\t(.+) \((fetch|push)\)(?:\s+\[[^\]]+\])?$/.exec(line);
    if (!match) continue;
    const [, remoteName = "", remoteUrl = "", direction = ""] = match;
    if (
      direction !== "fetch" ||
      remoteName.length === 0 ||
      remoteUrl.length === 0 ||
      isLocalRemoteUrl(remoteUrl)
    ) {
      continue;
    }
    remotes.set(remoteName, remoteUrl);
  }
  return remotes;
}

// `gh repo set-default` marks one remote with `base`, or with OWNER/REPO when it picked a
// parent repository. gh reads PRs from that repository, so the identity follows the mark when
// a remote fetches it. The locator must name a real remote: review checkouts fetch through it.
function pickMarkedRemote(
  remotes: ReadonlyMap<string, string>,
  resolved: string,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  const marks = resolved.split("\n").flatMap((line) => {
    const match = /^remote\.(.+)\.gh-resolved\s+(\S+)$/u.exec(line.trim());
    const remoteUrl = match?.[1] === undefined ? undefined : remotes.get(match[1]);
    return match?.[1] && match[2] && remoteUrl
      ? [{ remoteName: match[1], remoteUrl, value: match[2] }]
      : [];
  });
  // gh's choice is ambiguous with several marks; GitHubSourceControlProvider ignores them too.
  const [mark, ...others] = marks;
  if (!mark || others.length > 0) return null;
  if (mark.value === "base") return { remoteName: mark.remoteName, remoteUrl: mark.remoteUrl };
  // Compare hosts with HTTP ports kept: one hostname can serve separate forges on two ports.
  const host = parseGitRemoteHost(mark.remoteUrl)?.host;
  const markedPath = mark.value.toLowerCase();
  const [remoteName, remoteUrl] =
    [...remotes.entries()].find(
      ([, url]) =>
        parseGitRemoteHost(url)?.host === host &&
        normalizeGitRemoteUrl(url).split("/").slice(1).join("/") === markedPath,
    ) ?? [];
  return remoteName && remoteUrl ? { remoteName, remoteUrl } : null;
}

function pickPrimaryRemote(
  remotes: ReadonlyMap<string, string>,
  resolved: string,
): { readonly remoteName: string; readonly remoteUrl: string } | null {
  const marked = pickMarkedRemote(remotes, resolved);
  if (marked) return marked;

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

function repositoryPathOf(canonicalKey: string, remoteUrl: string): string {
  const canonicalPath = canonicalKey.split("/").slice(1).join("/");
  const displayPath = repositoryPathFromRemoteUrl(remoteUrl);
  if (displayPath === null) return canonicalPath;
  // A host that names repositories literally keeps the `.git` the display path drops.
  return (
    [displayPath, `${displayPath}.git`].find((path) => path.toLowerCase() === canonicalPath) ??
    canonicalPath
  );
}

function buildRepositoryOrigin(
  originUrl: string | undefined,
  canonicalKey: string,
): RepositoryIdentity["origin"] {
  if (!originUrl) return undefined;
  const originKey = sourceControlDefinitions.repositoryKeyFromRemote(originUrl);
  if (originKey === canonicalKey) return undefined;
  const displayName = repositoryPathOf(originKey, originUrl);
  return { canonicalKey: originKey, remoteUrl: originUrl, ...(displayName ? { displayName } : {}) };
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly originUrl: string | undefined;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = sourceControlDefinitions.repositoryKeyFromRemote(input.remoteUrl);
  const sourceControlProvider = sourceControlDefinitions.recognizeRemote(input.remoteUrl);
  const repositoryPath = repositoryPathOf(canonicalKey, input.remoteUrl);
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);
  const origin = buildRepositoryOrigin(input.originUrl, canonicalKey);

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
    ...(origin ? { origin } : {}),
  };
}

class RepositoryIdentityCacheKey extends Data.Class<{
  readonly rootPath: string;
  readonly isBare: boolean;
}> {}

const gitEnv = (platform: NodeJS.Platform): NodeJS.ProcessEnv => ({
  ...unsetInheritedRepositoryEnv(process.env, platform),
  ...explicitBareRepositoryEnv(process.env, platform),
});

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const env = gitEnv(yield* HostProcess.Platform);

    // `git -C` cannot enter a missing folder or a file, so every probe below would fail.
    const isFolder = yield* fileSystem.stat(cwd).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
      Effect.orElseSucceed(() => true),
    );
    if (!isFolder) return null;

    // git is always a real executable; cmd shell mode would split spaced paths on re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-toplevel"],
        env,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "None" || topLevelResult.value.timedOut) {
      return null;
    }
    if (topLevelResult.value.code === 0) {
      // Paths may end in spaces, so strip only git's line terminator.
      const rootPath = topLevelResult.value.stdout.replace(/\r?\n$/, "");
      return rootPath.length > 0
        ? new RepositoryIdentityCacheKey({ rootPath, isBare: false })
        : null;
    }

    // Explicit Git directories preserve safe.bareRepository=explicit for both layouts.
    for (const [gitDir, entry] of [
      [".", "HEAD"],
      [".git", ".git"],
    ] as const) {
      // An explicit --git-dir fails unless the folder has this entry; a symlink counts even
      // when its target is missing, as git reads a symlinked HEAD's target text.
      const target = path.join(cwd, entry);
      const hasEntry = yield* fileSystem.exists(target).pipe(
        Effect.flatMap((exists) =>
          exists
            ? Effect.succeed(true)
            : fileSystem.readLink(target).pipe(
                Effect.as(true),
                Effect.orElseSucceed(() => false),
              ),
        ),
        Effect.orElseSucceed(() => true),
      );
      if (!hasEntry) continue;
      const bareResult = yield* processRunner
        .run({
          command: "git",
          args: [
            "-C",
            cwd,
            `--git-dir=${gitDir}`,
            "rev-parse",
            "--is-bare-repository",
            "--absolute-git-dir",
          ],
          env,
          timeoutBehavior: "timedOutResult",
        })
        .pipe(Effect.option);
      if (bareResult._tag === "None" || bareResult.value.timedOut) return null;
      if (bareResult.value.code !== 0) continue;

      const [isBare, rootPath = ""] = bareResult.value.stdout.split(/\r?\n/);
      // A checkout's .git directory contains remotes but is not a project root.
      return isBare === "true" && rootPath.length > 0
        ? new RepositoryIdentityCacheKey({ rootPath, isBare: true })
        : null;
    }
    return null;
  },
);

const resolveRepositoryIdentityFromCacheKey = Effect.fn(
  "RepositoryIdentityResolver.resolveFromCacheKey",
)(function* (
  cacheKey: RepositoryIdentityCacheKey,
): Effect.fn.Return<RepositoryIdentity | null, never, ProcessRunner.ProcessRunner> {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const env = gitEnv(yield* HostProcess.Platform);
  const runGit = (args: ReadonlyArray<string>) =>
    processRunner
      .run({
        command: "git",
        args: ["-C", cacheKey.rootPath, ...(cacheKey.isBare ? ["--git-dir=."] : []), ...args],
        env,
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
  const [remoteResult, resolvedResult] = yield* Effect.all(
    [runGit(["remote", "-v"]), runGit(["config", "--get-regexp", "^remote\\..*\\.gh-resolved$"])],
    { concurrency: "unbounded" },
  );
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  const remotes = parseRemoteFetchUrls(remoteResult.value.stdout);
  // Exits 1 when no remote has a mark.
  const resolved =
    resolvedResult._tag === "Some" && resolvedResult.value.code === 0
      ? resolvedResult.value.stdout
      : "";
  const remote = pickPrimaryRemote(remotes, resolved);
  return remote
    ? buildRepositoryIdentity({
        ...remote,
        originUrl: remotes.get("origin"),
        rootPath: cacheKey.rootPath,
      })
    : null;
});

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cacheCapacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;
  const refine = options.refine ?? Effect.succeed;
  const timeToLive = (exit: Exit.Exit<unknown>) =>
    Exit.match(exit, {
      onSuccess: (value) =>
        value === null ? DEFAULT_NEGATIVE_CACHE_TTL : DEFAULT_POSITIVE_CACHE_TTL,
      onFailure: () => Duration.zero,
    });

  const repositoryRootCache = yield* Cache.makeWith<string, RepositoryIdentityCacheKey | null>(
    (cwd) =>
      resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const repositoryIdentityCache = yield* Cache.makeWith<
    RepositoryIdentityCacheKey,
    RepositoryIdentity | null
  >(
    (cacheKey) =>
      resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
        Effect.filterOrElse(
          (identity): identity is null => identity === null,
          (identity) => refine(identity).pipe(Effect.orElseSucceed(() => identity)),
        ),
      ),
    { capacity: cacheCapacity, timeToLive },
  );

  const resolve: RepositoryIdentityResolver["Service"]["resolve"] = Effect.fnUntraced(
    function* (cwd, options) {
      if (options?.refresh) yield* Cache.invalidate(repositoryRootCache, cwd);
      const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
      if (cacheKey === null) return null;
      if (options?.refresh) yield* Cache.invalidate(repositoryIdentityCache, cacheKey);
      return yield* Cache.get(repositoryIdentityCache, cacheKey);
    },
  );

  return RepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
