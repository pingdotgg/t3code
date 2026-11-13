import * as HostProcess from "@t3tools/shared/HostProcess";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import type * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { gitHubApiHostForRemote } from "./gitHubRepositoryResolution.ts";

// ssh matches `Host` patterns case-sensitively, so the lookup keeps the remote's spelling.
function sshHostAsWritten(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (!isSshRemoteUrl(trimmed)) return null;
  const scpHead = trimmed.slice(0, Math.max(trimmed.indexOf(":"), 0));
  const host = trimmed.toLowerCase().startsWith("ssh://")
    ? (URL.parse(trimmed)?.hostname ?? "")
    : scpHead.slice(scpHead.lastIndexOf("@") + 1);
  // A leading `-` would be read by ssh as an option.
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(host) ? host : null;
}

/** `ssh.github.com` is github.com's SSH endpoint on port 443. */
function isGitHubDotComHostName(config: string): boolean {
  const hostName = config
    .split("\n")
    .find((line) => line.startsWith("hostname "))
    ?.slice("hostname ".length)
    .trim()
    .toLowerCase();
  return hostName === "github.com" || hostName === "ssh.github.com";
}

/**
 * Which SSH hosts among the remotes `~/.ssh/config` sends to github.com, lower-cased. Git keeps
 * using the alias; only the API host and its credential follow the answer.
 */
export const makeResolver = Effect.fnUntraced(function* (
  process: SourceControlHost.SourceControlHost["Service"]["process"],
) {
  const cwd = yield* HostProcess.WorkingDirectory;
  // `ssh -G` prints the configuration it would use and opens no connection.
  const cache = yield* Cache.make({
    capacity: 256,
    timeToLive: Duration.minutes(5),
    lookup: (host: string) =>
      process
        .run({
          operation: "GitHubSshAliases.resolve",
          command: "ssh",
          args: ["-G", host],
          cwd,
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 64_000,
          outputMode: "truncate",
        })
        .pipe(
          Effect.map((result) => result.exitCode === 0 && isGitHubDotComHostName(result.stdout)),
          Effect.orElseSucceed(() => false),
        ),
  });
  return Effect.fn("GitHubSshAliases.resolve")(function* (remoteUrls: ReadonlyArray<string>) {
    const aliases = new Set<string>();
    for (const remoteUrl of remoteUrls) {
      // A host whose spelling already says github.com needs no lookup.
      if (gitHubApiHostForRemote(remoteUrl) === "github.com") continue;
      const host = sshHostAsWritten(remoteUrl);
      if (host !== null && (yield* Cache.get(cache, host))) aliases.add(host.toLowerCase());
    }
    return aliases as ReadonlySet<string>;
  });
});
