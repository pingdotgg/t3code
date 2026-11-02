import {
  SimlockDeviceHostConfig,
  type EnvironmentId,
  type SimlockDeviceHostConfig as SimlockDeviceHostConfigType,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const parseSimlockDeviceHostDraft = Schema.decodeUnknownOption(SimlockDeviceHostConfig);

export const newSimlockDeviceHost = (id: string): SimlockDeviceHostConfigType => ({
  kind: "simlock",
  id,
  label: "Simlock",
  gatewayUrl: "",
  agentToken: "",
  maxLeases: 2,
  maxLeaseMinutes: 60,
});

/** Adds, replaces, or removes one Simlock host. */
export function updateSimlockDeviceHosts(
  hosts: ReadonlyArray<SimlockDeviceHostConfigType>,
  host: SimlockDeviceHostConfigType,
  remove: boolean,
): ReadonlyArray<SimlockDeviceHostConfigType> {
  if (remove) return hosts.filter((candidate) => candidate.id !== host.id);
  return hosts.some((candidate) => candidate.id === host.id)
    ? hosts.map((candidate) => (candidate.id === host.id ? host : candidate))
    : [...hosts, host];
}

/** Why the shared fields keep a draft from saving, or null; tokens are checked per environment. */
export function simlockDeviceHostProblem(host: SimlockDeviceHostConfigType): string | null {
  const withToken = { ...host, agentToken: "token" };
  if (Option.isSome(parseSimlockDeviceHostDraft(withToken))) return null;
  if (!host.label.trim()) return "Give the host a label.";
  // With in-range limits, a draft that still fails has a bad gateway URL.
  return Option.isNone(
    parseSimlockDeviceHostDraft({ ...withToken, maxLeases: 1, maxLeaseMinutes: 60 }),
  )
    ? "Enter the gateway's origin, such as https://gateway.example.ts.net:4700."
    : "Keep the limits within the ranges shown.";
}

export function simlockLeaseLimits(host: SimlockDeviceHostConfigType) {
  const devices = host.maxLeases === 1 ? "1 device" : `${host.maxLeases} devices`;
  return `Up to ${devices} at once, each released after ${host.maxLeaseMinutes} min`;
}

export interface SimlockHostEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly hosts: ReadonlyArray<SimlockDeviceHostConfigType>;
}

/** A token field: the environment's saved token, a replacement, or none. */
export type SimlockTokenEntry =
  | { kind: "saved" }
  | { kind: "new"; value: string }
  | { kind: "cleared" };

/**
 * The host list each environment saves: the shared fields everywhere, and each environment's own
 * token, which may stay blank until later. Saved tokens arrive redacted; sending one back keeps it.
 */
export function planSimlockDeviceHostSave(
  environments: ReadonlyArray<SimlockHostEnvironment>,
  draft: SimlockDeviceHostConfigType,
  tokens: ReadonlyMap<EnvironmentId, SimlockTokenEntry>,
):
  | { readonly problem: string }
  | {
      readonly patches: ReadonlyArray<{
        environmentId: EnvironmentId;
        hosts: ReadonlyArray<SimlockDeviceHostConfigType>;
      }>;
    } {
  const shared = simlockDeviceHostProblem(draft);
  if (shared) return { problem: shared };
  const patches = [];
  for (const environment of environments) {
    const saved = environment.hosts.find((host) => host.id === draft.id)?.agentToken ?? "";
    const entry = tokens.get(environment.environmentId) ?? { kind: "cleared" };
    const agentToken =
      entry.kind === "saved" ? saved : entry.kind === "new" ? entry.value.trim() : "";
    patches.push({
      environmentId: environment.environmentId,
      hosts: updateSimlockDeviceHosts(environment.hosts, { ...draft, agentToken }, false),
    });
  }
  return { patches };
}
