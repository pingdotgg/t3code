import type { ScopedThreadRef } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "../../state/entities";
import { useForkRole } from "../../state/forkRoles";
import { ForkRoleIcon } from "../Sidebar.forkRoles";
import {
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
  WorkspaceBreadcrumbText,
} from "../WorkspaceBreadcrumb";

export function RoleBreadcrumb(props: { readonly threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const roleId = useThreadShell(props.threadRef)?.roleId ?? null;
  const role = useForkRole(props.threadRef.environmentId, roleId);
  if (roleId === null) return null;
  return (
    <>
      <WorkspaceBreadcrumbItem>
        {role === null ? (
          <WorkspaceBreadcrumbText>{roleId}</WorkspaceBreadcrumbText>
        ) : (
          <button
            type="button"
            aria-label={gt("Open role file: {role}", { role: role.name })}
            onClick={() => useRightPanelStore.getState().openFile(props.threadRef, role.path)}
            className="inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          >
            <ForkRoleIcon role={role} />
            <WorkspaceBreadcrumbText>{role.name}</WorkspaceBreadcrumbText>
          </button>
        )}
      </WorkspaceBreadcrumbItem>
      <WorkspaceBreadcrumbSeparator>
        <WorkspaceBreadcrumbText>/</WorkspaceBreadcrumbText>
      </WorkspaceBreadcrumbSeparator>
    </>
  );
}
