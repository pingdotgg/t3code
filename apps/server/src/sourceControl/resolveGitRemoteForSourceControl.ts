import { isSshRemoteUrl, rewriteGitRemoteUrlHost } from "@t3tools/shared/sourceControl";
import { resolveSshTarget } from "@t3tools/ssh/command";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcessSpawner } from "effect/unstable/process";

const SCP_SSH_HOST_PATTERN = /^[a-zA-Z0-9._-]+@([^:/]+):/;

const KNOWN_PUBLIC_SSH_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "dev.azure.com",
]);

export type ResolveGitRemoteServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path;

export type ResolveSshHostname<R = never> = (
  alias: string,
) => Effect.Effect<string | null, never, R>;

function parseSshRemoteHostname(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0 || !isSshRemoteUrl(trimmed)) {
    return null;
  }

  const scpMatch = SCP_SSH_HOST_PATTERN.exec(trimmed);
  if (scpMatch?.[1]) {
    return scpMatch[1].toLowerCase();
  }

  if (trimmed.toLowerCase().startsWith("ssh://")) {
    try {
      const hostname = new URL(trimmed).hostname.toLowerCase();
      return hostname.length > 0 ? hostname : null;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * SSH aliases such as `github-personal` have no dot and are not public hosts.
 * Those are the only remotes worth asking `ssh -G` about.
 */
export function gitRemoteSshAliasToResolve(remoteUrl: string): string | null {
  const hostname = parseSshRemoteHostname(remoteUrl);
  if (hostname === null || hostname.includes(".") || KNOWN_PUBLIC_SSH_HOSTS.has(hostname)) {
    return null;
  }
  return hostname;
}

/** Same budget as `RepositoryIdentityResolver`'s `ssh -G` probe. */
export const SSH_CONFIG_RESOLVE_TIMEOUT_MS = 5_000;

export const resolveSshHostnameFromConfig: ResolveSshHostname<ResolveGitRemoteServices> = (alias) =>
  resolveSshTarget(alias, {
    timeoutMs: SSH_CONFIG_RESOLVE_TIMEOUT_MS,
    fallbackOnError: false,
  }).pipe(
    Effect.map((target) => {
      const hostname = target.hostname.trim();
      return hostname.length > 0 ? hostname : null;
    }),
    Effect.orElseSucceed(() => null),
  );

/**
 * Rewrites `git@alias:path` to the HostName from `ssh -G` so provider
 * detection and the PR pane talk to the real API host. The original remote
 * is left unchanged when resolve fails or the host is already a real name.
 */
export function resolveGitRemoteForSourceControl(
  remoteUrl: string,
  resolveHostname: ResolveSshHostname,
): Effect.Effect<string>;
export function resolveGitRemoteForSourceControl(
  remoteUrl: string,
): Effect.Effect<string, never, ResolveGitRemoteServices>;
export function resolveGitRemoteForSourceControl(
  remoteUrl: string,
  resolveHostname: ResolveSshHostname<ResolveGitRemoteServices> = resolveSshHostnameFromConfig,
): Effect.Effect<string, never, ResolveGitRemoteServices> {
  return Effect.gen(function* () {
    const alias = gitRemoteSshAliasToResolve(remoteUrl);
    if (alias === null) {
      return remoteUrl;
    }

    const resolved = yield* resolveHostname(alias);
    const hostname = resolved?.trim() ?? "";
    if (hostname.length === 0) {
      return remoteUrl;
    }

    return rewriteGitRemoteUrlHost(remoteUrl, hostname);
  });
}
