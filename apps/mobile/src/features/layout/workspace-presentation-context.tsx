import { createContext, type ReactNode } from "react";

/** Android's native presentation stack surrounds all workspace columns. */
export const WorkspacePresentationHostContext = createContext(false);
export const WorkspaceColumnsRendererContext = createContext<
  ((children: ReactNode) => ReactNode) | null
>(null);
