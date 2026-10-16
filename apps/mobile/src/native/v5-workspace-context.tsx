import { createContext, type ReactNode } from "react";

export const NativeWorkspaceModeContext = createContext(false);
/** Retained tabs must not update another tab's navigation options. */
export const NativeWorkspaceTabActivityContext = createContext<{
  readonly active: boolean;
  readonly isActive: () => boolean;
} | null>(null);
export const NativePrimaryColumnContext = createContext<{
  readonly selectedThreadKey: string | null;
  readonly selectedPullRequestKey: string | null;
} | null>(null);
export const NativeWorkspaceInspectorContext = createContext<{
  readonly render: (() => ReactNode) | undefined;
  readonly visible: boolean;
}>({ render: undefined, visible: false });
