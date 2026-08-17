import type { EnvironmentId, ProjectEntry } from "@t3tools/contracts";
import { useMemo } from "react";

import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { cn } from "~/lib/utils";

import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBreadcrumbMenuProps {
  environmentId: EnvironmentId;
  cwd: string;
  /** Directory the menu lists; the empty string is the project root. */
  directoryPath: string;
  label: string;
  /** Tooltip text, kept as the full path the crumb points at. */
  title: string;
  className?: string;
  onOpenFile: (relativePath: string) => void;
}

type FileBreadcrumbMenuItemsProps = Pick<
  FileBreadcrumbMenuProps,
  "environmentId" | "cwd" | "directoryPath" | "onOpenFile"
>;

function entryName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Immediate children of `directoryPath` out of the flat workspace listing,
 * directories first so the menu reads like the file tree.
 */
function directoryChildren(
  entries: ReadonlyArray<ProjectEntry>,
  directoryPath: string,
): ProjectEntry[] {
  const prefix = directoryPath ? `${directoryPath}/` : "";
  return entries
    .filter(
      (entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes("/"),
    )
    .toSorted((left, right) =>
      left.kind === right.kind
        ? entryName(left.path).localeCompare(entryName(right.path))
        : left.kind === "directory"
          ? -1
          : 1,
    );
}

function FileBreadcrumbMenuItems({
  environmentId,
  cwd,
  directoryPath,
  onOpenFile,
}: FileBreadcrumbMenuItemsProps) {
  const entriesQuery = useProjectEntriesQuery(environmentId, cwd);
  const entries = entriesQuery.data?.entries;
  const children = useMemo(
    () => (entries ? directoryChildren(entries, directoryPath) : []),
    [directoryPath, entries],
  );

  if (children.length === 0) {
    return <MenuItem disabled>{entries ? "No files" : "Loading files…"}</MenuItem>;
  }

  return (
    <>
      {children.map((entry) =>
        entry.kind === "directory" ? (
          <MenuSub key={entry.path}>
            <MenuSubTrigger>{entryName(entry.path)}</MenuSubTrigger>
            <MenuSubPopup className="min-w-40 max-w-72">
              <FileBreadcrumbMenuItems
                environmentId={environmentId}
                cwd={cwd}
                directoryPath={entry.path}
                onOpenFile={onOpenFile}
              />
            </MenuSubPopup>
          </MenuSub>
        ) : (
          <MenuItem key={entry.path} onClick={() => onOpenFile(entry.path)}>
            {entryName(entry.path)}
          </MenuItem>
        ),
      )}
    </>
  );
}

/**
 * Breadcrumb crumb that opens the directory it points at, so a file can be
 * swapped without opening the file explorer. Entries are only queried once the
 * menu opens, since the popup mounts lazily.
 */
export function FileBreadcrumbMenu({
  environmentId,
  cwd,
  directoryPath,
  label,
  title,
  className,
  onOpenFile,
}: FileBreadcrumbMenuProps) {
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  className={cn(
                    "max-w-40 cursor-pointer truncate rounded px-1 py-0.5 hover:bg-accent hover:text-accent-foreground data-popup-open:bg-accent data-popup-open:text-accent-foreground",
                    className,
                  )}
                />
              }
            />
          }
        >
          {label}
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-80">
          {title}
        </TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" sideOffset={6} className="min-w-40 max-w-72">
        <FileBreadcrumbMenuItems
          environmentId={environmentId}
          cwd={cwd}
          directoryPath={directoryPath}
          onOpenFile={onOpenFile}
        />
      </MenuPopup>
    </Menu>
  );
}
