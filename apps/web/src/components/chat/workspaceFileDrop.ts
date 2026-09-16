export interface WorkspaceFileDragEvent {
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
  readonly relatedTarget: EventTarget | null;
  readonly currentTarget: {
    contains(target: Node | null): boolean;
  };
  preventDefault(): void;
}

export interface WorkspaceFileDropHost {
  setDragActive(active: boolean): void;
  addFiles(files: File[]): void;
  addFolders(folders: File[]): void;
}

function isFileDrag(event: WorkspaceFileDragEvent): boolean {
  return event.dataTransfer.types.includes("Files");
}

function movedWithinDropTarget(event: WorkspaceFileDragEvent): boolean {
  return event.relatedTarget !== null && event.currentTarget.contains(event.relatedTarget as Node);
}

function splitDroppedItems(dataTransfer: WorkspaceFileDragEvent["dataTransfer"]): {
  files: File[];
  folders: File[];
} {
  if (dataTransfer.items === undefined)
    return { files: Array.from(dataTransfer.files), folders: [] };

  const files: File[] = [];
  const folders: File[] = [];
  for (const item of dataTransfer.items) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file === null) continue;
    if (item.webkitGetAsEntry()?.isDirectory === true) {
      folders.push(file);
    } else {
      files.push(file);
    }
  }
  return { files, folders };
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
      const { files, folders } = splitDroppedItems(event.dataTransfer);
      if (files.length > 0) host.addFiles(files);
      if (folders.length > 0) host.addFolders(folders);
    },
  };
}
