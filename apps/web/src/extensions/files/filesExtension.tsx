import type { ViewContext, ViewRecord } from "@t3tools/extension-sdk/contracts";
import type { Extension } from "@t3tools/extension-sdk/host";
import type { SurfaceRenderer } from "@t3tools/extension-sdk/react";
import { lazy, Suspense, type ComponentProps } from "react";

import type { RightPanelSurface } from "../../rightPanelStore";

const FilePreviewPanel = lazy(() => import("../../components/files/FilePreviewPanel"));

/** Trusted native props from the shell; domain access and layout remain host-owned. */
export type FilesBindings = Omit<
  ComponentProps<typeof FilePreviewPanel>,
  "relativePath" | "attachment" | "revealLine" | "revealRequestId"
> & {
  readonly surface: Extract<RightPanelSurface, { kind: "files" | "file" }>;
  readonly hasProject: boolean;
};

export function createFilesExtension(useBindings: () => FilesBindings): Extension<SurfaceRenderer> {
  function FilesRenderer() {
    const { surface, hasProject, ...panel } = useBindings();
    const attachment = surface.kind === "file" ? surface.attachment : undefined;
    if (!(hasProject && panel.cwd) && !attachment) return null;

    return (
      <Suspense fallback={null}>
        <FilePreviewPanel
          key={`${panel.environmentId}:${attachment ? `attachment:${attachment.id}` : panel.cwd}`}
          {...panel}
          relativePath={surface.kind === "file" ? surface.relativePath : null}
          {...(attachment ? { attachment } : {})}
          revealLine={surface.kind === "file" ? (surface.revealLine ?? null) : null}
          revealRequestId={surface.kind === "file" ? surface.revealRequestId : 0}
        />
      </Suspense>
    );
  }

  return {
    manifest: {
      id: "t3.files",
      apiVersion: 1,
      version: "1.0.0",
      surfaces: [
        {
          id: "t3.files/view",
          title: "Files",
          placements: ["side-panel"],
          clients: ["web", "desktop"],
          scope: "project",
          capabilities: [],
          stateVersion: 1,
        },
        {
          id: "t3.files/file",
          title: "File",
          placements: ["side-panel"],
          clients: ["web", "desktop"],
          scope: "thread",
          capabilities: [],
          stateVersion: 1,
        },
      ],
    },
    surfaces: ["t3.files/view", "t3.files/file"].map((id) => ({
      id,
      validateRestore: (state) => state === null,
      createView: () => ({ renderer: FilesRenderer }),
    })),
  };
}

/** Workspace file presentation survives thread navigation; attachments remain thread-owned. */
export function filesViewRecord(
  bindings: Pick<FilesBindings, "surface">,
  context: ViewContext,
): ViewRecord {
  const attachment = bindings.surface.kind === "file" ? bindings.surface.attachment : undefined;
  const { threadId: _threadId, ...workspace } = context.resource;
  return {
    version: 1,
    surfaceId: attachment ? "t3.files/file" : "t3.files/view",
    placement: "side-panel",
    stateVersion: 1,
    restoreState: null,
    fallback: "Files unavailable",
    context: {
      ...context,
      resource: attachment ? { ...context.resource, id: "attachment:" + attachment.id } : workspace,
    },
  };
}
