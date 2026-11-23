import { useAtomValue } from "@effect/atom-react";
import type { HostedSandbox, SandboxHost } from "@t3tools/client-runtime/state/sandboxes";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type EnvironmentMachineKind,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { settingsScopeEnvironmentLabel } from "../components/settings/settingsScopeAxis";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useEnvironments } from "../state/environments";
import { primaryEnvironmentIdAtom } from "../state/primaryEnvironment";
import { sandboxEnvironment } from "../state/sandboxes";

const offersSandboxesAtom = Atom.make((get) =>
  get(sandboxEnvironment.hostsValueAtom).some((host) => host.snapshot.status === "available"),
).pipe(Atom.withLabel("sandboxes:offered"));

/**
 * Where New Sandbox and the Sandboxes page go when nothing names a host: this client's own server
 * when it can reach agentctl, else the first host that can.
 */
const defaultHostAtom = Atom.make((get) => {
  const available = get(sandboxEnvironment.hostsValueAtom).filter(
    (host) => host.snapshot.status === "available",
  );
  const primary = get(primaryEnvironmentIdAtom);
  return (
    (available.find((host) => host.hostEnvironmentId === primary) ?? available[0])
      ?.hostEnvironmentId ?? null
  );
}).pipe(Atom.withLabel("sandboxes:default-host"));

/** Whether Sandboxes come from more than one host, so a Sandbox's name alone may be ambiguous. */
export const sandboxesOnSeveralHostsAtom = Atom.make(
  (get) =>
    get(sandboxEnvironment.hostsValueAtom).filter((host) => host.snapshot.sandboxes.length > 0)
      .length > 1,
).pipe(Atom.withLabel("sandboxes:several-hosts"));

export function useSandboxesOnSeveralHosts(): boolean {
  return useAtomValue(sandboxesOnSeveralHostsAtom);
}

export function useSandboxHosts(): ReadonlyArray<SandboxHost> {
  return useAtomValue(sandboxEnvironment.hostsValueAtom);
}

export function useSandboxHost(hostEnvironmentId: EnvironmentId | null): SandboxHost | null {
  return useSandboxHosts().find((host) => host.hostEnvironmentId === hostEnvironmentId) ?? null;
}

export function useSandboxes(): ReadonlyArray<HostedSandbox> {
  return useAtomValue(sandboxEnvironment.sandboxesAtom);
}

/** Every host's Sandboxes now, for code outside React. */
export function readSandboxes(): ReadonlyArray<HostedSandbox> {
  return appAtomRegistry.get(sandboxEnvironment.sandboxesAtom);
}

export function readDefaultSandboxHost(): EnvironmentId | null {
  return appAtomRegistry.get(defaultHostAtom);
}

/** Whether a connected host can reach agentctl, so Sandbox actions are worth offering. */
export function useOffersSandboxes(): boolean {
  return useAtomValue(offersSandboxesAtom);
}

/** The host a view shows when nothing names one: the first that can reach agentctl, or any. */
export function useDefaultSandboxHost(): EnvironmentId | null {
  const available = useAtomValue(defaultHostAtom);
  const hosts = useSandboxHosts();
  return available ?? hosts[0]?.hostEnvironmentId ?? null;
}

export interface SandboxHostOption {
  readonly hostEnvironmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
  readonly offline: boolean;
  /** "2 Sandboxes", or why there are none to show. */
  readonly summary: string;
}

/** Each host that manages Sandboxes, named as the client names its environment. */
export function useSandboxHostOptions(): ReadonlyArray<SandboxHostOption> {
  const hosts = useSandboxHosts();
  const { environments } = useEnvironments();
  return hosts.map((host) => {
    const environment = environments.find(
      (candidate) => candidate.environmentId === host.hostEnvironmentId,
    );
    const count = host.snapshot.sandboxes.length;
    return {
      hostEnvironmentId: host.hostEnvironmentId,
      // Two machines can share a name, so a shared one gets its address, as in Settings.
      label:
        environment === undefined
          ? "Unknown host"
          : settingsScopeEnvironmentLabel(environment, environments),
      machine: resolveEnvironmentMachineKind(environment?.serverConfig ?? null),
      offline: environment?.connection.phase !== "connected",
      summary:
        host.snapshot.status === "unavailable"
          ? "agentctl is not available"
          : host.snapshot.status === "loading"
            ? "Looking for Sandboxes…"
            : `${count} ${count === 1 ? "Sandbox" : "Sandboxes"}`,
    };
  });
}
