import { createContext, use } from "react";
import type { SharedValue } from "react-native-reanimated";

// Controls follow the visible pane; keep the expensive navigator/feed at settled width during transitions.
export const WorkspaceContentWidthContext = createContext<SharedValue<number> | null>(null);

export function useWorkspaceContentWidth() {
  return use(WorkspaceContentWidthContext);
}

// The settled width itself. The feed lays its rows out at this width in the same commit that
// resizes the pane; waiting for its own onLayout re-measured every row twice, once against the
// old text widths, and the list jumped while it repositioned them.
export const WorkspaceSettledContentWidthContext = createContext<number | null>(null);

export function useWorkspaceSettledContentWidth() {
  return use(WorkspaceSettledContentWidthContext);
}
