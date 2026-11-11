import { createContext } from "react";

/** The thread's workspace mutation id, so a host image the agent rewrites gets a fresh URL. */
export const WorkspaceMutationIdContext = createContext<string | null | undefined>(undefined);
