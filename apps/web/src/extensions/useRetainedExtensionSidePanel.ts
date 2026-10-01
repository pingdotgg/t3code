import { useState } from "react";
import type { ExtensionPanelSurface, RightPanelSurface } from "../rightPanelStore";

/** Hide retains only the viewer actually shown in this thread; closing never opens its successor. */
export function useRetainedExtensionSidePanel(
  scope: string | null,
  open: boolean,
  selected: RightPanelSurface | null,
  surfaces: readonly RightPanelSurface[],
): ExtensionPanelSurface | null {
  const candidate =
    selected?.kind === "extension" && selected.record.placement === "side-panel" ? selected : null;
  const [retained, setRetained] = useState({ scope, surface: open ? candidate : null });
  if (retained.scope !== scope || (open && retained.surface !== candidate)) {
    setRetained({ scope, surface: open ? candidate : null });
  }
  if (open) return candidate;
  if (retained.scope !== scope || !retained.surface) return null;
  const previous = retained.surface;
  return (
    surfaces.find(
      (surface): surface is ExtensionPanelSurface =>
        surface.kind === "extension" &&
        surface.record.placement === "side-panel" &&
        surface.id === previous.id &&
        surface.viewerGeneration === previous.viewerGeneration,
    ) ?? null
  );
}
