import { createContext, useContext } from "react";

export type LinearLaunchWorkspace = "worktree" | "local";

/** What the issue detail panel can start. Provided by the launch flows (`useLinearLaunch`). */
export interface LinearLaunchActions {
  startChat(issueId: string, options?: { workspace?: LinearLaunchWorkspace }): void;
  openPipelineDialog(issueId: string, pipelineId?: string): void;
}

const LinearLaunchActionsContext = createContext<LinearLaunchActions | null>(null);

export const LinearLaunchActionsProvider = LinearLaunchActionsContext.Provider;

/** Null while no launch provider is mounted; the panel then disables its launch controls. */
export function useLinearLaunchActions(): LinearLaunchActions | null {
  return useContext(LinearLaunchActionsContext);
}
