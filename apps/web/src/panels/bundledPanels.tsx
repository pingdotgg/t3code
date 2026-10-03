import type { ScopedThreadRef } from "@t3tools/contracts";
import type { DraftId } from "~/composerDraftStore";

import { createPanelRegistry } from "./panelRegistry";

export interface SidePanelProps {
  composerDraftTarget: ScopedThreadRef | DraftId;
  workspaceMutationId: string | null;
}

const bundledPanels = createPanelRegistry<SidePanelProps, "diff">([
  {
    id: "diff",
    title: "Diff",
    placement: "side-panel",
    load: () => import("./diff/DiffSidePanel"),
  },
]);

export function RegisteredSidePanel({
  id,
  ...props
}: SidePanelProps & { id: Parameters<typeof bundledPanels.get>[0] }) {
  const panel = bundledPanels.get(id);
  if (!panel) throw new Error(`Unknown panel id: ${id}`);
  const Component = panel.Component;
  return <Component {...props} />;
}
