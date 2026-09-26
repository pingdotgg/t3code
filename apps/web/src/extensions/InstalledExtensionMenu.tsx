import { installedSurfaceRecord } from "./installedContext";
import { useState } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import type { ViewContext } from "@t3tools/extension-sdk/contracts";
import { Button } from "../components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../components/ui/menu";
import {
  extensionPanelSurface,
  selectThreadExtensionDock,
  selectThreadRightPanelState,
  useRightPanelStore,
} from "../rightPanelStore";
import { useInstalledExtensions } from "./installedEnvironment";

export function InstalledExtensionMenu({
  threadRef,
  context,
}: {
  threadRef: ScopedThreadRef;
  context: ViewContext;
}) {
  const snapshot = useInstalledExtensions(threadRef.environmentId);
  const [error, setError] = useState<string | null>(null);
  const surfaces = snapshot.installations
    .filter(
      (item) =>
        item.enabled && item.grants.projectIds.some((id) => id === context.resource.projectId),
    )
    .flatMap((item) =>
      item.package.manifest.surfaces
        .filter((surface) => surface.clients.includes(context.client))
        .flatMap((surface) =>
          surface.placements
            .filter((placement) => placement === "side-panel" || placement === "bottom-dock")
            .map((placement) => ({ item, surface, placement })),
        ),
    );
  if (!surfaces.length) return null;
  return (
    <Menu>
      <MenuTrigger render={<Button variant="ghost" size="sm" />}>Extensions</MenuTrigger>
      <MenuPopup align="end">
        {surfaces.map(({ item, surface, placement }) => (
          <MenuItem
            key={surface.id + placement}
            onClick={() => {
              const record = installedSurfaceRecord(item.id, surface, placement, context);
              try {
                const store = useRightPanelStore.getState();
                const requested = extensionPanelSurface(threadRef, record);
                if (!requested) throw new Error("Could not open extension in this workspace");
                const layout =
                  placement === "bottom-dock"
                    ? selectThreadExtensionDock(store.extensionDockByThreadKey, threadRef)
                    : selectThreadRightPanelState(store.byThreadKey, threadRef);
                const existing = layout.surfaces.find((entry) => entry.id === requested.id);
                // Ordinary Open selects a saved compatible viewer; explicit replacement remains
                // available to producers through openExtension for changed scope or schema.
                if (
                  existing?.kind === "extension" &&
                  existing.record.version === requested.record.version &&
                  existing.record.stateVersion === requested.record.stateVersion &&
                  existing.record.placement === requested.record.placement &&
                  existing.record.context.client === requested.record.context.client &&
                  existing.record.context.workspaceRevision ===
                    requested.record.context.workspaceRevision
                ) {
                  if (placement === "bottom-dock")
                    store.activateDockExtension(threadRef, existing.id);
                  else store.activateSurface(threadRef, existing.id);
                } else if (!store.openExtension(threadRef, record)) {
                  throw new Error("Could not open extension in this workspace");
                }
                setError(null);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : "Extension unavailable");
              }
            }}
          >
            Open {surface.title} · {placement === "side-panel" ? "Side panel" : "Bottom dock"}
          </MenuItem>
        ))}
        {error ? (
          <p role="alert" className="max-w-64 px-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
