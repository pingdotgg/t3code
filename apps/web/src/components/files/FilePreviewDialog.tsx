import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EditorId,
  EnvironmentId,
  ProjectId,
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { PanelRightIcon, XIcon } from "lucide-react";
import { createContext, lazy, Suspense } from "react";

import type { DraftId } from "../../composerDraftStore";
import { useRightPanelStore } from "../../rightPanelStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { registerThreadOverlay } from "../chat/threadOverlayRetention";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";

const FilePreviewPanel = lazy(() => import("./FilePreviewPanel"));

interface FilePreviewDialogState {
  readonly threadRef: ScopedThreadRef;
  readonly relativePath: string;
  readonly line: number | undefined;
  readonly revealRequestId: number;
}

const filePreviewDialogAtom = Atom.make<FilePreviewDialogState | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("chat:file-preview-dialog"),
);

export function openFilePreviewDialog(
  threadRef: ScopedThreadRef,
  relativePath: string,
  line: number | undefined,
): void {
  if (relativePath === "." || relativePath.endsWith("/") || relativePath.endsWith("\\")) {
    closeFilePreviewDialog();
    useRightPanelStore.getState().openFile(threadRef, relativePath, line);
    return;
  }
  const previous = appAtomRegistry.get(filePreviewDialogAtom);
  appAtomRegistry.set(filePreviewDialogAtom, {
    threadRef,
    relativePath,
    line,
    revealRequestId: (previous?.revealRequestId ?? 0) + 1,
  });
}

// Surfaces that own file navigation, like the side panel, open chat file links in place.
export const FileLinkOpenerContext =
  createContext<typeof openFilePreviewDialog>(openFilePreviewDialog);

function closeFilePreviewDialog(): void {
  appAtomRegistry.set(filePreviewDialogAtom, null);
}

registerThreadOverlay((threadKey) => {
  const current = appAtomRegistry.get(filePreviewDialogAtom);
  if (current !== null && scopedThreadKey(current.threadRef) !== threadKey) {
    closeFilePreviewDialog();
  }
});

export function FilePreviewDialogHost(props: {
  readonly threadRef: ScopedThreadRef;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | undefined;
  readonly projectName: string | null;
  readonly projectId: ProjectId | undefined;
  readonly composerDraftTarget: ScopedThreadRef | DraftId;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly availableEditors: ReadonlyArray<EditorId>;
  readonly pendingSurfaceIds: ReadonlySet<string>;
  readonly onPendingChange: (relativePath: string, pending: boolean) => void;
  readonly workspaceMutationId: string | null;
}) {
  const state = useAtomValue(filePreviewDialogAtom);
  if (
    state === null ||
    scopedThreadKey(state.threadRef) !== scopedThreadKey(props.threadRef) ||
    !props.workspaceRoot ||
    props.projectName === null
  ) {
    return null;
  }
  const { relativePath, line } = state;
  const openInPanel = () => {
    closeFilePreviewDialog();
    useRightPanelStore.getState().openFile(props.threadRef, relativePath, line);
  };
  return (
    <Dialog open onOpenChange={(open) => !open && closeFilePreviewDialog()}>
      <DialogPopup
        className="h-[min(85vh,56rem)] max-w-5xl overflow-hidden"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">{relativePath}</DialogTitle>
        <div className="flex items-center justify-end gap-1 border-b px-2 py-1">
          <Button variant="ghost" size="xs" onClick={openInPanel}>
            <PanelRightIcon />
            Open in panel
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close"
            onClick={closeFilePreviewDialog}
          >
            <XIcon />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col">
          <Suspense fallback={null}>
            <FilePreviewPanel
              environmentId={props.environmentId}
              cwd={props.workspaceRoot}
              projectName={props.projectName}
              projectId={props.projectId}
              threadRef={props.threadRef}
              composerDraftTarget={props.composerDraftTarget}
              keybindings={props.keybindings}
              availableEditors={props.availableEditors}
              openInShortcutEnabled
              relativePath={relativePath}
              revealLine={line ?? null}
              revealRequestId={state.revealRequestId}
              onOpenFile={(path) => openFilePreviewDialog(props.threadRef, path, undefined)}
              // A folder has no preview here; browsing belongs to the Files panel.
              onNavigateFolder={(path) => {
                closeFilePreviewDialog();
                useRightPanelStore.getState().openFile(props.threadRef, path || ".");
              }}
              folderTrail={undefined}
              onPendingChange={props.onPendingChange}
              selectedFilePending={props.pendingSurfaceIds.has(`file:${relativePath}`)}
              workspaceMutationId={props.workspaceMutationId}
            />
          </Suspense>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
