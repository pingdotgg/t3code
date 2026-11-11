import { createContext } from "react";

/**
 * The root the file panel's paths are relative to. Markdown and mentions resolve
 * paths against the agent's cwd, which a subdirectory project's worktree thread
 * nests below this root.
 */
export const FilePanelRootContext = createContext<string | undefined>(undefined);
