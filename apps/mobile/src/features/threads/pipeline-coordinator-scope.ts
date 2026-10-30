import { createContext } from "react";

/** True inside the coordinator sheet, where the thread shows a compact run header, not the panel. */
export const PipelineCoordinatorScopeContext = createContext(false);
