import { detectSourceControlProviderFromGitRemoteUrl } from "@t3tools/shared/git";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";

// The SSH-over-443 endpoints providers document serve the same repositories as
// the main host, so they key the same.
const SSH_ENDPOINT_HOSTS: Readonly<Record<string, string>> = {
  "ssh.github.com": "github.com",
  "altssh.gitlab.com": "gitlab.com",
  "altssh.bitbucket.org": "bitbucket.org",
};
// Public forges key as themselves whatever ssh routes them through, so they
// skip the lookup.
const PUBLIC_SSH_HOSTS = new Set([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "ssh.dev.azure.com",
  ...Object.keys(SSH_ENDPOINT_HOSTS),
]);
// Only plain names reach ssh, so a remote can neither pass it an option
// (`-oProxyCommand=…`) nor put shell syntax in the `%h` / `%r` tokens a
// `Match exec` line expands. OpenSSH before 9.6 does not reject those itself.
const SSH_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;
const LOOPBACK_HOST_PATTERN = /^(?:localhost|127(?:\.\d+){3})$/;

const isSshName = (name: string | undefined) => name !== undefined && SSH_NAME_PATTERN.test(name);

interface SshRemote {
  readonly user: string | undefined;
  readonly host: string;
  readonly port: string | undefined;
  readonly path: string;
}

/**
 * An SSH remote in either spelling git accepts, `[user@]host:path` or
 * `ssh://[user@]host[:port]/path`, when its names are safe to hand to ssh. A URL
 * keeps its path absolute, so the SCP spelling built from it names the same
 * repository. A one-letter host without a user is a Windows drive, which git
 * reads as a path.
 */
function parseSshRemote(remoteUrl: string): SshRemote | null {
  const trimmed = remoteUrl.trim();
  let remote: SshRemote | null = null;
  if (/^(?:ssh|git\+ssh|ssh\+git):\/\//i.test(trimmed)) {
    const url = URL.parse(trimmed.replace(/^[^:]+:/, "ssh:"));
    if (url && url.pathname.length > 1) {
      remote = {
        user: url.username || undefined,
        host: url.hostname,
        port: url.port || undefined,
        path: url.pathname,
      };
    }
  } else if (!trimmed.includes("://")) {
    const [, user, host = "", path] = /^(?:([^@/\s]+)@)?([^:/\s@]+):(\S+)$/.exec(trimmed) ?? [];
    if (path && (user || host.length > 1)) remote = { user, host, port: undefined, path };
  }
  return remote && isSshName(remote.host) && (remote.user === undefined || isSshName(remote.user))
    ? remote
    : null;
}

/** `ssh -G` output, one `key value` per line, by lowercase key. */
function parseSshConfig(stdout: string): ReadonlyMap<string, string> {
  return new Map(
    stdout.split("\n").flatMap((line) => {
      const [key = "", ...value] = line.trim().split(/\s+/);
      return value.length > 0 ? [[key.toLowerCase(), value.join(" ")] as const] : [];
    }),
  );
}

/** What `ssh -G` prints for the remote's host, user and port, or "" when it fails. */
const readSshConfig = Effect.fn("sshHostAlias.readSshConfig")(function* (remote: SshRemote) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: "ssh",
      args: [
        "-G",
        ...(remote.user ? ["-l", remote.user] : []),
        ...(remote.port ? ["-p", remote.port] : []),
        remote.host,
      ],
      timeout: Duration.seconds(5),
      timeoutBehavior: "timedOutResult",
    })
    .pipe(Effect.option);
  return result._tag === "Some" && result.value.code === 0 ? result.value.stdout : "";
});

/**
 * The path with a relative one spelled under its login's home (`~user/app.git`).
 *
 * On a plain server `alice@host:app.git` and `bob@host:app.git` are two
 * repositories, one in each home. Forges serve every repository to one shared
 * `git` login and read the path as the repository's name, so theirs stay as
 * is, as do absolute paths and paths already in a named home (`~other/app`).
 */
function homeQualifiedPath(path: string, user: string | undefined, host: string): string {
  const isForge = detectSourceControlProviderFromGitRemoteUrl(`git@${host}:`)?.kind !== "unknown";
  if (!user || user === "git" || isForge) return path;
  const inOwnHome = path.replace(/^\/?~\//, "");
  if (inOwnHome === path && /^[/~]/.test(path)) return path;
  return `~${user}/${inOwnHome}`;
}

/**
 * The remote spelled by the host and path that key its repository.
 *
 * `gh:owner/repo` with `Host gh` / `HostName github.com` is the same repository
 * as `https://github.com/owner/repo`, but only ssh knows that. `ssh -G` reads
 * the config the way ssh does (`Include`, `Match`, wildcards) without
 * connecting, given the remote's user and port since `Match` rules can depend
 * on them. A trailing dot spells the same DNS name. A loopback `HostName` is a
 * tunnel, which names no repository, so the alias stays. Git keeps using the
 * raw remote; a remote that is not SSH, or that ssh cannot read, stays as is,
 * and so does an IPv6 host, which has no SCP spelling git would read back.
 */
export const expandSshHostAlias = Effect.fn("sshHostAlias.expandSshHostAlias")(function* (
  remoteUrl: string,
) {
  const remote = parseSshRemote(remoteUrl);
  if (!remote) return remoteUrl;

  const alias = remote.host.toLowerCase();
  const config = parseSshConfig(PUBLIC_SSH_HOSTS.has(alias) ? "" : yield* readSshConfig(remote));
  const hostName = (config.get("hostname") ?? alias).toLowerCase().replace(/\.$/, "");
  const host = LOOPBACK_HOST_PATTERN.test(hostName)
    ? alias
    : (SSH_ENDPOINT_HOSTS[hostName] ?? hostName);
  const configUser = config.get("user");
  const user = remote.user ?? (isSshName(configUser) ? configUser : undefined);
  const path = homeQualifiedPath(remote.path, user, host);
  if (host.includes(":") || (host === alias && path === remote.path)) return remoteUrl;
  return `${user ?? "git"}@${host}:${path}`;
});
