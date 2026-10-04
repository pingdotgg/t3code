import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowLeft, ChevronRight } from "lucide-react";
import { useState } from "react";

import { VscodeEntryIcon } from "../chat/VscodeEntryIcon";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

function FolderContents({
  environmentId,
  cwd,
  initialPath,
  selectedPath,
  theme,
  onOpenFile,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  initialPath: string;
  selectedPath: string;
  theme: "light" | "dark";
  onOpenFile: (path: string) => void;
}) {
  const [directoryPath, setDirectoryPath] = useState(initialPath);
  const listing = useProjectEntriesQuery(environmentId, cwd, directoryPath);
  const children =
    listing.data?.entries.filter(
      (entry) => entry.path.split("/").slice(0, -1).join("/") === directoryPath,
    ) ?? [];
  const back = () => setDirectoryPath(directoryPath.split("/").slice(0, -1).join("/"));
  return (
    <div
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft" && directoryPath) {
          event.preventDefault();
          event.stopPropagation();
          back();
        }
      }}
    >
      {directoryPath ? (
        <>
          <MenuItem closeOnClick={false} onClick={back} className="text-xs">
            <ArrowLeft className="size-3.5" /> Back
            <span className="min-w-0 truncate text-muted-foreground">{directoryPath}</span>
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      {listing.error ? (
        <MenuItem
          closeOnClick={false}
          onClick={listing.refresh}
          className="text-xs text-destructive"
        >
          {listing.error} Retry
        </MenuItem>
      ) : listing.data === null ? (
        <MenuItem disabled className="text-xs">
          Loading files…
        </MenuItem>
      ) : children.length === 0 ? (
        <MenuItem disabled className="text-xs">
          No files
        </MenuItem>
      ) : (
        <MenuRadioGroup value={selectedPath} onValueChange={(value) => onOpenFile(String(value))}>
          {children.map((entry) => {
            const name = entry.path.split("/").at(-1) ?? entry.path;
            return entry.kind === "directory" ? (
              <MenuItem
                key={entry.path}
                closeOnClick={false}
                className="text-xs"
                onClick={() => setDirectoryPath(entry.path)}
              >
                <VscodeEntryIcon
                  pathValue={entry.path}
                  kind="directory"
                  theme={theme}
                  className="size-3.5"
                />
                <span className="min-w-0 flex-1 truncate">{name}</span>
                <ChevronRight className="size-3.5" />
              </MenuItem>
            ) : (
              <MenuRadioItem key={entry.path} value={entry.path} closeOnClick className="text-xs">
                <span className="flex min-w-0 items-center gap-2">
                  <VscodeEntryIcon
                    pathValue={entry.path}
                    kind="file"
                    theme={theme}
                    className="size-3.5"
                  />
                  <span className="truncate">{name}</span>
                </span>
              </MenuRadioItem>
            );
          })}
        </MenuRadioGroup>
      )}
    </div>
  );
}

export function FileBreadcrumbMenu(props: {
  environmentId: EnvironmentId;
  cwd: string;
  path: string;
  label: string;
  selectedPath: string;
  theme: "light" | "dark";
  onOpenFile: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Browse ${props.label}`}
            title={props.path || props.cwd}
            className="max-w-40 truncate rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-ring"
          />
        }
      >
        {props.label}
      </MenuTrigger>
      <MenuPopup align="start" className="min-w-56 max-w-80">
        {open ? <FolderContents {...props} initialPath={props.path} /> : null}
      </MenuPopup>
    </Menu>
  );
}
