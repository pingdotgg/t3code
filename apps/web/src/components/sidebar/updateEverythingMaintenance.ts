import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import type { Atom, AtomRegistry } from "effect/reactivity";

export interface HostedMaintenanceSnapshot {
  readonly ready: boolean;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly localEnvironmentDisabled: boolean;
  readonly machines: readonly {
    readonly hostedByThisApp: boolean;
    readonly connected: boolean;
    readonly sessionReady: boolean;
    readonly providers: readonly Pick<ServerProvider, "updateState">[];
  }[];
}

export type HostedProviderWorkSnapshot = Omit<HostedMaintenanceSnapshot, "machines"> & {
  readonly machines: readonly (Omit<HostedMaintenanceSnapshot["machines"][number], "providers"> & {
    readonly environmentId: EnvironmentId;
    readonly providers: readonly Pick<ServerProvider, "instanceId" | "updateState">[];
  })[];
};

export function isHostedMaintenanceReady(snapshot: HostedMaintenanceSnapshot): boolean {
  const hosted = snapshot.machines.filter((machine) => machine.hostedByThisApp);
  return (
    snapshot.ready &&
    (hosted.length > 0 ||
      (snapshot.primaryEnvironmentId === null && snapshot.localEnvironmentDisabled)) &&
    hosted.every(
      (machine) =>
        machine.connected &&
        machine.sessionReady &&
        machine.providers.every(
          (provider) =>
            provider.updateState?.status !== "queued" && provider.updateState?.status !== "running",
        ),
    )
  );
}

export function waitForHostedMaintenance(
  registry: AtomRegistry.AtomRegistry,
  source: Atom.Atom<HostedMaintenanceSnapshot>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let unsubscribe = () => {};
    const inspect = () => {
      const snapshot = registry.get(source);
      const hosted = snapshot.machines.filter((machine) => machine.hostedByThisApp);
      if (
        !snapshot.ready ||
        (hosted.length === 0 &&
          (snapshot.primaryEnvironmentId !== null || !snapshot.localEnvironmentDisabled)) ||
        hosted.some((machine) => !machine.connected || !machine.sessionReady)
      ) {
        unsubscribe();
        reject(new Error("A local connection is not ready"));
        return;
      }
      if (!isHostedMaintenanceReady(snapshot)) return;
      unsubscribe();
      resolve();
    };
    unsubscribe = registry.subscribe(source, inspect);
    inspect();
  });
}

export function waitForHostedProviderWork(
  registry: AtomRegistry.AtomRegistry,
  source: Atom.Atom<HostedProviderWorkSnapshot>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let observedBusy = false;
    const pending = new Set<string>();
    let unsubscribe = () => {};
    const inspect = () => {
      const snapshot = registry.get(source);
      const hosted = snapshot.machines.filter((machine) => machine.hostedByThisApp);
      const providers = new Map(
        hosted.flatMap((machine) =>
          machine.providers.map(
            (provider) =>
              [
                JSON.stringify([machine.environmentId, provider.instanceId]),
                { machine, provider },
              ] as const,
          ),
        ),
      );
      for (const [key, { provider }] of providers) {
        if (
          provider.updateState?.status === "queued" ||
          provider.updateState?.status === "running"
        ) {
          observedBusy = true;
          pending.add(key);
        }
      }
      for (const key of pending) {
        const current = providers.get(key);
        const status = current?.provider.updateState?.status;
        if (status === "queued" || status === "running") continue;
        if (
          (status !== "succeeded" && status !== "failed" && status !== "unchanged") ||
          !snapshot.ready ||
          !current?.machine.connected ||
          !current.machine.sessionReady
        ) {
          unsubscribe();
          reject(new Error("A local connection is not ready"));
          return;
        }
        pending.delete(key);
      }
      if (pending.size > 0) return;
      unsubscribe();
      if (observedBusy && !isHostedMaintenanceReady(snapshot)) {
        reject(new Error("A local connection is not ready"));
        return;
      }
      resolve();
    };
    unsubscribe = registry.subscribe(source, inspect);
    inspect();
  });
}
