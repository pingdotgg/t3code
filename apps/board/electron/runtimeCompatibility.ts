import { orchestrationProtocolCompatibilityError } from "@t3tools/client-runtime/connection";
import { ExecutionEnvironmentDescriptor, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// The first release whose server speaks the orchestration protocol this client speaks. Servers
// before it omit the protocol version, which the client reads as protocol 1.
const FIRST_RELEASE_WITH_CURRENT_PROTOCOL = [0, 1, 0] as const;

const decodeDescriptor = Schema.decodeUnknownOption(ExecutionEnvironmentDescriptor);

function parseVersion(text: string): readonly [number, number, number] | null {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

const isAtLeast = (
  version: readonly [number, number, number],
  floor: readonly [number, number, number],
): boolean => {
  for (let index = 0; index < 3; index += 1) {
    const difference = (version[index] ?? 0) - (floor[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
};

/** Whether a `t3 --version` release would connect to this client, by the client's own rule. */
export function runtimeSupportsClient(versionText: string): boolean {
  const version = parseVersion(versionText);
  if (version === null) return false;
  const descriptor = decodeDescriptor({
    environmentId: "runtime-candidate",
    label: "WSL",
    platform: { os: "linux", arch: "x64", machine: "linux" },
    serverVersion: version.join("."),
    ...(isAtLeast(version, FIRST_RELEASE_WITH_CURRENT_PROTOCOL)
      ? { orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION }
      : {}),
    capabilities: {},
  });
  return (
    Option.isSome(descriptor) && orchestrationProtocolCompatibilityError(descriptor.value) === null
  );
}
