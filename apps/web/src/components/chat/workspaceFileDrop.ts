interface WorkspaceFileDragEvent {
  readonly dataTransfer: {
    readonly types: ReadonlyArray<string>;
    readonly files: Iterable<File>;
    readonly items?: Iterable<{
      readonly kind: string;
      getAsFile(): File | null;
      webkitGetAsEntry(): { readonly isDirectory: boolean } | null;
    }>;
    dropEffect: string;
  };
  readonly shiftKey: boolean;
  readonly relatedTarget: EventTarget | null;
  readonly currentTarget: {
    contains(target: Node | null): boolean;
  };
  preventDefault(): void;
}

// "attach-or-paths": a plain drop attaches, and holding Shift would insert paths instead.
export type WorkspaceFileDropMode = "attach" | "attach-or-paths" | "paths";

interface WorkspaceFileDropPaths {
  readonly dragMode: WorkspaceFileDropMode | null;
  canInsert(): boolean;
  insert(entries: File[]): void;
}

interface WorkspaceFileDropHost {
  setDragMode(mode: WorkspaceFileDropMode | null): void;
  addFiles(files: File[]): void;
  addFolders(folders: File[]): void;
  // Hosts without this always attach, Shift or not.
  paths?: WorkspaceFileDropPaths;
}

function dropMode(
  event: WorkspaceFileDragEvent,
  paths: WorkspaceFileDropPaths | undefined,
): WorkspaceFileDropMode {
  if (paths === undefined) return "attach";
  // canInsert can cost a sync IPC round trip: ask as a drag starts, then infer it from the mode.
  const canInsert = paths.dragMode === null ? paths.canInsert() : paths.dragMode !== "attach";
  if (!canInsert) return "attach";
  return event.shiftKey ? "paths" : "attach-or-paths";
}

function isFileDrag(event: WorkspaceFileDragEvent): boolean {
  return event.dataTransfer.types.includes("Files");
}

function movedWithinDropTarget(event: WorkspaceFileDragEvent): boolean {
  return event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget as Node);
}

export function splitTransferredFiles(
  dataTransfer: Pick<WorkspaceFileDragEvent["dataTransfer"], "files" | "items">,
): {
  files: File[];
  folders: File[];
  /** Files and folders together, in the order they were transferred. */
  entries: File[];
} {
  if (dataTransfer.items === undefined) {
    const files = Array.from(dataTransfer.files);
    return { files, folders: [], entries: files };
  }

  const files: File[] = [];
  const folders: File[] = [];
  const entries: File[] = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null) continue;
    entries.push(file);
    if (item.webkitGetAsEntry()?.isDirectory === true) {
      folders.push(file);
    } else {
      files.push(file);
    }
  }
  return { files, folders, entries };
}

export function makeWorkspaceFileDropHandlers(host: WorkspaceFileDropHost) {
  return {
    onDragEnter(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragMode(dropMode(event, host.paths));
    },
    onDragOver(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      // Never "move": a source like Explorer deletes the original after a move drop.
      event.dataTransfer.dropEffect = "copy";
      host.setDragMode(dropMode(event, host.paths));
    },
    onDragLeave(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragMode(null);
    },
    onDrop(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      const mode = dropMode(event, host.paths);
      host.setDragMode(null);
      const { files, folders, entries } = splitTransferredFiles(event.dataTransfer);
      if (mode === "paths") {
        if (entries.length > 0) host.paths?.insert(entries);
        return;
      }
      if (files.length > 0) host.addFiles(files);
      if (folders.length > 0) host.addFolders(folders);
    },
  };
}
