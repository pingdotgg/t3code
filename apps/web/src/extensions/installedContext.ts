import { extensionWorkspaceRevision } from "@t3tools/contracts";
import type { SurfaceDescriptor, ViewContext, ViewRecord } from "@t3tools/extension-sdk/contracts";

/** Shared by the ordinary Open action and explicit composer selection; server verifies this revision. */
export function installedWorkspaceContext(input: {
  environmentId: string;
  projectId: string;
  threadId: string;
  projectWorkspaceRoot: string;
  threadWorktreePath: string | null;
  client: string;
}): ViewContext {
  return {
    client: input.client,
    resource: {
      namespace: "t3.workspace",
      id: "extension-view",
      environmentId: input.environmentId,
      projectId: input.projectId,
      threadId: input.threadId,
    },
    workspaceRevision: extensionWorkspaceRevision(
      input.projectWorkspaceRoot,
      input.threadWorktreePath,
    ),
  };
}
/** The right panel's context for a thread; file opens resolve with it before its view opens. */
export function rightPanelViewContext(input: {
  environmentId: string;
  projectId: string;
  threadId: string;
  projectWorkspaceRoot: string | null;
  threadWorktreePath: string | null;
  client: string;
}): ViewContext {
  return input.projectWorkspaceRoot
    ? installedWorkspaceContext({ ...input, projectWorkspaceRoot: input.projectWorkspaceRoot })
    : {
        client: input.client,
        resource: {
          namespace: "t3.workspace",
          id: "right-panel",
          environmentId: input.environmentId,
          projectId: input.projectId,
          threadId: input.threadId,
        },
      };
}
export function installedSurfaceRecord(
  extensionId: string,
  surface: SurfaceDescriptor,
  placement: ViewRecord["placement"],
  context: ViewContext,
): ViewRecord {
  return {
    version: 1,
    surfaceId: surface.id,
    context: {
      ...context,
      resource: { ...context.resource, namespace: extensionId, id: surface.id },
    },
    placement,
    stateVersion: surface.stateVersion,
    restoreState: null,
    fallback: surface.title + " is unavailable. Check environment extensions in Settings.",
  };
}
