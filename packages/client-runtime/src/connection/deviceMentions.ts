import type { DeviceContextRecord } from "@t3tools/contracts";
import * as Option from "effect/Option";

import type { EnvironmentPresentation } from "./presentation.ts";

export type DeviceMention = Omit<DeviceContextRecord, "contextId">;

/** Only advertised SSH targets are usable machine addresses; relay and HTTP URLs are not. */
export function deviceMention(environment: EnvironmentPresentation): DeviceMention {
  const { entry, serverConfig } = environment;
  const profile = Option.getOrNull(entry.profile);
  const ssh = profile?._tag === "SshConnectionProfile" ? profile.target : null;
  return {
    version: 1,
    kind: "device",
    label: entry.target.label.slice(0, 200),
    environmentId: entry.target.environmentId,
    os: serverConfig?.environment.platform.os ?? null,
    connectionStatus: environment.connection.phase,
    ssh: [
      ...(ssh
        ? [
            {
              host: ssh.hostname,
              ...(ssh.username ? { username: ssh.username } : {}),
              ...(ssh.port ? { port: ssh.port } : {}),
            },
          ]
        : []),
      ...(serverConfig?.remoteOpenTargets ?? [])
        .filter((target) => target.host !== ssh?.hostname)
        .map((target) => ({ host: target.host })),
    ],
  };
}

export function searchDeviceMentions(
  environments: ReadonlyArray<EnvironmentPresentation>,
  query: string,
): DeviceMention[] {
  const needle = query.trim().toLowerCase();
  return environments
    .map(deviceMention)
    .filter((device) =>
      [device.label, ...device.ssh.map((target) => target.host)].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
}
