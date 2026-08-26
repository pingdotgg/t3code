import type { ShellRightPanelState } from "@t3tools/contracts";

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

export function buildEmbedPath(environmentId: string, threadId: string): string {
  return `/embed/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`;
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
