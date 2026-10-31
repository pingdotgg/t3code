import { Outlet, createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { SidebarInset } from "../components/ui/sidebar";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
} from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";

/** The dev catalog in the app shell. Production builds 404. */
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
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Design system breadcrumb">
            <WorkspaceBreadcrumbItem current className="truncate">
              Design system
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
