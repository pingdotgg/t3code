import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import {
  createProviderWorkspaceSnapshotRefreshAtomFamily,
  isProviderWorkspaceSnapshotScanning,
  type ProviderWorkspaceSnapshotRefreshState,
} from "@t3tools/client-runtime/providerSkills";
import type { EnvironmentId, ProviderInstanceId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { serverEnvironment } from "../state/server";

const snapshotRefresh = createProviderWorkspaceSnapshotRefreshAtomFamily({
  providers: serverEnvironment.providersValueAtom,
  refreshProviders: serverEnvironment.refreshProviders,
});

const idle = Atom.make<ProviderWorkspaceSnapshotRefreshState | undefined>(undefined).pipe(
  Atom.withLabel("provider-workspace-snapshot-refresh:idle"),
);

/**
 * Keeps the instance's skills and commands for the orchestrator's folder fresh while the composer
 * is mounted, since a project's own `.claude` folder adds to what the machine lists. The engine
 * answers the first read with a scan, and `refresh` asks again.
 */
export function useWorkspaceSnapshot(
  environmentId: EnvironmentId,
  instanceId: ProviderInstanceId | undefined,
  cwd: string,
) {
  const atom =
    instanceId === undefined ? idle : snapshotRefresh({ environmentId, instanceId, cwd });
  return {
    refresh: useAtomRefresh(atom),
    scanning: isProviderWorkspaceSnapshotScanning(useAtomValue(atom)),
  };
}
