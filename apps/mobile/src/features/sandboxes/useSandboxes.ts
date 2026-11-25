import { useAtomValue } from "@effect/atom-react";
import { sandboxHostSummary } from "@t3tools/client-runtime/sandboxes/presentation";
import type { SandboxHost } from "@t3tools/client-runtime/state/sandboxes";
import {
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type EnvironmentMachineKind,
} from "@t3tools/contracts";

import { useEnvironments } from "../../state/environments";
import { sandboxEnvironment } from "../../state/sandboxes";

export function useSandboxHosts(): ReadonlyArray<SandboxHost> {
  return useAtomValue(sandboxEnvironment.hostsValueAtom);
}

/** Whether a connected host can reach agentctl, so Sandbox actions are worth offering. */
export function useOffersSandboxes(): boolean {
  return useAtomValue(sandboxEnvironment.offersSandboxesAtom);
}

/** The host a view shows when nothing names one: the first that can reach agentctl, or any. */
export function useDefaultSandboxHost(): EnvironmentId | null {
  const hosts = useSandboxHosts();
  return (
    (hosts.find((host) => host.snapshot.status === "available") ?? hosts[0])?.hostEnvironmentId ??
    null
  );
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
  const hostEnvironments = hosts.map((host) =>
    environments.find((candidate) => candidate.environmentId === host.hostEnvironmentId),
  );
  return hosts.map((host, index) => {
    const environment = hostEnvironments[index];
    // Two machines can share a name, so a shared one gets its address, as in Settings.
    const shared =
      environment !== undefined &&
      hostEnvironments.some(
        (other) =>
          other !== undefined &&
          other.environmentId !== environment.environmentId &&
          other.label === environment.label,
      );
    return {
      hostEnvironmentId: host.hostEnvironmentId,
      label:
        environment === undefined
          ? "Unknown host"
          : shared
            ? `${environment.label} · ${environment.displayUrl ?? environment.environmentId}`
            : environment.label,
      machine: resolveEnvironmentMachineKind(environment?.serverConfig ?? null),
      offline: environment?.connection.phase !== "connected",
      summary: sandboxHostSummary(host.snapshot),
    };
  });
}
