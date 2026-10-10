import type { SshDeviceHostConfig } from "@t3tools/contracts";

/** Apply one host change without replacing another environment's host list. */
export function updateDeviceHosts(
  hosts: ReadonlyArray<SshDeviceHostConfig>,
  host: SshDeviceHostConfig,
  remove: boolean,
  original = host,
): ReadonlyArray<SshDeviceHostConfig> {
  const sameDestination = (candidate: SshDeviceHostConfig, other: SshDeviceHostConfig) =>
    candidate.target === other.target &&
    candidate.port === other.port &&
    candidate.identityFile === other.identityFile;
  const findDestination = (destination: SshDeviceHostConfig) => {
    const matches = hosts.filter((candidate) => sameDestination(candidate, destination));
    if (matches.length > 1) {
      throw new Error(
        "Multiple hosts match this SSH destination. Select the environment to edit its hosts.",
      );
    }
    return matches[0];
  };
  // A retry can encounter the updated destination on an environment that
  // already saved, including one with a different environment-local host ID.
  const existing =
    hosts.find((candidate) => candidate.id === original.id) ??
    findDestination(original) ??
    (remove ? undefined : findDestination(host));
  if (remove) return hosts.filter((candidate) => candidate.id !== existing?.id);
  return existing
    ? hosts.map((candidate) =>
        candidate.id === existing.id ? { ...host, id: existing.id } : candidate,
      )
    : [...hosts, host];
}
