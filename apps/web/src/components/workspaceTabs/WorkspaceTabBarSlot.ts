import { createContext, type ReactNode } from "react";

/** The thread tab bar, shown by the route's ChatView under its header. */
export const WorkspaceTabBarSlot = createContext<ReactNode>(null);
