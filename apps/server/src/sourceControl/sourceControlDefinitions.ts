import * as AzureDevOpsDriver from "@t3tools/source-control-azure-devops/server/driver";
import * as BitbucketDriver from "@t3tools/source-control-bitbucket/server/driver";
import type { SourceControlDefinitionRegistry } from "@t3tools/source-control-core/shared/definition";
import * as CursorOriginDriver from "@t3tools/source-control-cursor-origin/server/driver";
import { builtInSourceControlDefinitions } from "@t3tools/source-control-definitions/registry";
import * as ForgejoDriver from "@t3tools/source-control-forgejo/server/driver";
import * as GitCafeDriver from "@t3tools/source-control-gitcafe/server/driver";
import * as GitHubDriver from "@t3tools/source-control-github/server/driver";
import * as GitLabDriver from "@t3tools/source-control-gitlab/server/driver";
import { isSshRemoteUrl } from "@t3tools/shared/sourceControl";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- remote recognition is synchronous, so the alias lookup is too.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";

/** In the shared registry's order, which is the order hosts are listed and probed in. */
export const BUILT_IN_SOURCE_CONTROL_DRIVER_LIST = [
  GitHubDriver.driver,
  CursorOriginDriver.driver,
  GitLabDriver.driver,
  GitCafeDriver.driver,
  ForgejoDriver.driver,
  BitbucketDriver.driver,
  AzureDevOpsDriver.driver,
] as const;

const SSH_URL_HOST = /^(ssh:\/\/(?:[^@/]*@)?)([^:/?#]+)/iu;
const SCP_HOST = /^((?:[^@:/\\\s]+@)?)([^@:/\\\s]+)(?=:)/u;
const SSH_CONFIG_HOST = /^[a-z0-9_][a-z0-9._-]*$/u;
const SSH_ALIAS_TTL_MS = 5 * 60_000;
// SSH-only endpoints for getting through firewalls; the forge's API and web host is the other name.
const SSH_ENDPOINT_HOSTS: Readonly<Record<string, string>> = { "ssh.github.com": "github.com" };

/** An SSH remote read on the forge its `ssh_config` alias leads to. */
export function withSshHostAliases(
  registry: SourceControlDefinitionRegistry,
  resolveHostName: (host: string) => string | null,
): SourceControlDefinitionRegistry {
  const resolveRemote = (remoteUrl: string): string => {
    const trimmed = remoteUrl.trim();
    if (!isSshRemoteUrl(trimmed)) return remoteUrl;
    const pattern = /^ssh:\/\//iu.test(trimmed) ? SSH_URL_HOST : SCP_HOST;
    const match = pattern.exec(trimmed);
    const host = match?.[2]?.toLowerCase();
    if (match === null || host === undefined || !SSH_CONFIG_HOST.test(host)) return remoteUrl;
    if (NodeNet.isIP(host) !== 0) return remoteUrl;
    const resolved = resolveHostName(host)?.toLowerCase();
    const hostName =
      resolved === undefined ? undefined : (SSH_ENDPOINT_HOSTS[resolved] ?? resolved);
    if (!hostName || hostName === host) return remoteUrl;
    const aliased = `${match[1]}${hostName}${trimmed.slice(match[0].length)}`;
    // A public forge always wins. Otherwise a host a forge claims by name keeps it, since its SSH
    // endpoint may be named differently, and an alias is renamed only to a host a forge claims.
    if (registry.findByPublicHost(hostName) !== undefined) return aliased;
    if (registry.recognizeRemote(trimmed)?.kind !== "unknown") return remoteUrl;
    return registry.recognizeRemote(aliased)?.kind === "unknown" ? remoteUrl : aliased;
  };
  return {
    ...registry,
    recognizeRemote: (remoteUrl) => registry.recognizeRemote(resolveRemote(remoteUrl)),
    repositoryKeyFromRemote: (remoteUrl) =>
      registry.repositoryKeyFromRemote(resolveRemote(remoteUrl)),
  };
}

const sshHostNames = new Map<
  string,
  { readonly hostName: string | null; readonly until: number }
>();

/** The `HostName` ssh would connect to for `host`, from `ssh -G`. Null when ssh cannot say. */
function sshConfigHostName(host: string): string | null {
  const cached = sshHostNames.get(host);
  if (cached !== undefined && cached.until > performance.now()) return cached.hostName;
  let hostName: string | null = null;
  try {
    const output = NodeChildProcess.execFileSync("ssh", ["-G", "--", host], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    hostName = /^hostname[ \t]+(\S+)[ \t]*$/imu.exec(output)?.[1] ?? null;
  } catch {}
  sshHostNames.set(host, { hostName, until: performance.now() + SSH_ALIAS_TTL_MS });
  return hostName;
}

export const sourceControlDefinitions = withSshHostAliases(
  builtInSourceControlDefinitions,
  sshConfigHostName,
);
