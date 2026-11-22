import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useProjectFolders } from "../../hooks/useProjectFolders";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

const NO_FOLDER = "__none";
const NEW_FOLDER = "__new";
const MAX_FOLDER_NAME_LENGTH = 64;

function folderName(value: string): string | null {
  const name = value.trim().slice(0, MAX_FOLDER_NAME_LENGTH);
  return name.length > 0 ? name : null;
}

export function ProjectFolderRow({
  members,
  disabled,
}: {
  members: readonly { readonly environmentId: EnvironmentId; readonly id: ProjectId }[];
  disabled: boolean;
}) {
  const { folders, folderOf, setFolder } = useProjectFolders();
  const [creating, setCreating] = useState(false);
  const current = folderOf(members);
  const commitNewFolder = (value: string) => {
    setCreating(false);
    const name = folderName(value);
    if (name !== null) void setFolder(members, name);
  };
  return (
    <SettingsRow
      title="Folder"
      description="Groups this project in the sidebar project picker. Every checkout of this project shares it."
      control={
        creating ? (
          <Input
            size="sm"
            className="w-full sm:w-48"
            aria-label="New folder name"
            placeholder="Folder name"
            maxLength={MAX_FOLDER_NAME_LENGTH}
            autoFocus
            onBlur={(event) => commitNewFolder(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setCreating(false);
            }}
          />
        ) : (
          <Select
            value={current ?? NO_FOLDER}
            disabled={disabled}
            onValueChange={(value) => {
              if (value === NEW_FOLDER) setCreating(true);
              else if (typeof value === "string")
                void setFolder(members, value === NO_FOLDER ? null : value);
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-48" aria-label="Project folder">
              <SelectValue>{current ?? "No folder"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={NO_FOLDER}>
                No folder
              </SelectItem>
              {folders.map((folder) => (
                <SelectItem hideIndicator key={folder} value={folder}>
                  {folder}
                </SelectItem>
              ))}
              <SelectItem hideIndicator value={NEW_FOLDER}>
                New folder…
              </SelectItem>
            </SelectPopup>
          </Select>
        )
      }
    />
  );
}

export function ProjectFoldersSettingsRow() {
  const searchableSetting = useSearchableSetting();
  const { folders, projectCountByFolder, renameFolder } = useProjectFolders();
  return (
    <SettingsRow
      {...searchableSetting("project-folders")}
      description={
        folders.length === 0
          ? "Group projects in the sidebar picker. Choose a project's folder in its project settings."
          : "Rename or delete folders on every connected environment. Deleting a folder moves its projects to Unfiled."
      }
    >
      {folders.length > 0 ? (
        <ul className="flex flex-col gap-2 pt-2">
          {folders.map((folder) => (
            <li key={folder} className="flex items-center gap-2">
              <Input
                key={folder}
                size="sm"
                className="min-w-0 flex-1 sm:max-w-64"
                aria-label={`Rename ${folder}`}
                defaultValue={folder}
                maxLength={MAX_FOLDER_NAME_LENGTH}
                onBlur={(event) => {
                  const name = folderName(event.currentTarget.value);
                  if (name === null) event.currentTarget.value = folder;
                  else if (name !== folder) void renameFolder(folder, name);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                }}
              />
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {projectCountByFolder(folder)} projects
              </span>
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label={`Delete folder ${folder}`}
                onClick={() => void renameFolder(folder, null)}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </SettingsRow>
  );
}
