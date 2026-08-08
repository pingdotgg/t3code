import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { LayoutGridIcon } from "lucide-react";
import { memo, useCallback, useMemo } from "react";

import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useClientSettings } from "../../hooks/useSettings";
import { selectProjectGroupingSettings } from "../../logicalProject";
import { useSessionGridFocusStore } from "../../sessionGridFocusStore";
import { buildPhysicalToLogicalProjectKeyMap } from "../../sidebarProjectGrouping";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useProjects, useThreadShell } from "../../state/entities";
import {
  buildThreadRouteParams,
  resolveActiveThreadRouteRef,
  resolveThreadRouteTarget,
} from "../../threadRoutes";
import { SidebarMenuButton, SidebarMenuItem, useSidebar } from "../ui/sidebar";
import { sessionGridPhysicalProjectKey } from "./sessionGrid.logic";

export const SessionGridSidebarLink = memo(function SessionGridSidebarLink() {
  const navigate = useNavigate();
  const pathname = useLocation({ select: (location) => location.pathname });
  const gridOpen = pathname === "/grid";
  const { isMobile, setOpenMobile } = useSidebar();
  const projects = useProjects();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projectGroupingSettings = useClientSettings(selectProjectGroupingSettings);
  const routeTarget = useParams({
    strict: false,
    select: (params) => resolveThreadRouteTarget(params),
  });
  const routeDraftThread = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );
  const routeThreadRef = useMemo(
    () => resolveActiveThreadRouteRef(routeTarget, routeDraftThread),
    [routeDraftThread, routeTarget],
  );
  const routeThread = useThreadShell(routeThreadRef);
  const focusedThreadKey = useSessionGridFocusStore((state) => state.focusedThreadKey);
  const focusedDraftId = useSessionGridFocusStore((state) => state.focusedDraftId);
  const focusedThreadRef = useMemo(
    () => (focusedThreadKey ? parseScopedThreadKey(focusedThreadKey) : null),
    [focusedThreadKey],
  );
  const logicalProjectKeyByPhysicalKey = useMemo(
    () =>
      buildPhysicalToLogicalProjectKeyMap({
        projects,
        settings: projectGroupingSettings,
        primaryEnvironmentId,
      }),
    [primaryEnvironmentId, projectGroupingSettings, projects],
  );
  const routeProjectKey = useMemo(() => {
    if (routeDraftThread) {
      return (
        logicalProjectKeyByPhysicalKey.get(
          sessionGridPhysicalProjectKey({
            environmentId: routeDraftThread.environmentId,
            projectId: routeDraftThread.projectId,
          }),
        ) ?? routeDraftThread.logicalProjectKey
      );
    }
    if (!routeThread) return null;
    return (
      logicalProjectKeyByPhysicalKey.get(
        sessionGridPhysicalProjectKey({
          environmentId: routeThread.environmentId,
          projectId: routeThread.projectId,
        }),
      ) ?? null
    );
  }, [logicalProjectKeyByPhysicalKey, routeDraftThread, routeThread]);

  const toggleGrid = useCallback(() => {
    if (isMobile) setOpenMobile(false);
    if (!gridOpen) {
      void navigate({
        to: "/grid",
        search: routeProjectKey ? { project: routeProjectKey } : {},
      });
      return;
    }
    if (focusedDraftId) {
      void navigate({
        to: "/draft/$draftId",
        params: { draftId: DraftId.make(focusedDraftId) },
      });
      return;
    }
    if (focusedThreadRef) {
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(focusedThreadRef),
      });
      return;
    }
    void navigate({ to: "/" });
  }, [
    focusedDraftId,
    focusedThreadRef,
    gridOpen,
    isMobile,
    navigate,
    routeProjectKey,
    setOpenMobile,
  ]);

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        aria-pressed={gridOpen}
        isActive={gridOpen}
        onClick={toggleGrid}
        tooltip={gridOpen ? "Close session grid" : "Open session grid"}
      >
        <LayoutGridIcon />
        <span>Session grid</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
});
