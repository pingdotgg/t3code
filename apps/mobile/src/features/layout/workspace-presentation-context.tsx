import { createContext, type ReactElement, type ReactNode } from "react";

/** Android's native presentation stack surrounds all workspace columns. */
export const WorkspacePresentationHostContext = createContext(false);
/** Lays out the workspace columns around the navigator's content and its sidebar route. */
export const WorkspaceColumnsRendererContext = createContext<
  ((content: ReactNode, sidebar: ReactNode) => ReactElement) | null
>(null);
