import { createContext, type ReactNode } from "react";

export const NativeWorkspaceModeContext = createContext(false);
/**
 * Each workspace tab slot renders the same routes, so header options a screen sets are kept per
 * slot (by route key) instead of on the shared route: a slot's header then never shows options
 * another slot set, and switching tabs has nothing left to update.
 */
export interface WorkspaceSlotOptions {
  readonly byRoute: ReadonlyMap<string, object>;
  readonly set: (routeKey: string, options: object) => void;
}
export const WorkspaceSlotOptionsContext = createContext<WorkspaceSlotOptions | null>(null);

/** A route's options with whatever its screens set within this slot on top. */
export function slotScreenOptions<Options extends object>(
  slot: WorkspaceSlotOptions | null,
  routeKey: string | undefined,
  options: Options,
): Options {
  const own = routeKey === undefined ? undefined : slot?.byRoute.get(routeKey);
  return own ? { ...options, ...own } : options;
}

/** Retained tabs must not update another tab's navigation options. */
export const NativeWorkspaceTabActivityContext = createContext<{
  readonly active: boolean;
  readonly isActive: () => boolean;
} | null>(null);
export const NativePrimaryColumnContext = createContext<{
  readonly presented: boolean;
  readonly selectedThreadKey: string | null;
  readonly selectedPullRequestKey: string | null;
} | null>(null);
export const NativeWorkspaceInspectorContext = createContext<{
  readonly render: (() => ReactNode) | undefined;
  readonly visible: boolean;
}>({ render: undefined, visible: false });
