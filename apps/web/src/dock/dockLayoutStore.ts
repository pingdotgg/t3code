import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import { randomUUID } from "../lib/utils";
import type { RightPanelKind, RightPanelSurface } from "../rightPanelStore";
import type { DockDropTarget } from "./dockDrop";
import {
  CHAT_GROUP_ID,
  collectDockGroupIds,
  createDefaultDockTree,
  insertGroupAtRoot,
  insertGroupBeside,
  PANEL_GROUP_ID,
  parseDockTree,
  pruneDockTree,
  setDockNodeSizes,
  type DockNode,
} from "./dockLayout";

export interface DockLayout {
  readonly root: DockNode;
  /** Where a kind's next tab opens: the group that kind's tab was last dragged to. */
  readonly kindGroups: Readonly<Partial<Record<RightPanelKind, string>>>;
}

interface DockLayoutStoreState extends DockLayout {
  /** The thread whose surfaces the workspace shows; ChatView claims it while mounted. */
  readonly threadRef: ScopedThreadRef | null;
  /** The group a new tab should open in, set by that group's add menu. */
  readonly pendingSurfaceGroupId: string | null;
  setThreadRef: (threadRef: ScopedThreadRef | null) => void;
  setPendingSurfaceGroup: (groupId: string | null) => void;
  setNodeSizes: (sizes: Readonly<Record<string, number>>) => void;
  setKindGroup: (kind: RightPanelKind, groupId: string) => void;
  /** Adds the group a split drop asks for and returns its id. */
  createGroup: (target: Exclude<DockDropTarget, { type: "tabs" }>, id?: string) => string;
  prune: (pinnedGroupIds: Iterable<string>) => void;
  resetLayout: () => void;
}

const DOCK_LAYOUT_STORAGE_KEY = "t3code:dock-layout:v2";

function createInitialLayout(): DockLayout {
  return { root: createDefaultDockTree(), kindGroups: {} };
}

const groupIdsByRoot = new WeakMap<DockNode, ReadonlySet<string>>();

export function dockGroupIds(root: DockNode): ReadonlySet<string> {
  const cached = groupIdsByRoot.get(root);
  if (cached) return cached;
  const ids = new Set(collectDockGroupIds(root));
  groupIdsByRoot.set(root, ids);
  return ids;
}

/** A tab's group: where it was left, else where its kind goes, else the default panel. */
export function resolveSurfaceGroupId(
  surface: Pick<RightPanelSurface, "kind" | "groupId">,
  layout: DockLayout,
): string {
  const ids = dockGroupIds(layout.root);
  // The chat's group holds the chat alone, so it is never a home for tabs.
  const usable = (id: string | undefined): id is string =>
    id !== undefined && id !== CHAT_GROUP_ID && ids.has(id);
  if (usable(surface.groupId)) return surface.groupId;
  const kindGroup = layout.kindGroups[surface.kind];
  return usable(kindGroup) ? kindGroup : PANEL_GROUP_ID;
}

export const useDockLayoutStore = create<DockLayoutStoreState>()(
  persist(
    (set) => ({
      ...createInitialLayout(),
      threadRef: null,
      pendingSurfaceGroupId: null,
      setThreadRef: (threadRef) => set({ threadRef }),
      setPendingSurfaceGroup: (pendingSurfaceGroupId) => set({ pendingSurfaceGroupId }),
      setNodeSizes: (sizes) => set((state) => ({ root: setDockNodeSizes(state.root, sizes) })),
      setKindGroup: (kind, groupId) =>
        set((state) => ({ kindGroups: { ...state.kindGroups, [kind]: groupId } })),
      createGroup: (target, id = `group-${randomUUID()}`) => {
        set((state) => ({
          root:
            target.type === "root"
              ? insertGroupAtRoot(state.root, id, target.edge, target.size)
              : insertGroupBeside(state.root, target.nodeId, id, target.edge, target.size),
        }));
        return id;
      },
      prune: (pinnedGroupIds) =>
        set((state) => ({
          root: pruneDockTree(
            state.root,
            new Set([
              CHAT_GROUP_ID,
              PANEL_GROUP_ID,
              ...Object.values(state.kindGroups),
              ...pinnedGroupIds,
            ]),
          ),
        })),
      resetLayout: () => set(createInitialLayout()),
    }),
    {
      name: DOCK_LAYOUT_STORAGE_KEY,
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ root, kindGroups }) => ({ root, kindGroups }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<DockLayout>;
        const root = parseDockTree(saved.root);
        const ids = root ? dockGroupIds(root) : null;
        if (!root || !ids?.has(PANEL_GROUP_ID) || !ids.has(CHAT_GROUP_ID)) return current;
        return { ...current, root, kindGroups: saved.kindGroups ?? {} };
      },
    },
  ),
);

/** Spends the add menu's choice of group on the tab it opened. */
export function consumePendingSurfaceGroup(): string | null {
  const { pendingSurfaceGroupId, setPendingSurfaceGroup } = useDockLayoutStore.getState();
  if (pendingSurfaceGroupId !== null) setPendingSurfaceGroup(null);
  return pendingSurfaceGroupId;
}
