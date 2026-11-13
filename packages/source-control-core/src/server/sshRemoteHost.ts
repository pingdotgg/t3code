import * as HostProcess from "@t3tools/shared/HostProcess";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import type * as SourceControlHost from "./SourceControlHost.ts";

// The host keeps its spelling: ssh matches `Host` patterns case-sensitively. A leading `-` on the
// user or host would be read by ssh as an option.
const SSH_REMOTE =
  /^((?:ssh:\/\/)?)((?:[^-@/:][^@/:]*@)?)([A-Za-z0-9][A-Za-z0-9._-]*)([:/].*)?$/isu;
const HOST_NAME = /^[a-z0-9][a-z0-9.-]*$/u;
const IPV4 = /^[\d.]+$/u;

// The public forges' SSH endpoints on port 443.
const SSH_ENDPOINT_HOSTS: ReadonlyMap<string, string> = new Map([
  ["ssh.github.com", "github.com"],
  ["altssh.gitlab.com", "gitlab.com"],
]);

function hostNameOf(sshConfig: string): string | null {
  const hostName = sshConfig
    .split("\n")
    .find((line) => line.startsWith("hostname "))
    ?.slice("hostname ".length)
    .trim()
    .toLowerCase();
  if (hostName === undefined || !HOST_NAME.test(hostName) || IPV4.test(hostName)) return null;
  return SSH_ENDPOINT_HOSTS.get(hostName) ?? hostName;
}

/**
 * Builds `SourceControlHost.canonicalRemoteUrl`. A dotted host may itself be the web host with a
 * separate SSH endpoint behind it, so it is replaced only by a public forge.
 */
export const make = Effect.fnUntraced(function* (input: {
  readonly run: SourceControlHost.SourceControlHost["Service"]["process"]["run"];
  readonly isPublicHost: (hostName: string) => boolean;
}) {
  const cwd = yield* HostProcess.WorkingDirectory;
  // `ssh -G` prints the configuration it would use and opens no connection.
  const hostNames = yield* Cache.make({
    capacity: 256,
    timeToLive: Duration.minutes(5),
    // Keyed by `user@host`: a `Match user` block can send one user of a host elsewhere.
    lookup: (target: string) =>
      input
        .run({
          operation: "SourceControlHost.canonicalRemoteUrl",
          command: "ssh",
          args: ["-G", target],
          cwd,
          allowNonZeroExit: true,
          timeoutMs: 5_000,
          maxOutputBytes: 64_000,
          outputMode: "truncate",
        })
        .pipe(
          Effect.map((result) => (result.exitCode === 0 ? hostNameOf(result.stdout) : null)),
          Effect.orElseSucceed(() => null),
        ),
  });
  return Effect.fn("SourceControlHost.canonicalRemoteUrl")(function* (remoteUrl: string) {
    const [, scheme, user, host, rest = ""] = isSshRemoteUrl(remoteUrl)
      ? (SSH_REMOTE.exec(remoteUrl.trim()) ?? [])
      : [];
    if (scheme === undefined || user === undefined || host === undefined) return remoteUrl;
    const hostName = yield* Cache.get(hostNames, `${user}${host}`);
    return hostName === null ||
      hostName === host.toLowerCase() ||
      (host.includes(".") && !input.isPublicHost(hostName))
      ? remoteUrl
      : `${scheme}${user}${hostName}${rest}`;
  });
});
