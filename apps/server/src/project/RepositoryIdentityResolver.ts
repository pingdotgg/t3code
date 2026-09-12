import type { RepositoryIdentity } from "@t3tools/contracts";
import {
  detectSourceControlProviderFromGitRemoteUrl,
  normalizeGitRemoteUrl,
} from "@t3tools/shared/git";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as ProcessRunner from "../processRunner.ts";

const DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY = 512;
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
    readonly resolve: (
      cwd: string,
      options?: { readonly refresh?: boolean },
    ) => Effect.Effect<RepositoryIdentity | null>;
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

function parseSshRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!isSshRemoteUrl(trimmed)) return null;

  if (trimmed.toLowerCase().startsWith("ssh://")) {
    try {
      const host = new URL(trimmed).hostname.trim();
      return host.length > 0 ? host : null;
    } catch {
      return null;
    }
  }

  const match = /^[^@/\s]+@([^:/\s]+):/u.exec(trimmed);
  const host = match?.[1]?.trim() ?? "";
  return host.length > 0 ? host : null;
}

function parseSshResolvedHostName(stdout: string, fallback: string): string {
  for (const line of stdout.split(/\r?\n/u)) {
    const [key, ...rest] = line.trim().split(/\s+/u);
    const hostname = rest.join(" ").trim();
    if (key?.toLowerCase() === "hostname" && hostname.length > 0) {
      return hostname;
    }
  }
  return fallback;
}

const resolveRepositoryRemoteHost = Effect.fn("RepositoryIdentityResolver.resolveRemoteHost")(
  function* (remoteUrl: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;
    const host = parseSshRemoteHost(remoteUrl);
    if (host === null) return undefined;

    const resolved = yield* processRunner
      .run({
        command: "ssh",
        args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-G", "--", host],
        timeout: Duration.seconds(5),
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (resolved._tag === "None" || resolved.value.code !== 0 || resolved.value.timedOut) {
      return undefined;
    }
    const resolvedHost = parseSshResolvedHostName(resolved.value.stdout, host);
    // GitHub's SSH-over-443 endpoint is a transport host, not its API host.
    const repositoryHost =
      resolvedHost.toLowerCase() === "ssh.github.com" ? "github.com" : resolvedHost;
    return repositoryHost.toLowerCase() === host.toLowerCase() ? undefined : repositoryHost;
  },
);

function buildRepositoryIdentity(input: {
  readonly remoteName: string;
  readonly remoteUrl: string;
  readonly rootPath: string;
  readonly canonicalHost?: string;
}): RepositoryIdentity {
  const remoteKey = normalizeGitRemoteUrl(input.remoteUrl);
  const repositoryPath = remoteKey.split("/").slice(1).join("/");
  const canonicalHost = input.canonicalHost?.trim().toLowerCase();
  const canonicalKey =
    canonicalHost && repositoryPath.length > 0 ? `${canonicalHost}/${repositoryPath}` : remoteKey;
  const sourceControlProvider = detectSourceControlProviderFromGitRemoteUrl(
    input.canonicalHost === undefined ? input.remoteUrl : `https://${canonicalKey}`,
  );
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

const resolveRepositoryIdentityCacheKey = Effect.fn("RepositoryIdentityResolver.resolveCacheKey")(
  function* (cwd: string) {
    const processRunner = yield* ProcessRunner.ProcessRunner;

    // git is a real executable on every platform — no cmd.exe shell mode, which
    // would split paths containing spaces during cmd's re-tokenization.
    const topLevelResult = yield* processRunner
      .run({
        command: "git",
        args: ["-C", cwd, "rev-parse", "--show-toplevel"],
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.option);
    if (topLevelResult._tag === "None" || topLevelResult.value.code !== 0) {
      return null;
    }

    const candidate = topLevelResult.value.stdout.trim();
    return candidate.length > 0 ? candidate : null;
  },
);

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
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  if (remoteResult._tag === "None" || remoteResult.value.code !== 0) {
    return null;
  }

  const remote = pickPrimaryRemote(parseRemoteFetchUrls(remoteResult.value.stdout));
  if (remote === null) return null;

  const canonicalHost = yield* resolveRepositoryRemoteHost(remote.remoteUrl);
  return buildRepositoryIdentity({
    ...remote,
    rootPath: cacheKey,
    ...(canonicalHost === undefined ? {} : { canonicalHost }),
  });
});

export const make = Effect.fn("RepositoryIdentityResolver.make")(function* (
  options: RepositoryIdentityResolverOptions = {},
) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const cacheCapacity = options.cacheCapacity ?? DEFAULT_REPOSITORY_IDENTITY_CACHE_CAPACITY;

  const repositoryRootCache = yield* Cache.makeWith<string, string | null>(
    (cwd) =>
      resolveRepositoryIdentityCacheKey(cwd).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    {
      capacity: cacheCapacity,
      timeToLive: Exit.match({
        onSuccess: (value) =>
          value === null ? Duration.zero : (options.positiveCacheTtl ?? DEFAULT_POSITIVE_CACHE_TTL),
        onFailure: () => Duration.zero,
      }),
    },
  );

  const repositoryIdentityCache = yield* Cache.makeWith<string, RepositoryIdentity | null>(
    (cacheKey) =>
      resolveRepositoryIdentityFromCacheKey(cacheKey).pipe(
        Effect.provideService(ProcessRunner.ProcessRunner, processRunner),
      ),
    {
      capacity: cacheCapacity,
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
  )(function* (cwd, options) {
    if (options?.refresh) yield* Cache.invalidate(repositoryRootCache, cwd);
    const cacheKey = yield* Cache.get(repositoryRootCache, cwd);
    if (cacheKey === null) return null;
    if (options?.refresh) yield* Cache.invalidate(repositoryIdentityCache, cacheKey);
    return yield* Cache.get(repositoryIdentityCache, cacheKey);
  });

  return RepositoryIdentityResolver.of({ resolve });
});

export const layer = Layer.effect(RepositoryIdentityResolver, make()).pipe(
  Layer.provide(ProcessRunner.layer),
);
