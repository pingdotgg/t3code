import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Navigate } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { isElectron } from "~/env";
import { linkedThreadSurface } from "../../linkedThreadSurface";
import { useEnvironment } from "../../state/environments";
import { useLinkedEnvironments } from "../../state/peerLinks";
import { buildThreadRouteParams } from "../../threadRoutes";
import { SidebarInset } from "../ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { LinkedThread } from "./LinkedThreadPane";

/**
 * A linked environment's thread on the main screen, read through `viaEnvironmentId`. Once this
 * client is connected to the thread's own environment, the thread opens there instead.
 */
export function LinkedThreadPage(props: {
  readonly viaEnvironmentId: EnvironmentId;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { viaEnvironmentId, environmentId, threadId } = props;
  const gt = useGT();
  const own = useEnvironment(environmentId);
  const connected = own?.connection.phase === "connected";
  const linkedLabel = useLinkedEnvironments(connected ? null : viaEnvironmentId).get(environmentId);
  if (connected) {
    return (
      <Navigate
        to="/$environmentId/$threadId"
        params={buildThreadRouteParams(scopeThreadRef(environmentId, threadId))}
        replace
      />
    );
  }
  const surface = linkedThreadSurface({
    viaEnvironmentId,
    environmentId,
    threadId,
    label: own?.label ?? linkedLabel ?? gt("a linked environment"),
    title: null,
  });
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <LinkedThread
        key={surface.id}
        panelRef={null}
        surface={surface}
        visible
        renderHeader={(title) => (
          <WorkspacePageHeader electron={isElectron} className="relative bg-background">
            <WorkspaceBreadcrumb ariaLabel={gt("Thread breadcrumb")}>
              <WorkspaceBreadcrumbItem current>
                <h1 className="truncate">{title}</h1>
              </WorkspaceBreadcrumbItem>
            </WorkspaceBreadcrumb>
          </WorkspacePageHeader>
        )}
      />
    </SidebarInset>
  );
}
