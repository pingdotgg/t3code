import type { EnvironmentId, SshDeviceHostConfig } from "@t3tools/contracts";

export interface DeviceHostEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly hosts: ReadonlyArray<SshDeviceHostConfig>;
}

export interface DeviceHostGroup {
  readonly host: SshDeviceHostConfig;
  readonly members: Array<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
    readonly host: SshDeviceHostConfig;
  }>;
}

/** Only combine matching configurations; ambiguous identities keep their machine's list. */
export function groupDeviceHosts(
  environments: ReadonlyArray<DeviceHostEnvironment>,
): ReadonlyArray<DeviceHostGroup> | null {
  const groups = new Map<string, DeviceHostGroup>();
  const identities = new Map<string, string>();
  const configurations = new Map<string, string>();
  for (const environment of environments) {
    const destinations = new Set<string>();
    for (const host of environment.hosts) {
      const destination = JSON.stringify([host.target, host.port, host.identityFile]);
      const configuration = JSON.stringify([host.label, host.target, host.port, host.identityFile]);
      const previousConfiguration = identities.get(host.id);
      const targetConfiguration = configurations.get(host.target);
      const group = groups.get(destination);
      if (
        destinations.has(destination) ||
        (previousConfiguration !== undefined && previousConfiguration !== configuration) ||
        (targetConfiguration !== undefined && targetConfiguration !== configuration)
      ) {
        return null;
      }
      destinations.add(destination);
      identities.set(host.id, configuration);
      configurations.set(host.target, configuration);
      const member = {
        environmentId: environment.environmentId,
        label: environment.label,
        host,
      };
      if (group) group.members.push(member);
      else groups.set(destination, { host, members: [member] });
    }
  }
  return [...groups.values()];
}

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
