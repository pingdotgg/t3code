interface WorkspaceFileDragEvent {
  readonly dataTransfer: {
    readonly types: ReadonlyArray<string>;
    readonly files: Iterable<File>;
    readonly items?: Iterable<{
      readonly kind: string;
      getAsFile(): File | null;
      webkitGetAsEntry(): FileSystemEntry | null;
    }>;
    dropEffect: string;
  };
  readonly relatedTarget: EventTarget | null;
  readonly currentTarget: {
    contains(target: Node | null): boolean;
  };
  preventDefault(): void;
}

interface WorkspaceFileDropHost {
  setDragActive(active: boolean): void;
  addFiles(files: File[]): void;
  addFolders(folders: File[], folderEntries: FileSystemDirectoryEntry[]): void;
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
  folderEntries: FileSystemDirectoryEntry[];
} {
  if (dataTransfer.items === undefined)
    return { files: Array.from(dataTransfer.files), folders: [], folderEntries: [] };

  const files: File[] = [];
  const folders: File[] = [];
  // Entries go stale once the event handler returns, so capture them here, before any await.
  const folderEntries: FileSystemDirectoryEntry[] = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null) continue;
    const entry = item.webkitGetAsEntry();
    if (entry?.isDirectory === true) {
      folders.push(file);
      folderEntries.push(entry as FileSystemDirectoryEntry);
    } else {
      files.push(file);
    }
  }
  return { files, folders, folderEntries };
}

export function makeWorkspaceFileDropHandlers(host: WorkspaceFileDropHost) {
  return {
    onDragEnter(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(true);
    },
    onDragOver(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      host.setDragActive(true);
    },
    onDragLeave(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      if (movedWithinDropTarget(event)) return;
      host.setDragActive(false);
    },
    onDrop(event: WorkspaceFileDragEvent) {
      if (!isFileDrag(event)) return;
      event.preventDefault();
      host.setDragActive(false);
      const { files, folders, folderEntries } = splitTransferredFiles(event.dataTransfer);
      if (files.length > 0) host.addFiles(files);
      if (folders.length > 0) host.addFolders(folders, folderEntries);
    },
  };
}
