import type { SidebarProps } from "./sidebarTypes";
import { useSidebarLookupState } from "./useSidebarLookupState";
import { useSidebarScopeState } from "./useSidebarScopeState";
import { useSidebarSearchState } from "./useSidebarSearchState";
import { useSidebarDragState } from "./useSidebarDragState";
import { useSidebarSnoozeState } from "./useSidebarSnoozeState";
import { useSidebarMenuState } from "./useSidebarMenuState";
import { useSidebarRouteState } from "./useSidebarRouteState";

/** Everything the sidebar view renders, composed phase by phase. */
export function useSidebarState(props: SidebarProps) {
  const s1 = useSidebarLookupState(props);
  const s2 = useSidebarScopeState(props, { s1 });
  const s3 = useSidebarSearchState(props, { s1, s2 });
  const s4 = useSidebarDragState(props, { s1, s2, s3 });
  const s5 = useSidebarSnoozeState(props, { s1, s3 });
  const s6 = useSidebarMenuState(props, { s1, s2, s3, s4, s5 });
  const s7 = useSidebarRouteState(props, { s1, s2, s3 });
  return { ...s1, ...s2, ...s3, ...s4, ...s5, ...s6, ...s7 };
}
