import type { ShellRightPanelState } from "@t3tools/contracts/shell";

import type { RightPanelSurface } from "../rightPanelStore";

export interface ShellRightPanelStateInput {
  readonly threadKey: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly isOpen: boolean;
  readonly activeSurfaceId: string | null;
  readonly surfaces: ReadonlyArray<RightPanelSurface>;
  readonly titleFor: (surface: RightPanelSurface) => string;
  readonly canAdd: ShellRightPanelState["canAdd"];
}

/** The thread's embed route: the right panel's content, or the terminal drawer's. */
export function buildEmbedPath(
  environmentId: string,
  threadId: string,
  surface: "panel" | "terminal" = "panel",
): string {
  const path = `/embed/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
  return surface === "terminal" ? `${path}?surface=terminal` : path;
}

export function buildShellRightPanelState(input: ShellRightPanelStateInput): ShellRightPanelState {
  return {
    threadKey: input.threadKey,
    isOpen: input.isOpen,
    activeSurfaceId: input.activeSurfaceId,
    surfaces: input.surfaces.map((surface) => ({
      id: surface.id,
      kind: surface.kind,
      title: input.titleFor(surface),
    })),
    canAdd: input.canAdd,
    embedPath: buildEmbedPath(input.environmentId, input.threadId),
  };
}
