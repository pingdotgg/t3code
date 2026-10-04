import { useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  useRightPanelStore,
  type RightPanelSurface,
  type ThreadRightPanelState,
} from "~/rightPanelStore";
import {
  activateWorkspaceSurface,
  CONVERSATION_SURFACE,
  defaultWorkspaceLayout,
  mapWorkspacePane,
  moveWorkspaceSurface,
  paneGroups,
  restoreWorkspaceLayout,
  workspacePaneRects,
  workspaceMaximizeState,
  type PaneEdge,
  type PaneRect,
  type WorkspacePane,
} from "~/rightPanelLayout";
import { randomUUID } from "~/lib/utils";
import { RightPanelTabs, type RightPanelTabsProps } from "./RightPanelTabs";
import { Button } from "./ui/button";

const MIME = "application/x-t3-workspace-tab";
/** Convert workspace-relative percentages into placement styles without reparenting mounted surfaces. */
const position = (rect: PaneRect): CSSProperties => ({
  position: "absolute",
  left: `${rect.x}%`,
  top: `${rect.y}%`,
  width: `${rect.width}%`,
  height: `${rect.height}%`,
});
/** Arrange persistent thread surfaces in nested panes; layout changes do not own their underlying processes. */
export function SplitWorkspace({
  threadRef,
  state,
  conversation,
  renderSurface,
  tabs,
}: {
  threadRef: ScopedThreadRef;
  state: ThreadRightPanelState;
  conversation: ReactNode;
  renderSurface: (surface: RightPanelSurface, visible: boolean) => ReactNode;
  tabs: Omit<RightPanelTabsProps, "mode" | "children" | "surfaces" | "activeSurfaceId">;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [mountedSurfaces, setMountedSurfaces] = useState(
    () => new Set<string>([CONVERSATION_SURFACE]),
  );
  const scope = scopedThreadKey(threadRef);
  const savedLayout = useMemo(
    () =>
      restoreWorkspaceLayout(
        state.workspaceLayout,
        state.surfaces.map((s) => s.id),
        state.activeSurfaceId,
      ),
    [state.workspaceLayout, state.surfaces, state.activeSurfaceId],
  );
  const resize = useRef<{
    base: WorkspacePane;
    scope: string;
    splitId: string;
    pointerId: number;
    ratio: number;
  } | null>(null);
  const [resizePreview, setResizePreview] = useState<typeof resize.current>(null);
  const layout = useMemo(
    () =>
      resizePreview?.base === savedLayout && resizePreview.scope === scope
        ? mapWorkspacePane(savedLayout, (node) =>
            node.id === resizePreview.splitId && node.type === "split"
              ? { ...node, ratio: resizePreview.ratio }
              : node,
          )
        : savedLayout,
    [savedLayout, scope, resizePreview],
  );
  /** Discard the transient drag ratio without persisting or replacing the saved layout. */
  function cancelResize() {
    resize.current = null;
    setResizePreview(null);
  }
  const groups = paneGroups(layout);
  const [dragging, setDragging] = useState(false);
  const [drop, setDrop] = useState<{ group: string; edge?: PaneEdge } | null>(null);
  const [focused, setFocused] = useState("");
  const visibleLayout = !state.isOpen ? defaultWorkspaceLayout([]) : layout;
  const maximized = state.isOpen
    ? workspaceMaximizeState(layout, state.maximizedPaneId, state.activeSurfaceId).maximizedPaneId
    : null;
  const frames = workspacePaneRects(visibleLayout);
  const activeFrames = frames
    .filter((frame) => frame.node.type === "group" && (!maximized || frame.node.id === maximized))
    .map((frame) =>
      maximized ? { ...frame, rect: { x: 0, y: 0, width: 100, height: 100 } } : frame,
    );
  const newlyVisible = activeFrames.flatMap((frame) =>
    frame.node.type === "group" && !mountedSurfaces.has(frame.node.active)
      ? [frame.node.active]
      : [],
  );
  if (newlyVisible.length) setMountedSurfaces(new Set([...mountedSurfaces, ...newlyVisible]));
  /** Persist a layout operation under the owning environment and thread and invalidate stale proactive requests. */
  function save(next: WorkspacePane, max: string | null = maximized ?? null) {
    useRightPanelStore.getState().setWorkspaceLayout(threadRef, next, max);
  }
  /** Select a surface in its group and synchronize the existing tool's activation state. */
  function activate(id: string) {
    const surface = state.surfaces.find((s) => s.id === id);
    if (surface) tabs.onActivate(surface);
    save(activateWorkspaceSurface(layout, id));
  }
  /** Move a surface reference between groups while retaining its mounted resource and activation state. */
  function move(surface: string, group: string, edge?: PaneEdge) {
    save(moveWorkspaceSurface(layout, surface, group, edge, randomUUID()), null);
    const item = state.surfaces.find((s) => s.id === surface);
    if (item) tabs.onActivate(item);
  }
  /** Focus the selected pane's editable surface, falling back to its keyboard-accessible header. */
  function focusPane(id: string) {
    setFocused(id);
    const pane = activeFrames.find((frame) => frame.node.id === id)?.node;
    const surface =
      pane?.type === "group"
        ? Array.from(root.current?.querySelectorAll<HTMLElement>("[data-surface-id]") ?? []).find(
            (element) =>
              element.dataset.surfaceId === pane.active && element.style.display !== "none",
          )
        : null;
    const editable = surface?.querySelector<HTMLElement>(
      'textarea, input:not([type="hidden"]), [contenteditable="true"], [role="textbox"]',
    );
    if (editable) editable.focus();
    else
      Array.from(root.current?.querySelectorAll<HTMLElement>("[data-pane-focus]") ?? [])
        .find((element) => element.dataset.paneFocus === id)
        ?.focus();
  }
  const surfaces = [
    { id: CONVERSATION_SURFACE, content: conversation },
    ...state.surfaces.map((surface) => ({ id: surface.id, surface })),
  ];
  return (
    <div
      ref={root}
      className="relative min-h-0 min-w-0 flex-1"
      data-workspace-scope={scope}
      onKeyDown={(event) => {
        if (event.key === "F6") {
          event.preventDefault();
          const visibleGroups = activeFrames.map((frame) => frame.node);
          const next =
            (visibleGroups.findIndex((g) => g.id === focused) +
              (event.shiftKey ? visibleGroups.length - 1 : 1)) %
            visibleGroups.length;
          if (visibleGroups[next]) focusPane(visibleGroups[next].id);
        }
      }}
      onDragStart={(event) => {
        if (event.dataTransfer.types.includes(MIME)) setDragging(true);
      }}
      onDragEnd={() => {
        setDragging(false);
        setDrop(null);
      }}
    >
      {/* Every surface keeps the same parent and key when moved, split or maximized. */}
      {surfaces.map((item) => {
        const frame = activeFrames.find(
          (f) => f.node.type === "group" && f.node.active === item.id,
        );
        const visible = !!frame;
        const rect = frame?.rect ?? { x: 0, y: 0, width: 100, height: 100 };
        return (
          <div
            key={item.id}
            data-surface-id={item.id}
            data-environment-id={threadRef.environmentId}
            data-thread-id={threadRef.threadId}
            style={{
              ...position(rect),
              top: `calc(${rect.y}% + var(--workspace-topbar-height))`,
              height: `calc(${rect.height}% - var(--workspace-topbar-height))`,
              display: visible ? "flex" : "none",
            }}
            className="min-h-0 min-w-0 flex-col overflow-hidden"
            inert={!visible}
            onFocusCapture={() => {
              if (frame) {
                setFocused(frame.node.id);
                if ("surface" in item && state.activeSurfaceId !== item.id)
                  tabs.onActivate(item.surface);
              }
            }}
            onPointerDownCapture={() => {
              if (frame) {
                setFocused(frame.node.id);
                if ("surface" in item && state.activeSurfaceId !== item.id)
                  tabs.onActivate(item.surface);
              }
            }}
          >
            {"content" in item
              ? item.content
              : mountedSurfaces.has(item.id)
                ? renderSurface(
                    item.surface,
                    visible && (!dragging || item.surface.kind !== "preview"),
                  )
                : null}
          </div>
        );
      })}
      {activeFrames.map(({ node, rect }) =>
        node.type !== "group" ? null : (
          <div
            key={node.id}
            style={{ ...position(rect), height: "var(--workspace-topbar-height)", zIndex: 15 }}
            className="min-w-0 border-b bg-background"
            data-pane-focus={node.id}
            tabIndex={0}
            aria-label={`Workspace pane ${groups.findIndex((g) => g.id === node.id) + 1}`}
            onFocus={() => setFocused(node.id)}
            onDragOver={(event) => {
              if (event.dataTransfer.types.includes(MIME)) {
                event.preventDefault();
                setDrop({ group: node.id });
              }
            }}
            onDrop={(event) => {
              if (!event.dataTransfer.types.includes(MIME)) return;
              event.preventDefault();
              try {
                const value = JSON.parse(event.dataTransfer.getData(MIME));
                if (value.scope === scope) move(value.surfaceId, node.id);
              } catch {}
              setDragging(false);
              setDrop(null);
            }}
          >
            <RightPanelTabs
              {...tabs}
              mode="embedded"
              tabDragScope={scope}
              surfaces={node.tabs.flatMap((id) => state.surfaces.filter((s) => s.id === id))}
              activeSurfaceId={node.active}
              onActivate={(surface) => activate(surface.id)}
              onCloseOtherSurfaces={(surface) => {
                for (const id of node.tabs) {
                  const candidate = state.surfaces.find((s) => s.id === id);
                  if (candidate && id !== surface.id) tabs.onCloseSurface(candidate);
                }
              }}
              onCloseSurfacesToRight={(surface) => {
                const index = node.tabs.indexOf(surface.id);
                if (index < 0) return;
                for (const id of node.tabs.slice(index + 1)) {
                  const candidate = state.surfaces.find((s) => s.id === id);
                  if (candidate) tabs.onCloseSurface(candidate);
                }
              }}
              onCloseAllSurfaces={() => {
                for (const id of node.tabs) {
                  const candidate = state.surfaces.find((s) => s.id === id);
                  if (candidate) tabs.onCloseSurface(candidate);
                }
              }}
              layoutControls={
                <div className="flex items-center gap-1">
                  {node.tabs.includes(CONVERSATION_SURFACE) ? (
                    <button
                      type="button"
                      draggable
                      className="rounded px-2 py-1 text-xs aria-pressed:bg-accent"
                      aria-pressed={node.active === CONVERSATION_SURFACE}
                      onClick={() => activate(CONVERSATION_SURFACE)}
                      onDragStart={(event) => {
                        event.dataTransfer.setData(
                          MIME,
                          JSON.stringify({ scope, surfaceId: CONVERSATION_SURFACE }),
                        );
                        event.dataTransfer.effectAllowed = "move";
                      }}
                    >
                      Conversation
                    </button>
                  ) : null}
                  <details className="relative">
                    <summary className="cursor-pointer px-2 text-xs">Pane</summary>
                    <div className="absolute right-0 z-40 grid w-52 gap-1 rounded border bg-popover p-2 shadow-lg">
                      {(["left", "right", "top", "bottom"] as const).map((edge) => (
                        <Button
                          key={edge}
                          size="sm"
                          variant="ghost"
                          disabled={node.tabs.length < 2}
                          onClick={() => move(node.active, node.id, edge)}
                        >
                          Split active tab {edge}
                        </Button>
                      ))}
                      {groups
                        .filter((g) => g.id !== node.id)
                        .map((g) => (
                          <Button
                            key={g.id}
                            size="sm"
                            variant="ghost"
                            onClick={() => move(node.active, g.id)}
                          >
                            Move active tab to pane{" "}
                            {groups.findIndex((group) => group.id === g.id) + 1}
                          </Button>
                        ))}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => save(layout, maximized ? null : node.id)}
                      >
                        {maximized ? "Restore panes" : "Maximize pane"}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={activeFrames.length < 2}
                        onClick={() =>
                          focusPane(
                            activeFrames[
                              (activeFrames.findIndex((frame) => frame.node.id === node.id) + 1) %
                                activeFrames.length
                            ]!.node.id,
                          )
                        }
                      >
                        Focus next pane (F6)
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() =>
                          save(
                            defaultWorkspaceLayout(
                              state.surfaces.map((s) => s.id),
                              state.activeSurfaceId,
                            ),
                            null,
                          )
                        }
                      >
                        Reset layout
                      </Button>
                    </div>
                  </details>
                </div>
              }
            >
              {null}
            </RightPanelTabs>
          </div>
        ),
      )}
      {!maximized &&
        frames.map(({ node, rect }) =>
          node.type !== "split" ? null : (
            <div
              key={node.id}
              role="separator"
              tabIndex={0}
              aria-label="Resize panes"
              aria-orientation={node.axis === "horizontal" ? "vertical" : "horizontal"}
              aria-valuenow={Math.round(node.ratio * 100)}
              aria-valuemin={15}
              aria-valuemax={85}
              className="absolute z-20 bg-border/60 hover:bg-ring focus-visible:bg-ring"
              style={
                node.axis === "horizontal"
                  ? {
                      left: `calc(${rect.x + rect.width * node.ratio}% - 2px)`,
                      top: `${rect.y}%`,
                      height: `${rect.height}%`,
                      width: 4,
                      cursor: "col-resize",
                    }
                  : {
                      top: `calc(${rect.y + rect.height * node.ratio}% - 2px)`,
                      left: `${rect.x}%`,
                      width: `${rect.width}%`,
                      height: 4,
                      cursor: "row-resize",
                    }
              }
              onKeyDown={(event) => {
                if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
                  event.preventDefault();
                  const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -0.05 : 0.05;
                  save(
                    mapWorkspacePane(layout, (n) =>
                      n.id === node.id && n.type === "split"
                        ? { ...n, ratio: Math.min(0.85, Math.max(0.15, n.ratio + delta)) }
                        : n,
                    ),
                  );
                }
              }}
              onPointerDown={(event) => {
                if (event.button !== 0) return;
                resize.current = {
                  base: savedLayout,
                  scope,
                  splitId: node.id,
                  pointerId: event.pointerId,
                  ratio: node.ratio,
                };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={(event) => {
                const drag = resize.current;
                if (
                  !drag ||
                  drag.pointerId !== event.pointerId ||
                  drag.base !== savedLayout ||
                  drag.scope !== scope ||
                  !root.current
                )
                  return;
                const bounds = root.current.getBoundingClientRect();
                const ratio =
                  node.axis === "horizontal"
                    ? (((event.clientX - bounds.left) / bounds.width) * 100 - rect.x) / rect.width
                    : (((event.clientY - bounds.top) / bounds.height) * 100 - rect.y) / rect.height;
                if (!Number.isFinite(ratio)) return;
                resize.current = { ...drag, ratio: Math.min(0.85, Math.max(0.15, ratio)) };
                setResizePreview(resize.current);
              }}
              onPointerUp={(event) => {
                const drag = resize.current;
                if (drag?.pointerId !== event.pointerId) return;
                if (drag.base === savedLayout && drag.scope === scope) {
                  save(
                    mapWorkspacePane(savedLayout, (pane) =>
                      pane.id === drag.splitId && pane.type === "split"
                        ? { ...pane, ratio: drag.ratio }
                        : pane,
                    ),
                  );
                }
                cancelResize();
                event.currentTarget.releasePointerCapture(event.pointerId);
              }}
              onPointerCancel={cancelResize}
              onLostPointerCapture={cancelResize}
            />
          ),
        )}
      {dragging &&
        activeFrames.map(({ node, rect }) =>
          node.type !== "group" ? null : (
            <div
              key={`drop:${node.id}`}
              style={{
                ...position(rect),
                top: `calc(${rect.y}% + var(--workspace-topbar-height))`,
                height: `calc(${rect.height}% - var(--workspace-topbar-height))`,
                zIndex: 25,
              }}
              className={
                drop?.group === node.id
                  ? "border-2 border-primary bg-primary/10"
                  : "border border-dashed border-primary/30"
              }
              onDragOver={(event) => {
                if (!event.dataTransfer.types.includes(MIME)) return;
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                const x = (event.clientX - bounds.left) / bounds.width;
                const y = (event.clientY - bounds.top) / bounds.height;
                const edge =
                  x < 0.2
                    ? "left"
                    : x > 0.8
                      ? "right"
                      : y < 0.2
                        ? "top"
                        : y > 0.8
                          ? "bottom"
                          : undefined;
                setDrop({ group: node.id, ...(edge ? { edge } : {}) });
              }}
              onDrop={(event) => {
                event.preventDefault();
                try {
                  const value = JSON.parse(event.dataTransfer.getData(MIME));
                  if (value.scope === scope)
                    move(value.surfaceId, node.id, drop?.group === node.id ? drop.edge : undefined);
                } catch {}
                setDragging(false);
                setDrop(null);
              }}
            >
              <span className="absolute left-1/2 top-1/2 rounded bg-background p-2 text-xs shadow">
                {drop?.group === node.id && drop.edge ? `Split ${drop.edge}` : "Move tab here"}
              </span>
            </div>
          ),
        )}
    </div>
  );
}
