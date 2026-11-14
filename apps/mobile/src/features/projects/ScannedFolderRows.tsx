import type { WorkspaceScannedFolder } from "@t3tools/contracts";

import { ListToggleRow } from "../../components/ui/ListToggleRow";

/** Describes a set of scanned folders: "1 repository", "3 folders". */
export function scannedFolderCountLabel(folders: ReadonlyArray<{ isGitRepository: boolean }>) {
  const allRepositories = folders.every((folder) => folder.isGitRepository);
  if (folders.length === 1) return allRepositories ? "1 repository" : "1 folder";
  return `${folders.length} ${allRepositories ? "repositories" : "folders"}`;
}

export function ScannedFolderRows(props: {
  readonly folders: ReadonlyArray<WorkspaceScannedFolder>;
  readonly deselectedPaths: ReadonlySet<string>;
  readonly disabled?: boolean;
  readonly onDeselectedPathsChange: (paths: ReadonlySet<string>) => void;
}) {
  return props.folders.map((folder) => (
    <ListToggleRow
      key={folder.path}
      icon="folder"
      label={folder.name}
      description={folder.isGitRepository ? folder.path : `Folder · ${folder.path}`}
      disabled={props.disabled}
      value={!props.deselectedPaths.has(folder.path)}
      onValueChange={(selected) => {
        const next = new Set(props.deselectedPaths);
        if (selected) next.delete(folder.path);
        else next.add(folder.path);
        props.onDeselectedPathsChange(next);
      }}
    />
  ));
}
