import {
  type DeviceHostSummary,
  type DevicePlatformAvailability,
  type EnvironmentId,
  SshDeviceHostConfig,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { redactSshAddresses } from "@t3tools/client-runtime/connection";
import { parseManualDesktopSshTarget } from "./sshTarget";

export interface DeviceHostCheckTarget {
  environmentId: EnvironmentId;
  label: string;
  connected: boolean;
}
export type DeviceHostCheck =
  | { status: "pending" }
  | { status: "local" }
  | {
      status: "connected";
      platforms: ReadonlyArray<DevicePlatformAvailability>;
      tools?: DeviceHostSummary["tools"];
    }
  | { status: "failed"; error: string; rawError: string };

const decodeDeviceHostDraft = Schema.decodeUnknownOption(SshDeviceHostConfig);

export function parseDeviceHostDraft(host: SshDeviceHostConfig) {
  const { identityFile, ...rest } = host;
  return decodeDeviceHostDraft({
    ...rest,
    ...(identityFile?.trim() ? { identityFile: identityFile.trim() } : {}),
  });
}

export function deviceHostConnectionKey(host: SshDeviceHostConfig) {
  return JSON.stringify([host.target.trim(), host.port, host.identityFile?.trim() || undefined]);
}

export async function checkDeviceHostConnections(
  targets: ReadonlyArray<DeviceHostCheckTarget>,
  host: SshDeviceHostConfig,
  probe: (environmentId: EnvironmentId, host: SshDeviceHostConfig) => Promise<DeviceHostSummary>,
  report: (environmentId: EnvironmentId, result: DeviceHostCheck) => void,
) {
  await Promise.all(
    targets.map(async (target) => {
      report(target.environmentId, { status: "pending" });
      let sshTarget: ReturnType<typeof parseManualDesktopSshTarget> = {
        alias: host.target,
        hostname: host.target,
        username: null,
        port: host.port ?? null,
      };
      try {
        sshTarget = {
          ...parseManualDesktopSshTarget({
            host: host.target,
            username: "",
            port: host.port?.toString() ?? "",
          }),
          alias: host.target,
        };
        if (!target.connected) throw new Error("Environment disconnected");
        const result = await probe(target.environmentId, host);
        report(
          target.environmentId,
          result.kind === "local"
            ? { status: "local" }
            : {
                status: "connected",
                platforms: result.platforms,
                ...(result.tools ? { tools: result.tools } : {}),
              },
        );
      } catch (error) {
        report(target.environmentId, {
          status: "failed",
          rawError: error instanceof Error ? error.message : String(error),
          error: redactSshAddresses(
            error instanceof Error ? error.message : String(error),
            sshTarget,
          ),
        });
      }
    }),
  );
}
