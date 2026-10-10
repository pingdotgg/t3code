import { createContext, type ReactNode } from "react";

// The router is shared with the other platforms; only iOS uses native columns.
export const NativeWorkspaceModeContext = createContext(false);
export const NativePrimaryColumnContext = createContext<{
  readonly selectedThreadKey: string | null;
} | null>(null);
export const NativeWorkspaceInspectorContext = createContext<{
  readonly render: (() => ReactNode) | undefined;
  readonly visible: boolean;
}>({ render: undefined, visible: false });
