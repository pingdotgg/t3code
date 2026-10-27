import { createContext, type ReactElement, type ReactNode } from "react";

/** Android's native presentation stack surrounds all workspace columns. */
export const WorkspacePresentationHostContext = createContext(false);
export const WorkspaceColumnsRendererContext = createContext<
  ((children: ReactNode) => ReactElement) | null
>(null);
