import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

import type * as ProcessRunner from "../processRunner.ts";

const SSH_URL_HOST = /^(ssh:\/\/(?:[^@/]*@)?)([^@:/]+)/iu;
const SCP_URL_HOST = /^((?:[^@:/]*@)?)([^@:/]{2,})(?=:(?!\/))/u;

const hostPattern = (remoteUrl: string): RegExp =>
  /^ssh:\/\//iu.test(remoteUrl) ? SSH_URL_HOST : SCP_URL_HOST;

export type SshConfigProbe = (host: string) => Effect.Effect<string>;

export const sshConfigProbe =
  (processRunner: ProcessRunner.ProcessRunner["Service"]): SshConfigProbe =>
  (host) =>
    processRunner
      .run({ command: "ssh", args: ["-G", "--", host], timeoutBehavior: "timedOutResult" })
      .pipe(
        Effect.map((result) => result.stdout),
        Effect.orElseSucceed(() => ""),
      );

const HOSTNAME_TTL_MS = 5 * 60_000;

export const SshHostnameCache = Context.Reference<
  Map<string, { readonly at: number; readonly hostname: string }>
>("@t3tools/server/vcs/SshHostnameCache", {
  defaultValue: () => new Map(),
});

export const canonicalizeSshRemoteUrl = Effect.fnUntraced(function* (
  remoteUrl: string,
  probe: SshConfigProbe,
) {
  const host = hostPattern(remoteUrl).exec(remoteUrl)?.[2];
  if (host === undefined) return remoteUrl;

  const cache = yield* SshHostnameCache;
  const now = Date.now();
  const cached = cache.get(host);
  let hostname =
    cached !== undefined && now - cached.at < HOSTNAME_TTL_MS ? cached.hostname : undefined;
  if (hostname === undefined) {
    // Only cache probes that yielded a hostname; a failed or empty ssh -G run
    // must not pin the alias unresolved for the whole TTL.
    const probed = /^hostname[ \t]+(\S+)/imu.exec(yield* probe(host))?.[1];
    if (probed !== undefined) cache.set(host, { at: now, hostname: probed });
    hostname = probed ?? host;
  }

  if (hostname === host) return remoteUrl;
  const substituted =
    hostname.includes(":") && !hostname.startsWith("[") ? `[${hostname}]` : hostname;
  return remoteUrl.replace(hostPattern(remoteUrl), (_, prefix: string) => prefix + substituted);
});
