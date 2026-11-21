import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { PenTool } from "lucide-react";
import { type DragEvent, useEffect, useState, useSyncExternalStore } from "react";
import { useAtomValue } from "@effect/atom-react";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Empty, EmptyDescription, EmptyMedia, EmptyTitle } from "~/components/ui/empty";
import { Spinner } from "~/components/ui/spinner";
import { toastManager } from "~/components/ui/toast";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { type RightPanelSurface, useRightPanelStore } from "~/rightPanelStore";
import { canvasEnvironment } from "~/state/canvas";
import { useAtomCommand } from "~/state/use-atom-command";
import { definePluginComponent } from "~/plugins/features";

import { PreviewPanelShell, type PreviewPanelMode } from "../preview/PreviewPanelShell";
import {
  type CanvasDocumentController,
  acquireCanvasDocument,
  getCanvasDocumentController,
  registerMountedCanvasPanel,
} from "./canvasDocumentStore";
import { CanvasEditor } from "./CanvasEditor";
import { CanvasEmptyState } from "./CanvasEmptyState";
import { canvasImportFile, useCanvasImport } from "./canvasImport";
import { refreshCanvasList } from "./canvasRpc";

export const CanvasPanel = definePluginComponent(
  "component:components/canvas/CanvasPanel",
  PluginOriginalCanvasPanel,
);

/** The canvas surface: a document picker for `canvas:new`, else the editor. */
function PluginOriginalCanvasPanel(props: {
  readonly mode: PreviewPanelMode;
  readonly visible: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId | null;
  readonly surface: Extract<RightPanelSurface, { kind: "canvas" }>;
}) {
  const { threadRef, projectId, surface } = props;
  const importer = useCanvasImport(threadRef, projectId);
  const [dragging, setDragging] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds this panel's entry in the mounted canvas panel registry while visible
  useEffect(() => {
    if (!props.visible) return;
    return registerMountedCanvasPanel(threadRef, surface.documentId);
  }, [props.visible, surface.documentId, threadRef]);

  const onDragOver = (event: DragEvent) => {
    if (!importer.available || !event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    setDragging(true);
  };
  const onDrop = (event: DragEvent) => {
    setDragging(false);
    if (!importer.available) return;
    const file = canvasImportFile(event.dataTransfer.files);
    if (!file) return;
    event.preventDefault();
    void importer.importFile(file);
  };

  return (
    <PreviewPanelShell mode={props.mode}>
      <div
        className="relative flex min-h-0 flex-1 flex-col"
        onDragOver={onDragOver}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false);
        }}
        onDrop={onDrop}
      >
        {surface.documentId === null ? (
          <CanvasEmptyState threadRef={threadRef} projectId={projectId} importer={importer} />
        ) : (
          <CanvasDocumentView
            key={surface.documentId}
            threadRef={threadRef}
            projectId={projectId}
            documentId={surface.documentId}
            surfaceId={surface.id}
            visible={props.visible}
          />
        )}
        {dragging || importer.importing ? (
          <div className="pointer-events-none absolute inset-2 z-30 flex items-center justify-center rounded-xl border border-dashed border-primary bg-background/80 text-sm text-muted-foreground">
            {importer.importing ? (
              <span className="flex items-center gap-2">
                <Spinner size="xs" /> <T>Importing…</T>
              </span>
            ) : (
              <T>Drop a Pencil, Figma, SVG, image, or ZIP file to import it</T>
            )}
          </div>
        ) : null}
      </div>
    </PreviewPanelShell>
  );
}

/** Holds one shared document controller for as long as the caller is mounted. */
export function useCanvasDocument(
  environmentId: ScopedThreadRef["environmentId"],
  documentId: string,
): CanvasDocumentController | null {
  return useSyncExternalStore(
    (onChange) => {
      const handle = acquireCanvasDocument(environmentId, documentId);
      onChange();
      return handle.release;
    },
    () => getCanvasDocumentController(environmentId, documentId),
    () => null,
  );
}

function CanvasDocumentView(props: {
  readonly visible: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId | null;
  readonly documentId: string;
  readonly surfaceId: string;
}) {
  const controller = useCanvasDocument(props.threadRef.environmentId, props.documentId);
  if (!controller) return null;
  return <CanvasDocumentContent {...props} controller={controller} />;
}

function CanvasDocumentContent(props: {
  readonly visible: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly projectId: ProjectId | null;
  readonly documentId: string;
  readonly surfaceId: string;
  readonly controller: CanvasDocumentController;
}) {
  const { threadRef, documentId, controller } = props;
  const status = useSyncExternalStore(controller.subscribe, controller.getStatus);
  const name = useSyncExternalStore(controller.subscribe, () => controller.getDocument()?.name);
  const deleteDocument = useAtomCommand(canvasEnvironment.delete);
  const canDelete = useAtomValue(canvasEnvironment.delete.permissionAtom(threadRef.environmentId));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const gt = useGT();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- mirrors the document name, which agents and other clients can rename, into the right panel tab title
  useEffect(() => {
    if (name !== undefined) {
      useRightPanelStore.getState().syncCanvasTitle(threadRef, documentId, name);
    }
  }, [documentId, name, threadRef]);

  const closeTab = () => useRightPanelStore.getState().closeSurface(threadRef, props.surfaceId);

  // Floating the canvas closes the panel, like the browser and device.
  const popOut = () => {
    usePreviewMiniPlayerStore
      .getState()
      .open(threadRef, { kind: "canvas", documentId, name: name ?? "Canvas" });
    useRightPanelStore.getState().close(threadRef);
  };

  if (status === "deleted" || status === "failed") {
    return (
      <Empty>
        <EmptyMedia variant="icon">
          <PenTool className="size-4.5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyTitle>
          {status === "deleted" ? <T>Canvas deleted</T> : <T>Canvas unavailable</T>}
        </EmptyTitle>
        <EmptyDescription>
          {status === "deleted" ? (
            <T>This canvas was deleted.</T>
          ) : (
            <T>This canvas could not be loaded from this environment.</T>
          )}
        </EmptyDescription>
        <Button variant="outline" size="sm" onClick={closeTab}>
          <T>Close tab</T>
        </Button>
      </Empty>
    );
  }
  if (status === "loading") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-1 text-sm text-muted-foreground">
        <span className="flex items-center gap-2">
          <Spinner size="xs" /> <T>Loading canvas…</T>
        </span>
        <span className="text-xs">
          <T>Large canvases can take a while.</T>
        </span>
      </div>
    );
  }

  return (
    <>
      <CanvasEditor
        controller={controller}
        variant="panel"
        visible={props.visible}
        onPopOut={popOut}
        onDelete={() => {
          if (canDelete) setConfirmDelete(true);
        }}
      />
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {name === undefined ? gt("Delete this canvas?") : gt("Delete {name}?", { name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              <T>The canvas is removed for every thread in this project. This cannot be undone.</T>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>
              <T>Cancel</T>
            </AlertDialogClose>
            <Button
              variant="destructive"
              disabled={!canDelete}
              onClick={() => {
                setConfirmDelete(false);
                void deleteDocument({
                  environmentId: threadRef.environmentId,
                  input: { documentId },
                }).then((result) => {
                  if (result._tag === "Success") {
                    if (props.projectId)
                      refreshCanvasList(threadRef.environmentId, props.projectId);
                    closeTab();
                  } else toastManager.add({ type: "error", title: gt("Unable to delete canvas") });
                });
              }}
            >
              <T>Delete</T>
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
