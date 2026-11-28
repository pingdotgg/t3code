import { createContext, type ReactElement, type ReactNode } from "react";

/** Android's native presentation stack surrounds all workspace columns. */
export const WorkspacePresentationHostContext = createContext(false);
/** Lays out the workspace columns around the navigator's content and its sidebar route. */
export const WorkspaceColumnsRendererContext = createContext<
  ((content: ReactNode, sidebar: ReactNode) => ReactElement) | null
>(null);
/**
 * The workspace route on top, under any presented overlays. A screen blurred by an overlay is still
 * this route, so the workspace columns beside it keep their layout under the overlay.
 */
export const WorkspaceVisibleRouteContext = createContext<string | null>(null);
