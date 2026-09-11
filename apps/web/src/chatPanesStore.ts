import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useChatPaneDragStore } from "./chatPaneDragStore";
import {
  clampPaneRatio,
  collectLeaves,
  findLeaf,
  findNode,
  removePane,
  selectChatPaneRoot,
  setPaneRatio,
  setPaneSurface,
  splitPane,
  type ChatPaneId,
  type ChatPaneLeaf,
  type ChatPaneNode,
  type DropZone,
} from "./chatPanes.logic";
import { randomUUID } from "./lib/utils";
import { resolveStorage } from "./lib/storage";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "./rightPanelStore";

/**
 * The split layouts of one browser window. Each group is a tree of splits; a
 * thread belongs to at most one group. The route stays the source of truth
 * for the focused thread; this store only remembers which other threads sit
 * beside it and how the space is divided. A group that collapses to one pane
 * is the plain chat view, so it is dropped as soon as that happens.
 */

// A pane whose persisted surface no longer matches renders nothing; close still works.
const LeafSchema = Schema.Struct({
  kind: Schema.Literal("leaf"),
  id: Schema.String,
  threadRef: Schema.Struct({ environmentId: EnvironmentId, threadId: ThreadId }),
  surface: Schema.optionalKey(Schema.Unknown),
});
const NodeSchema: Schema.Codec<ChatPaneNode> = Schema.Union([
  LeafSchema,
  Schema.Struct({
    kind: Schema.Literal("split"),
    id: Schema.String,
    direction: Schema.Literals(["horizontal", "vertical"]),
    ratio: Schema.Finite.check(Schema.makeFilter((ratio) => ratio === clampPaneRatio(ratio))),
    first: Schema.suspend(() => NodeSchema),
    second: Schema.suspend(() => NodeSchema),
  }),
]) as Schema.Codec<ChatPaneNode>;
const PersistedSchema = Schema.Struct({
  groups: Schema.Array(NodeSchema),
  focusedPaneId: Schema.NullOr(Schema.String),
});
const decodePersisted = Schema.decodeUnknownSync(PersistedSchema);

/** What a new pane shows: a thread's chat, or one of that thread's panels. */
export interface ChatPaneContent {
  readonly threadRef: ScopedThreadRef;
  readonly surface?: RightPanelSurface;
}

interface ChatPanesState {
  groups: ReadonlyArray<ChatPaneNode>;
  focusedPaneId: ChatPaneId | null;
  focusPane: (paneId: ChatPaneId) => void;
  /** Splits the pane `targetId`, or the whole layout when it names a root, showing `content` on the dropped side. */
  dropContent: (targetId: ChatPaneId, zone: DropZone, content: ChatPaneContent) => void;
  /** Starts a new group from a thread shown on its own. */
  splitFromThread: (anchorRef: ScopedThreadRef, zone: DropZone, content: ChatPaneContent) => void;
  /** Moves an open pane next to another pane or layout edge, in any group. */
  movePane: (paneId: ChatPaneId, targetId: ChatPaneId, zone: DropZone) => void;
  /**
   * Removes a leaf. Returns the thread the route should move to when the
   * focused pane closed, so the caller can navigate before the layout
   * collapses, or null when the route is unaffected.
   */
  closePane: (paneId: ChatPaneId) => ScopedThreadRef | null;
  closeThread: (threadRef: ScopedThreadRef) => ScopedThreadRef | null;
  /** Closes the pane showing `surfaceId` for `threadRef`, if any; the survivor when it had focus. */
  closeSurface: (threadRef: ScopedThreadRef, surfaceId: string) => ScopedThreadRef | null;
  /**
   * Rewrites the panel state a pane owns. A surface shown as a pane is gone
   * from the right panel store, so its own store is the only thing that can
   * record what happens inside it, such as splitting a terminal group.
   */
  updateSurface: (
    threadRef: ScopedThreadRef,
    surfaceId: string,
    update: (surface: RightPanelSurface) => RightPanelSurface,
  ) => void;
  setRatio: (splitId: ChatPaneId, ratio: number) => void;
}

function findGroup(groups: ReadonlyArray<ChatPaneNode>, nodeId: ChatPaneId) {
  return groups.find((group) => findNode(group, nodeId) !== null) ?? null;
}

/** The pane already showing `threadRef`'s chat, or its surface `surfaceId`, in any group. */
function findContent(
  groups: ReadonlyArray<ChatPaneNode>,
  threadRef: ScopedThreadRef,
  surfaceId?: string,
) {
  return groups.map((group) => findLeaf(group, threadRef, surfaceId)).find(Boolean) ?? null;
}

function newLeaf(content: ChatPaneContent): ChatPaneLeaf {
  return { kind: "leaf", id: randomUUID(), ...content };
}

/** Swaps one group for its replacement and drops every group down to one
    pane: `to` after a close, and the source movePane already shrank. A group
    of surfaces alone goes too: no route reaches it, so it would just linger. */
function replaceGroup(groups: ReadonlyArray<ChatPaneNode>, from: ChatPaneNode, to: ChatPaneNode) {
  return groups
    .map((group) => (group === from ? to : group))
    .filter(
      (group) => group.kind === "split" && collectLeaves(group).some((leaf) => !leaf.surface),
    );
}

function closeLeaf(
  set: (partial: Partial<ChatPanesState>) => void,
  state: Pick<ChatPanesState, "groups" | "focusedPaneId">,
  paneId: ChatPaneId,
): ScopedThreadRef | null {
  const group = findGroup(state.groups, paneId);
  const root = group ? removePane(group, paneId) : null;
  if (!group || !root) return null;
  const survivor = collectLeaves(root)[0]!;
  const focusedClosed = state.focusedPaneId === paneId;
  set({
    groups: replaceGroup(state.groups, group, root),
    focusedPaneId: focusedClosed ? survivor.id : state.focusedPaneId,
  });
  return focusedClosed ? survivor.threadRef : null;
}

export const useChatPanesStore = create<ChatPanesState>()(
  persist(
    (set, get) => ({
      groups: [],
      focusedPaneId: null,
      focusPane: (paneId) =>
        set((state) => (state.focusedPaneId === paneId ? state : { focusedPaneId: paneId })),
      dropContent: (targetId, zone, content) =>
        set((state) => {
          const group = findGroup(state.groups, targetId);
          if (!group || findContent(state.groups, content.threadRef, content.surface?.id))
            return state;
          const leaf = newLeaf(content);
          const root = splitPane(group, targetId, zone, leaf, randomUUID());
          return { groups: replaceGroup(state.groups, group, root), focusedPaneId: leaf.id };
        }),
      splitFromThread: (anchorRef, zone, content) =>
        set((state) => {
          if (
            (!content.surface &&
              scopedThreadKey(anchorRef) === scopedThreadKey(content.threadRef)) ||
            selectChatPaneRoot(state.groups, anchorRef) ||
            findContent(state.groups, content.threadRef, content.surface?.id)
          ) {
            return state;
          }
          const anchor = newLeaf({ threadRef: anchorRef });
          const leaf = newLeaf(content);
          const root = splitPane(anchor, anchor.id, zone, leaf, randomUUID());
          return { groups: [...state.groups, root], focusedPaneId: leaf.id };
        }),
      movePane: (paneId, targetId, zone) =>
        set((state) => {
          if (paneId === targetId) return state;
          const source = findGroup(state.groups, paneId);
          const leaf = source && findNode(source, paneId);
          if (!source || leaf?.kind !== "leaf") return state;
          const without = removePane(source, paneId)!;
          const groups = state.groups.map((group) => (group === source ? without : group));
          // Pulling the pane out can collapse its own root; a drop on that
          // root's edge then means the survivor.
          const resolvedTargetId = targetId === source.id ? without.id : targetId;
          const target = findGroup(groups, resolvedTargetId);
          if (!target) return state;
          const root = splitPane(target, resolvedTargetId, zone, leaf, randomUUID());
          return { groups: replaceGroup(groups, target, root), focusedPaneId: leaf.id };
        }),
      closePane: (paneId) => closeLeaf(set, get(), paneId),
      closeThread: (threadRef) => {
        const state = get();
        const leaf = findContent(state.groups, threadRef);
        return leaf ? closeLeaf(set, state, leaf.id) : null;
      },
      closeSurface: (threadRef, surfaceId) => {
        const state = get();
        const leaf = findContent(state.groups, threadRef, surfaceId);
        return leaf ? closeLeaf(set, state, leaf.id) : null;
      },
      updateSurface: (threadRef, surfaceId, update) =>
        set((state) => {
          const leaf = findContent(state.groups, threadRef, surfaceId);
          if (!leaf?.surface) return state;
          const surface = update(leaf.surface);
          if (surface === leaf.surface) return state;
          return { groups: state.groups.map((group) => setPaneSurface(group, leaf.id, surface)) };
        }),
      setRatio: (splitId, ratio) =>
        set((state) => {
          const groups = state.groups.map((group) => setPaneRatio(group, splitId, ratio));
          return groups.every((group, index) => group === state.groups[index]) ? state : { groups };
        }),
    }),
    {
      name: "t3code:chat-panes:v2",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ groups: state.groups, focusedPaneId: state.focusedPaneId }),
      merge: (persisted, current) => {
        try {
          const { groups, focusedPaneId } = decodePersisted(persisted);
          return {
            ...current,
            groups: groups.filter((group) => group.kind === "split"),
            focusedPaneId,
          };
        } catch {
          return current;
        }
      },
    },
  ),
);

/**
 * Applies the drop the drag store is pointing at. A drop on the plain chat
 * view starts a new group from the route thread. Returns the thread that
 * should become the route so the caller can navigate to it.
 */
export function commitChatPaneDrop(routeThreadRef: ScopedThreadRef): ScopedThreadRef | null {
  const drag = useChatPaneDragStore.getState();
  const { content, target, sourcePaneId, create } = drag;
  drag.end();
  if (!content || !target) return null;
  const place = (placed: ChatPaneContent) => {
    const store = useChatPanesStore.getState();
    const before = store.groups;
    if (sourcePaneId !== null) {
      store.movePane(sourcePaneId, target.paneId, target.zone);
    } else {
      // No pane matched the target: the drop landed on a thread shown alone.
      store.dropContent(target.paneId, target.zone, placed);
      if (useChatPanesStore.getState().groups === before) {
        store.splitFromThread(routeThreadRef, target.zone, placed);
      }
    }
    if (useChatPanesStore.getState().groups !== before && placed.surface && sourcePaneId === null) {
      detachSurfaceFromPanel(placed);
    }
  };
  // A launcher card creates its tab first; the pane opens once it exists.
  if (create) placeCreatedSurface(content.threadRef, create, place);
  else place(content);
  return create ? null : content.threadRef;
}

/** A panel surface now lives in a pane: its tab leaves the docked panel, which hides. */
function detachSurfaceFromPanel(content: ChatPaneContent) {
  if (!content.surface) return;
  useRightPanelStore.getState().closeSurface(content.threadRef, content.surface.id);
  useRightPanelStore.getState().close(content.threadRef);
}

/**
 * Runs a right-panel add action and hands the tab it adds to `place`: at once
 * for singleton surfaces, or once an async open (browser session) lands.
 * Nothing happens when the action adds no tab, as when it opens a setup dialog.
 */
function placeCreatedSurface(
  threadRef: ScopedThreadRef,
  create: () => void,
  place: (content: ChatPaneContent) => void,
) {
  const surfaces = () =>
    selectThreadRightPanelState(useRightPanelStore.getState().byThreadKey, threadRef).surfaces;
  const seen = new Set(surfaces().map((surface) => surface.id));
  const added = () => surfaces().find((surface) => !seen.has(surface.id)) ?? null;
  create();
  const now = added();
  if (now) return place({ threadRef, surface: now });
  const unsubscribe = useRightPanelStore.subscribe(() => {
    const surface = added();
    if (!surface) return;
    stop();
    place({ threadRef, surface });
  });
  // The next press means the action opened a dialog the user dealt with, so
  // whatever surface they add afterwards is their own, not this one's result.
  const stop = () => {
    unsubscribe();
    clearTimeout(timeout);
    document.removeEventListener("pointerdown", stop, true);
  };
  document.addEventListener("pointerdown", stop, true);
  const timeout = setTimeout(stop, 15_000);
}

/** Pane header "+": runs `create` and opens the tab it adds as a pane beside the thread. */
export function openCreatedSurfaceInSplit(threadRef: ScopedThreadRef, create: () => void) {
  placeCreatedSurface(threadRef, create, (content) => {
    openInSplit(threadRef, content);
    detachSurfaceFromPanel(content);
  });
}

/** Whether "Open in split view" can place `content` beside the route thread right now. */
export function canOpenInSplit(
  routeThreadRef: ScopedThreadRef | null,
  content: ChatPaneContent,
): boolean {
  if (!routeThreadRef) return false;
  if (!content.surface && scopedThreadKey(routeThreadRef) === scopedThreadKey(content.threadRef)) {
    return false;
  }
  return !findContent(useChatPanesStore.getState().groups, content.threadRef, content.surface?.id);
}

/** Opens `content` to the right of the focused pane, starting a new group from the route thread when needed. */
export function openInSplit(routeThreadRef: ScopedThreadRef | null, content: ChatPaneContent) {
  if (!canOpenInSplit(routeThreadRef, content)) return false;
  const state = useChatPanesStore.getState();
  const group = selectChatPaneRoot(state.groups, routeThreadRef);
  if (group) {
    const leaves = collectLeaves(group);
    const anchor = leaves.find((leaf) => leaf.id === state.focusedPaneId) ?? leaves[0]!;
    state.dropContent(anchor.id, "right", content);
  } else {
    state.splitFromThread(routeThreadRef!, "right", content);
  }
  return useChatPanesStore.getState().groups !== state.groups;
}
