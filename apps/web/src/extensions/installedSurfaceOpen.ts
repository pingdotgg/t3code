import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import type { SurfaceDescriptor } from "@t3tools/extension-sdk/contracts";
import {
  extensionPanelSurface,
  selectThreadExtensionDock,
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../rightPanelStore";
import { installedSurfaceRecord, installedWorkspaceContext } from "./installedContext";
import type { InstalledPackage } from "./installedController";

/**
 * Opens an installation's surface on a thread the way the Open menu does: an
 * identical live surface is activated, a changed record replaces it. False
 * when the store refuses the record.
 */
export function openInstalledSurface(
  deps: { readonly environmentId: string; readonly client: string },
  ref: ScopedThreadRef,
  installationId: string,
  surface: SurfaceDescriptor,
  placement: "side-panel" | "bottom-dock",
  scope: { projectId: ProjectId; workspaceRoot: string; worktreePath: string | null },
): boolean {
  const store = useRightPanelStore.getState();
  const context = installedWorkspaceContext({
    environmentId: deps.environmentId,
    projectId: scope.projectId,
    threadId: ref.threadId,
    projectWorkspaceRoot: scope.workspaceRoot,
    threadWorktreePath: scope.worktreePath,
    client: deps.client,
  });
  const record = installedSurfaceRecord(installationId, surface, placement, context);
  const requested = extensionPanelSurface(ref, record);
  if (!requested) return false;
  const layout =
    placement === "bottom-dock"
      ? selectThreadExtensionDock(store.extensionDockByThreadKey, ref)
      : selectThreadRightPanelState(store.byThreadKey, ref);
  const existing = layout.surfaces.find((entry) => entry.id === requested.id);
  if (
    existing?.kind === "extension" &&
    existing.record.version === requested.record.version &&
    existing.record.stateVersion === requested.record.stateVersion &&
    existing.record.placement === requested.record.placement &&
    existing.record.context.client === requested.record.context.client &&
    existing.record.context.workspaceRevision === requested.record.context.workspaceRevision
  ) {
    if (placement === "bottom-dock") store.activateDockExtension(ref, existing.id);
    else store.activateSurface(ref, existing.id);
    return true;
  }
  return store.openExtension(ref, record);
}

/** The Agents pack's roster surface; native Agents entry points defer to it when installed. */
export const AGENTS_PACK_SURFACE_ID = "t3.agents/view";

/**
 * The installed side-panel surface a native thread entry point should open
 * instead of its built-in panel: an enabled installation granted this project
 * that declares `surfaceId` as a thread-scoped side panel for this client.
 * First match in installation order; null means "use the native panel".
 */
export function findInstalledThreadSurface(
  installations: readonly InstalledPackage[],
  surfaceId: string,
  projectId: string,
  client: string,
): { readonly installationId: string; readonly surface: SurfaceDescriptor } | null {
  for (const installation of installations) {
    if (!installation.enabled || !installation.grants.projectIds.some((id) => id === projectId))
      continue;
    const surface = installation.package.manifest.surfaces.find(
      (candidate) =>
        candidate.id === surfaceId &&
        candidate.scope === "thread" &&
        candidate.placements.includes("side-panel") &&
        candidate.clients.includes(client),
    );
    if (surface) return { installationId: installation.id, surface };
  }
  return null;
}

/** True while the Agents roster (native panel or the pack's surface) is the active panel tab. */
export function isAgentsRosterSurface(surface: RightPanelSurface | null | undefined): boolean {
  return (
    surface?.kind === "agents" ||
    (surface?.kind === "extension" && surface.record.surfaceId === AGENTS_PACK_SURFACE_ID)
  );
}
