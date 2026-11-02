import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useLayoutEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { applyDockDrop } from "../../dock/dockActions";
import { beginDockDrag } from "../../dock/dockDrag";
import { DockHostPortal } from "../../dock/DockHostPortal";
import { useDockLayoutStore } from "../../dock/dockLayoutStore";
import { useDockSlotStore } from "../../dock/dockSlots";
import type { DockGroupView } from "../../dock/dockView";
import { useDockView } from "../../dock/useDockView";
import { workspaceAreaProps } from "../../lib/workspaceFocus";
import {
  selectThreadRightPanelState,
  useRightPanelStore,
  type RightPanelSurface,
} from "../../rightPanelStore";
import { useBrowserDefaults } from "~/browser/browserDefaults";
import {
  RightPanelEmptyState,
  RightPanelTabBar,
  type RightPanelTabBarProps,
} from "../RightPanelTabs";

type ChatDockTabBarProps = Omit<
  RightPanelTabBarProps,
  | "dock"
  | "mode"
  | "surfaces"
  | "activeSurfaceId"
  | "open"
  | "maximized"
  | "layoutControls"
  | "onCloseOtherSurfaces"
  | "onCloseSurfacesToRight"
  | "onCloseAllSurfaces"
  | "onMoveSurface"
>;

interface ChatDockSurfacesProps {
  readonly threadRef: ScopedThreadRef;
  readonly tabBar: ChatDockTabBarProps;
  readonly renderSurface: (
    surface: RightPanelSurface,
    activeSurfaceId: string | null,
    visible: boolean,
  ) => ReactNode;
  readonly onCloseOtherSurfaces: (
    surface: RightPanelSurface,
    scope: readonly RightPanelSurface[],
  ) => void;
  readonly onCloseSurfacesToRight: (
    surface: RightPanelSurface,
    scope: readonly RightPanelSurface[],
  ) => void;
  readonly onCloseAllSurfaces: (scope: readonly RightPanelSurface[]) => void;
}

/** Spends a group's add menu on that group: the tab the action opens lands there. */
function inGroup<Args extends readonly unknown[]>(
  groupId: string,
  action: (...args: Args) => void,
): (...args: Args) => void {
  return (...args) => {
    useDockLayoutStore.getState().setPendingSurfaceGroup(groupId);
    action(...args);
  };
}

function groupAddActions(groupId: string, tabBar: ChatDockTabBarProps) {
  return {
    onAddBrowser: inGroup(groupId, tabBar.onAddBrowser),
    onAddBrowserInProfile: inGroup(groupId, tabBar.onAddBrowserInProfile),
    onAddTerminal: inGroup(groupId, tabBar.onAddTerminal),
    onAddDiff: inGroup(groupId, tabBar.onAddDiff),
    onAddFiles: inGroup(groupId, tabBar.onAddFiles),
    onAddPullRequest: inGroup(groupId, tabBar.onAddPullRequest),
    onAddPullRequests: inGroup(groupId, tabBar.onAddPullRequests),
    onAddDevice: inGroup(groupId, tabBar.onAddDevice),
    ...(tabBar.onAddSideChat ? { onAddSideChat: inGroup(groupId, tabBar.onAddSideChat) } : {}),
  };
}

function ChatDockTabBar(
  props: ChatDockSurfacesProps & {
    readonly group: DockGroupView;
    readonly shortcutsEnabled: boolean;
    readonly ownsTitleBar: boolean;
    readonly maximized: boolean;
  },
) {
  const { group, threadRef, tabBar, shortcutsEnabled, ownsTitleBar, maximized } = props;
  return (
    <RightPanelTabBar
      {...tabBar}
      {...groupAddActions(group.id, tabBar)}
      mode="embedded"
      surfaces={group.surfaces}
      activeSurfaceId={group.activeSurface?.id ?? null}
      onCloseOtherSurfaces={(surface) => props.onCloseOtherSurfaces(surface, group.surfaces)}
      onCloseSurfacesToRight={(surface) => props.onCloseSurfacesToRight(surface, group.surfaces)}
      onCloseAllSurfaces={() => props.onCloseAllSurfaces(group.surfaces)}
      dock={{
        shortcutsEnabled,
        ownsTitleBar,
        maximized,
        onToggleMaximized: () => {
          // Maximize acts on the focused surface's group, so this group takes focus first.
          const panels = useRightPanelStore.getState();
          if (group.activeSurface) panels.activateSurface(threadRef, group.activeSurface.id);
          panels.setMaximized(threadRef, !maximized);
        },
        onTabPointerDown: (event, surface, title) =>
          beginDockDrag({
            event,
            label: title,
            sourceGroupId: group.id,
            sourceTabCount: group.surfaces.length,
            onDrop: (target) => applyDockDrop(threadRef, surface.id, target),
          }),
      }}
    />
  );
}

function ChatDockLauncher(props: {
  readonly group: DockGroupView;
  readonly tabBar: ChatDockTabBarProps;
}) {
  const { group, tabBar } = props;
  const browserProfiles = useBrowserDefaults().profiles;
  return (
    <RightPanelEmptyState
      {...groupAddActions(group.id, tabBar)}
      browserProfiles={browserProfiles}
      browserAvailable={tabBar.browserAvailable}
      terminalAvailable={tabBar.terminalAvailable}
      diffAvailable={tabBar.diffAvailable}
      filesAvailable={tabBar.filesAvailable}
      pullRequestAvailable={tabBar.pullRequestAvailable}
      pullRequestsAvailable={tabBar.pullRequestsAvailable}
      deviceAvailable={tabBar.deviceAvailable}
      sideChatAvailable={tabBar.sideChatAvailable === true}
      sideChatDisabledReason={tabBar.sideChatDisabledReason ?? null}
    />
  );
}

/**
 * Puts the thread's tab bars and surfaces into their dock groups. ChatView owns the props every
 * surface needs, so it renders them here and the workspace only supplies the slots.
 */
export function ChatDockSurfaces(props: ChatDockSurfacesProps) {
  const { threadRef, tabBar } = props;
  const view = useDockView(threadRef);
  const slots = useDockSlotStore((state) => state.slots);
  const activeSurfaceId = useRightPanelStore(
    (state) => selectThreadRightPanelState(state.byThreadKey, threadRef).activeSurfaceId,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the workspace, which sits above ChatView, whose surfaces its groups show
  useLayoutEffect(() => {
    useDockLayoutStore.getState().setThreadRef(threadRef);
    return () => useDockLayoutStore.getState().setThreadRef(null);
  }, [threadRef]);

  const threadKey = scopedThreadKey(threadRef);
  const groups = [...view.groups.values()].filter(
    (group) => group.launcher || group.surfaces.length > 0,
  );
  const focusedGroupId =
    groups.find((group) => group.activeSurface?.id === activeSurfaceId)?.id ?? groups[0]?.id;

  return (
    <>
      {groups.map((group) => {
        const slot = slots[group.id]?.tabs;
        if (!slot) return null;
        return createPortal(
          <ChatDockTabBar
            {...props}
            group={group}
            shortcutsEnabled={group.id === focusedGroupId}
            ownsTitleBar={view.edges.top.has(group.id)}
            maximized={view.maximizedGroupId === group.id}
          />,
          slot,
          group.id,
        );
      })}
      {groups.map((group) => {
        const surface = group.activeSurface;
        if (!surface && !group.launcher) return null;
        return (
          <DockHostPortal
            key={`${threadKey}:${surface?.id ?? "launcher"}`}
            slot={slots[group.id]?.body ?? null}
          >
            <DockSurfaceFrame focusKey={`panel:${tabBar.environmentId}:${surface?.id ?? "empty"}`}>
              {surface ? (
                props.renderSurface(
                  surface,
                  activeSurfaceId,
                  view.maximizedGroupId === null || view.maximizedGroupId === group.id,
                )
              ) : (
                <ChatDockLauncher group={group} tabBar={tabBar} />
              )}
            </DockSurfaceFrame>
          </DockHostPortal>
        );
      })}
    </>
  );
}

function DockSurfaceFrame(props: { readonly focusKey: string; readonly children: ReactNode }) {
  return (
    <div
      {...workspaceAreaProps("panel", 4, "Workspace panel")}
      data-workspace-focus-key={props.focusKey}
      data-preview-panel-mode="inline"
      className="flex h-full min-h-0 min-w-0 flex-col bg-background"
    >
      <div className="flex min-h-0 flex-1 flex-col" data-right-panel-surface-content>
        {props.children}
      </div>
    </div>
  );
}
