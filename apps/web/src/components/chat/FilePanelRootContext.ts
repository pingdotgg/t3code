import { createContext } from "react";

/** The root file panel paths are relative to; an agent in a project subdirectory works below it. */
export const FilePanelRootContext = createContext<string | undefined>(undefined);
