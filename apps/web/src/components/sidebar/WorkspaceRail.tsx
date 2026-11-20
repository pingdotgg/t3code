import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon, LayersIcon, PlusIcon, SettingsIcon } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";

import { canOpenDesktopWindows, openDesktopWorkspaceWindow } from "../../lib/desktopWindowContext";
import { cn } from "../../lib/utils";
import { readLocalApi } from "../../localApi";
import { useEnvironments } from "../../state/environments";
import { useWorkspaceStore } from "../../workspaceStore";
import {
  workspaceProjectRefs,
  workspaceShortcutIndex,
  type Workspace,
} from "../../workspaces.logic";
import { useWorkspaceThreadNavigation } from "../../hooks/useWorkspaceThreadNavigation";
import { useOrbitThreadsAvailable } from "../../orbit/environmentProvider";
import { isOrbitPanelPage, ORBIT_PANEL_HOME } from "../../orbit/orbitPanelPages";
import { OrbitLogoIcon } from "../OrbitLogoIcon";
import { useDelegatedUnderParent, useThreadShells } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import { workspaceAttention, workspaceThreads } from "../../workspaceActivity.logic";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { SidebarUpdatePill } from "./SidebarUpdatePill";
import { WorkspaceDialog } from "./WorkspaceDialog";
import { WorkspaceBadge } from "./workspaceVisuals";

function RailButton({
  label,
  hint,
  active = false,
  className,
  onClick,
  onEdit,
  onOpenWindow,
  children,
  sortable,
  shortcut,
}: {
  label: string;
  /** A second tooltip line; workspaces default to how to edit them. */
  hint?: string;
  active?: boolean;
  className?: string;
  onClick: () => void;
  onEdit?: () => void;
  /** Opens this workspace in a new window: ⌘-click, or from the right-click menu. */
  onOpenWindow?: () => void;
  children: ReactNode;
  sortable?: ReturnType<typeof useSortable>;
  shortcut?: string;
}) {
  const showMenu = async (position: { x: number; y: number }) => {
    const api = readLocalApi();
    if (!onOpenWindow || !api) {
      onEdit?.();
      return;
    }
    const clicked = await api.contextMenu.show(
      [
        { id: "open-window", label: "Open in New Window" },
        ...(onEdit ? [{ id: "edit", label: "Edit…" }] : []),
      ],
      position,
    );
    if (clicked === "open-window") onOpenWindow();
    else if (clicked === "edit") onEdit?.();
  };
  const hasMenu = onEdit !== undefined || onOpenWindow !== undefined;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            {...sortable?.attributes}
            {...sortable?.listeners}
            ref={sortable?.setNodeRef}
            style={
              sortable
                ? {
                    transform: CSS.Transform.toString(sortable.transform),
                    transition: sortable.transition,
                  }
                : undefined
            }
            aria-keyshortcuts={shortcut}
            aria-label={label}
            aria-pressed={active}
            onClick={(event) => {
              if (event.metaKey && onOpenWindow) onOpenWindow();
              else onClick();
            }}
            onContextMenu={
              hasMenu
                ? (event) => {
                    event.preventDefault();
                    void showMenu({ x: event.clientX, y: event.clientY });
                  }
                : undefined
            }
            className={cn(
              // Concentric with the badge inside, so the selected ring follows its curve.
              "relative flex size-9.5 shrink-0 items-center justify-center rounded-rail text-muted-foreground",
              "outline-none hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
              // Selected: a 2px near-white inset ring (no layout shift) over the subtle row fill.
              active &&
                "bg-sidebar-row-active text-sidebar-foreground ring-2 ring-inset ring-sidebar-foreground/90 hover:bg-sidebar-row-active",
              sortable && "touch-none",
              sortable?.isDragging && "z-10 opacity-70",
              className,
            )}
          >
            {children}
          </button>
        }
      />
      <TooltipPopup side="right">
        {label}
        {hint ? <span className="text-muted-foreground"> · {hint}</span> : null}
        {hasMenu ? (
          <span className="text-muted-foreground">
            {onOpenWindow ? " · ⌘-click for a new window" : " · right-click to edit"}
          </span>
        ) : null}
      </TooltipPopup>
    </Tooltip>
  );
}

function SortableWorkspaceButton({
  id,
  ...props
}: ComponentProps<typeof RailButton> & { id: string }) {
  const sortable = useSortable({ id });
  return <RailButton {...props} sortable={sortable} />;
}

/**
 * The workspace rail beside the thread sidebar: "All projects", one button per
 * workspace, and "New workspace". Selecting a workspace scopes the sidebar.
 * The rail has no fill of its own, so it joins the top bar as one surface.
 */
export function WorkspaceRail({ isElectron }: { isElectron: boolean }) {
  useWorkspaceThreadNavigation();
  const threads = useThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const visited = useUiStateStore((state) => state.threadLastVisitedAtById);
  const projects = useWorkspaceStore((state) => state.availableProjects);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const selectWorkspace = useWorkspaceStore((state) => state.selectWorkspace);
  const moveWorkspace = useWorkspaceStore((state) => state.moveWorkspace);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const attention = new Map(
    workspaces.map((workspace) => [
      workspace.id,
      workspaceAttention(
        workspaceThreads(threads, workspaceProjectRefs(workspace, projects), delegatedUnderParent),
        visited,
      ),
    ]),
  );
  // The dialog keeps its target while it animates closed; `session` remounts
  // its form each time it opens.
  const [dialog, setDialog] = useState<{
    target: Workspace | "new";
    open: boolean;
    session: number;
  }>({
    target: "new",
    open: false,
    session: 0,
  });
  const setEditing = (target: Workspace | "new") =>
    setDialog((current) => ({ target, open: true, session: current.session + 1 }));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a document keydown listener for the workspace shortcuts
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.repeat ||
        dialog.open ||
        document.querySelector('[role="dialog"][aria-modal="true"]')
      )
        return;
      const index = workspaceShortcutIndex(event);
      const workspace = index === null ? undefined : useWorkspaceStore.getState().workspaces[index];
      if (!workspace) return;
      event.preventDefault();
      selectWorkspace(workspace.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dialog.open, selectWorkspace]);
  // Extra windows need the desktop shell (rooms-patches).
  const openWindow = canOpenDesktopWindows()
    ? (workspace: Workspace | null) => () => openDesktopWorkspaceWindow(workspace?.id ?? null)
    : null;

  return (
    <nav
      aria-label="Workspaces"
      data-workspace-rail=""
      className="flex h-full w-13.5 shrink-0 flex-col"
    >
      {/* Keeps clear of the macOS window buttons, and drags the window like the header. */}
      <div
        aria-hidden="true"
        className={cn(
          "h-[var(--workspace-topbar-height)] w-full shrink-0",
          isElectron && "drag-region",
        )}
      />
      <div className="flex min-h-0 w-full flex-1 flex-col">
        <RailButton
          // 38px button centered on the 32px search row (panel top 44px, 8px inset).
          // Outside the scroller: a negative margin inside overflow-y-auto clips the icon.
          className="mt-[calc(44px-var(--workspace-topbar-height)+var(--sidebar-content-inset)-var(--spacing)*0.75)] self-center"
          label="All projects"
          active={activeWorkspaceId === null}
          onClick={() => selectWorkspace(null)}
          {...(openWindow ? { onOpenWindow: openWindow(null) } : {})}
        >
          {/* Its own square, like a workspace badge, so the selected highlight rings it the same way. */}
          <span
            aria-hidden="true"
            // Concentric with the button: its 10px radius minus the 5px inset.
            className="flex size-7 items-center justify-center rounded-tile bg-sidebar-foreground/10"
          >
            <LayersIcon className="size-4" />
          </span>
        </RailButton>
        <div className="mt-2 flex min-h-0 w-full flex-1 flex-col items-center gap-2 overflow-y-auto scrollbar-gutter-both pb-2">
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis]}
            onDragEnd={({ active, over }) => {
              if (over) moveWorkspace(String(active.id), String(over.id));
            }}
          >
            <SortableContext
              items={workspaces.map((workspace) => workspace.id)}
              strategy={verticalListSortingStrategy}
            >
              {workspaces.map((workspace, index) => {
                const status = attention.get(workspace.id)!;
                const hint = [
                  status.approval > 0 ? `${status.approval} awaiting approval` : null,
                  status.input > 0 ? `${status.input} awaiting input` : null,
                  status.unread > 0 ? `${status.unread} completed unread` : null,
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <SortableWorkspaceButton
                    id={workspace.id}
                    key={workspace.id}
                    label={workspace.name}
                    hint={[
                      index < 9 ? `⌘⌥${index + 1} (number row or numpad)` : null,
                      hint,
                      "drag to reorder",
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                    {...(index < 9 ? { shortcut: `Meta+Alt+${index + 1}` } : {})}
                    active={workspace.id === activeWorkspaceId}
                    onClick={() => selectWorkspace(workspace.id)}
                    onEdit={() => setEditing(workspace)}
                    {...(openWindow ? { onOpenWindow: openWindow(workspace) } : {})}
                  >
                    <WorkspaceBadge workspace={workspace} />
                    {hint ? (
                      <span
                        aria-label={hint}
                        className={cn(
                          "absolute top-0.5 right-0.5 size-2 rounded-full ring-2 ring-sidebar",
                          status.approval > 0
                            ? "bg-warning"
                            : status.input > 0
                              ? "bg-primary"
                              : "bg-info",
                        )}
                      />
                    ) : null}
                  </SortableWorkspaceButton>
                );
              })}
            </SortableContext>
          </DndContext>
          <RailButton label="New workspace" onClick={() => setEditing("new")}>
            <PlusIcon className="size-4" />
          </RailButton>
        </div>
        <RailActions />
      </div>
      <WorkspaceDialog
        key={dialog.session}
        open={dialog.open}
        target={dialog.target}
        onClose={() => setDialog((current) => ({ ...current, open: false }))}
      />
    </nav>
  );
}

/**
 * The app's utility actions at the bottom of the rail, top to bottom: a provider
 * update (only while there is one), the app update button (always there in the
 * desktop app, so an update never shifts the rest), usage, pull requests, Orbit
 * (Conn: only while environments come from Orbit) and settings. They replace the thread sidebar's footer row.
 */
export function RailActions() {
  const navigate = useNavigate();
  const { isMobile, setOpenMobile } = useSidebar();
  const page = useLocation({
    select: (location) =>
      location.pathname === "/usage"
        ? "usage"
        : location.pathname === "/pull-requests"
          ? "pull-requests"
          : isOrbitPanelPage(location.pathname)
            ? "orbit"
            : null,
  });
  const orbitAvailable = useOrbitThreadsAvailable();
  const { environments } = useEnvironments();
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const go = (to: () => void) => () => {
    if (isMobile) setOpenMobile(false);
    to();
  };

  return (
    <div className="flex w-full shrink-0 flex-col items-center gap-2 pb-2">
      <SidebarUpdatePill variant="rail" />
      <RailButton
        label="Usage"
        active={page === "usage"}
        onClick={go(() => void navigate({ to: "/usage" }))}
      >
        <ChartNoAxesColumnIcon className="size-4" />
      </RailButton>
      {pullRequestsSupported ? (
        <RailButton
          label="Pull Requests"
          active={page === "pull-requests"}
          onClick={go(
            () => void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() }),
          )}
        >
          <PullRequestGlyph.pullRequest className="size-4" />
        </RailButton>
      ) : null}
      {orbitAvailable ? (
        <RailButton
          label="Orbit"
          active={page === "orbit"}
          onClick={go(() => void navigate({ to: ORBIT_PANEL_HOME }))}
        >
          <OrbitLogoIcon className="size-4" />
        </RailButton>
      ) : null}
      <RailButton label="Settings" onClick={go(() => void navigate({ to: "/settings" }))}>
        <SettingsIcon className="size-4" />
      </RailButton>
    </div>
  );
}
