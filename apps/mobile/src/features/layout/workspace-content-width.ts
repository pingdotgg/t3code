import { createContext, use } from "react";
import type { SharedValue } from "react-native-reanimated";

// Floating controls follow the visible pane while the expensive navigator/feed
// stays laid out at its settled width during sidebar and inspector transitions.
export const WorkspaceContentWidthContext = createContext<SharedValue<number> | null>(null);

export function useWorkspaceContentWidth() {
  return use(WorkspaceContentWidthContext);
}
