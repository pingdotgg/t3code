import type { ThreadFilePathIndex } from "@t3tools/shared/threadFilePaths";
import { createContext } from "react";

/** Paths the active thread's tool activity named; file chips in its timeline resolve against them. */
export const ThreadFilePathsContext = createContext<ThreadFilePathIndex | null>(null);
