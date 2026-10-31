import type { LinearLaunchActions } from "@t3tools/client-runtime/linear/launch-plan";
import { createContext, useContext } from "react";

const LinearLaunchActionsContext = createContext<LinearLaunchActions | null>(null);

export const LinearLaunchActionsProvider = LinearLaunchActionsContext.Provider;

/** Null while no launch provider is mounted; the panel then disables its launch controls. */
export function useLinearLaunchActions(): LinearLaunchActions | null {
  return useContext(LinearLaunchActionsContext);
}
