import type { FlyMachineConfig } from "@distilled.cloud/fly-io/machines";
import {
  pinsFromConfig,
  sameImageSet,
  validObservedImageSet,
} from "./DeploymentImages.ts";
import { alchemyMetadataKeys as keys } from "./Metadata.ts";

type DeploymentState =
  | { protocol: "legacy" | "1" | "2" }
  | { protocol: "invalid"; reason: string };

/** Observation and reconciliation must agree before treating a Machine as legacy. */
export const classifyDeploymentState = (machine: {
  config?: FlyMachineConfig;
}): DeploymentState => {
  const metadata = machine.config?.metadata;
  const protocol = metadata?.[keys.protocol];
  if (protocol !== undefined && protocol !== "1" && protocol !== "2")
    return {
      protocol: "invalid",
      reason: `Unknown deployment protocol ${protocol}.`,
    };
  if (protocol !== "2" && metadata?.[keys.containerImageSet] !== undefined)
    return {
      protocol: "invalid",
      reason: "Container image metadata requires deployment protocol 2.",
    };
  if (protocol === "2")
    return validProtocol2RecoveryMetadata(machine)
      ? { protocol }
      : {
          protocol: "invalid",
          reason: "Invalid protocol-2 image set or recovery metadata.",
        };
  if (protocol === "1") {
    const replica = metadata?.[keys.replica] ?? "";
    if (
      !/^(0|[1-9]\d*)$/.test(replica) ||
      !Number.isSafeInteger(Number(replica)) ||
      !["candidate", "promoting", "validating", "active", "retiring"].includes(
        metadata?.[keys.phase] ?? "",
      )
    )
      return {
        protocol: "invalid",
        reason: "Invalid protocol-1 replica index or deployment phase.",
      };
    return { protocol };
  }
  return { protocol: "legacy" };
};

/** Required recovery fields for a complete protocol-2 generation member. */
const validProtocol2RecoveryMetadata = (machine: {
  config?: FlyMachineConfig;
}): boolean => {
  if (!validObservedImageSet(machine)) return false;
  const recorded = machine.config?.metadata;
  const countText = recorded?.[keys.count] ?? "";
  const sequenceText = recorded?.[keys.sequence] ?? "";
  const replicaText = recorded?.[keys.replica] ?? "";
  const count = Number(countText);
  const index = Number(replicaText);
  const roles = (recorded?.[keys.roles] ?? "").split(",");
  return (
    Boolean(recorded?.[keys.generation]?.trim()) &&
    Boolean(recorded?.[keys.workload]?.trim()) &&
    /^[1-9]\d*$/.test(countText) &&
    Number.isSafeInteger(count) &&
    /^[1-9]\d*$/.test(sequenceText) &&
    Number.isSafeInteger(Number(sequenceText)) &&
    /^(0|[1-9]\d*)$/.test(replicaText) &&
    Number.isSafeInteger(index) &&
    index < count &&
    roles.length === count &&
    roles.includes("run") &&
    roles.every((role) => role === "run" || role === "idle") &&
    recorded?.[keys.role] === roles[index] &&
    ["candidate", "promoting", "validating", "active", "retiring"].includes(
      recorded?.[keys.phase] ?? "",
    ) &&
    ["true", "false"].includes(recorded?.[keys.restored] ?? "")
  );
};

/** A partial protocol-2 generation is valid only when every member agrees on its identity. */
export const validProtocol2Generation = (
  group: readonly { config?: FlyMachineConfig }[],
): boolean => {
  const first = group[0]?.config?.metadata;
  if (!first || group.length === 0) return false;
  const indices = new Set<string>();
  for (const machine of group) {
    const metadata = machine.config?.metadata;
    const replica = metadata?.[keys.replica];
    if (
      !validProtocol2RecoveryMetadata(machine) ||
      metadata?.[keys.generation] !== first[keys.generation] ||
      metadata?.[keys.count] !== first[keys.count] ||
      metadata?.[keys.sequence] !== first[keys.sequence] ||
      metadata?.[keys.workload] !== first[keys.workload] ||
      metadata?.[keys.roles] !== first[keys.roles] ||
      replica === undefined ||
      indices.has(replica) ||
      !sameImageSet(
        pinsFromConfig(machine.config),
        pinsFromConfig(group[0]?.config),
      )
    )
      return false;
    indices.add(replica);
  }
  return true;
};
