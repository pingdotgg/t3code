import type { RepositoryIdentity, SourceControlProviderError } from "@t3tools/contracts";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";
import { repositoryPathFromRemoteUrl } from "@t3tools/source-control-core/server/SourceControlProvider";
import { withoutRemoteUrlCredentials } from "@t3tools/shared/cloneUrl";
import { canonicalRepositoryPath, normalizeGitRemoteUrl } from "@t3tools/shared/git";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
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

// `git remote -v` applies url.*.insteadOf, which can point a GitHub remote at a proxy or mirror.
// A configured URL that names a forge wins; a shorthand like `gh:` is known only once rewritten.
function parseConfiguredRemoteUrls(config: string): Map<string, string> {
  const urls = new Map<string, string>();
  for (const line of config.split("\n")) {
    const match = /^remote\.([^ ]+)\.url (.+)$/u.exec(line);
    // Git fetches from the first of several configured URLs.
    if (match?.[1] && match[2] && !urls.has(match[1])) urls.set(match[1], match[2]);
  }
  return urls;
}

function parseRemoteFetchUrls(
  stdout: string,
  configuredUrls: ReadonlyMap<string, string>,
): Map<string, string> {
  const remotes = new Map<string, string>();
  for (const line of stdout.split(/\r?\n/)) {
    // Git uses a tab before the URL and one space before the direction; both can occur in URLs.
    // Partial clones append the promisor filter, e.g. `(fetch) [blob:none]`.
    const match = /^([^\t]+)\t(.+) \((fetch|push)\)(?:\s+\[[^\]]+\])?$/.exec(line);
    if (!match) continue;
    const [, remoteName = "", fetchUrl = "", direction = ""] = match;
    const configuredUrl = configuredUrls.get(remoteName);
    const remoteUrl =
      configuredUrl !== undefined &&
      (sourceControlDefinitions.recognizeRemote(configuredUrl)?.kind ?? "unknown") !== "unknown"
        ? configuredUrl
        : fetchUrl;
    if (
      direction !== "fetch" ||
      remoteName.length === 0 ||
      remoteUrl.length === 0 ||
      isLocalRemoteUrl(remoteUrl)
    ) {
      continue;
    }
    // The identity names the remote, not the login used to reach it.
    remotes.set(remoteName, withoutRemoteUrlCredentials(remoteUrl));
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
    [displayPath, `${displayPath}.git`].find(
      (path) => canonicalRepositoryPath(path) === canonicalRepositoryPath(canonicalPath),
    ) ?? canonicalPath
  );
}

// A leading `-` on the user or host would be read by ssh as an option.
const SSH_REMOTE = /^((?:ssh:\/\/)?)((?:[^-@/:][^@/:]*@)?)([A-Za-z0-9][A-Za-z0-9._-]*)([:/].*)$/su;
const SSH_HOST_NAME = /^[a-z0-9][a-z0-9.-]*$/u;
const IPV4 = /^[\d.]+$/u;

// Keys an SSH remote by the host its ssh config alias (`Host github.com-personal`) points at.
// A dotted host may be a forge whose SSH endpoint has another name, so only a public forge
// replaces it. `ssh -G` prints the configuration it would use and opens no connection.
const sshResolvedRemoteUrl = Effect.fn("RepositoryIdentityResolver.sshResolvedRemoteUrl")(
  function* (remoteUrl: string) {
    const match = isSshRemoteUrl(remoteUrl) ? SSH_REMOTE.exec(remoteUrl.trim()) : null;
    if (!match) return remoteUrl;
    const [, scheme = "", user = "", host = "", rest = ""] = match;
    if (sourceControlDefinitions.findByPublicHost(host)) return remoteUrl;
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const result = yield* processRunner
      .run({
        command: "ssh",
        args: ["-G", `${user}${host}`],
        timeout: Duration.seconds(5),
        maxOutputBytes: 64_000,
        outputMode: "truncate",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (result._tag === "None" || result.value.code !== 0) return remoteUrl;
    const hostName = result.value.stdout
      .split("\n")
      .find((line) => line.startsWith("hostname "))
      ?.slice("hostname ".length)
      .trim()
      .toLowerCase();
    if (
      hostName === undefined ||
      !SSH_HOST_NAME.test(hostName) ||
      IPV4.test(hostName) ||
      hostName === host.toLowerCase() ||
      (host.includes(".") && !sourceControlDefinitions.findByPublicHost(hostName))
    ) {
      return remoteUrl;
    }
    return `${scheme}${user}${hostName}${rest}`;
  },
);

function buildRepositoryOrigin(
  originUrl: string | undefined,
  originKeyUrl: string | undefined,
  canonicalKey: string,
): RepositoryIdentity["origin"] {
  if (!originUrl) return undefined;
  const originKey = sourceControlDefinitions.repositoryKeyFromRemote(originKeyUrl ?? originUrl);
  if (originKey === canonicalKey) return undefined;
  const displayName = repositoryPathOf(originKey, originUrl);
  return { canonicalKey: originKey, remoteUrl: originUrl, ...(displayName ? { displayName } : {}) };
}

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly keyUrl: string;
  readonly originUrl: string | undefined;
  readonly originKeyUrl: string | undefined;
  readonly rootPath: string;
}): RepositoryIdentity {
  const canonicalKey = sourceControlDefinitions.repositoryKeyFromRemote(input.keyUrl);
  const sourceControlProvider = sourceControlDefinitions.recognizeRemote(input.remoteUrl);
  const repositoryPath = repositoryPathOf(canonicalKey, input.remoteUrl);
  const repositoryPathSegments = repositoryPath.split("/").filter((segment) => segment.length > 0);
  const [owner] = repositoryPathSegments;
  const repositoryName = repositoryPathSegments.at(-1);
  const origin = buildRepositoryOrigin(input.originUrl, input.originKeyUrl, canonicalKey);

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
      // Git appends LF on every platform; a preceding CR belongs to the path.
      const rootPath = topLevelResult.value.stdout.replace(/\n$/, "");
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

      const [isBare, ...rootLines] = bareResult.value.stdout.split("\n");
      const rootPath = rootLines.join("\n").replace(/\n$/, "");
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
  const [remoteResult, configResult] = yield* Effect.all(
    [
      runGit(["remote", "-v"]),
      runGit(["config", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"]),
    ],
    { concurrency: "unbounded" },
  );
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  // Exits 1 when no key matches.
  const resolved =
    configResult._tag === "Some" && configResult.value.code === 0 ? configResult.value.stdout : "";
  const remotes = parseRemoteFetchUrls(
    remoteResult.value.stdout,
    parseConfiguredRemoteUrls(resolved),
  );
  const remote = pickPrimaryRemote(remotes, resolved);
  if (!remote) return null;
  const originUrl = remotes.get("origin");
  const keyUrl = yield* sshResolvedRemoteUrl(remote.remoteUrl);
  const originKeyUrl =
    originUrl === undefined || originUrl === remote.remoteUrl
      ? keyUrl
      : yield* sshResolvedRemoteUrl(originUrl);
  return buildRepositoryIdentity({
    ...remote,
    keyUrl,
    originUrl,
    originKeyUrl,
    rootPath: cacheKey.rootPath,
  });
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
