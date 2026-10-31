import { Outlet, createFileRoute, notFound, redirect, useLocation } from "@tanstack/react-router";

import { SidebarInset } from "../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";

/**
 * The dev design-system area: the catalog and the turn player, in the app
 * shell like Settings, with their own sidebar nav. Production builds 404.
 */
export const Route = createFileRoute("/design-system")({
  beforeLoad: ({ context }) => {
    if (!import.meta.env.DEV) throw notFound();
    // The shell needs a session, as for every other page in it.
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: DesignSystemLayout,
});

function DesignSystemLayout() {
  const onScenes = useLocation({
    select: (location) => location.pathname.startsWith("/design-system/scenes"),
  });
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Design system breadcrumb">
            {onScenes ? (
              <>
                <WorkspaceBreadcrumbItem>Design system</WorkspaceBreadcrumbItem>
                <WorkspaceBreadcrumbSeparator />
              </>
            ) : null}
            <WorkspaceBreadcrumbItem current className="truncate">
              {onScenes ? "Turn player" : "Design system"}
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <div className="flex min-h-0 flex-1 flex-col">
          <Outlet />
        </div>
      </div>
    </SidebarInset>
  );
}
