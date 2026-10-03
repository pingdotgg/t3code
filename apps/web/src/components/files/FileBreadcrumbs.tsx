import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "~/components/ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { useTheme } from "~/hooks/useTheme";
import { useWorkspaceMutationRefresh } from "~/hooks/useWorkspaceMutationRefresh";
import { cn } from "~/lib/utils";
import { isAbsolutePath } from "~/terminal-links";

import {
  type FileBreadcrumb,
  fileBreadcrumbChildren,
  fileBreadcrumbParent,
  fileBreadcrumbs,
  isListableHostFolder,
} from "./filePath";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBreadcrumbsProps {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  /** Moves the browser to a folder crumb; `""` is the workspace root. */
  readonly onNavigateFolder: (relativePath: string) => void;
  readonly onOpenFile: (relativePath: string) => void;
  readonly projectName: string;
  /** The current path; `""` is the workspace root. */
  readonly relativePath: string;
  /** The deepest path to show: `relativePath`, or a path inside it the browser came up from. */
  readonly trail: string;
  readonly workspaceMutationId: string | null;
}

function pathLabel(path: string, projectName: string): string {
  return path.slice(path.lastIndexOf("/") + 1) || projectName;
}

function BreadcrumbLabel(props: {
  readonly current?: boolean;
  readonly label: string;
  readonly pathLabel: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            className={cn(
              "block max-w-40 truncate rounded-sm px-0.5",
              props.current ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          />
        }
      >
        {props.label}
      </TooltipTrigger>
      <TooltipPopup side="top">{props.pathLabel}</TooltipPopup>
    </Tooltip>
  );
}

function BreadcrumbMenuContent(props: {
  readonly cwd: string;
  readonly currentFilePath: string;
  readonly directoryPath: string;
  readonly environmentId: EnvironmentId;
  readonly onDirectoryChange: (path: string) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onOpenFile: (path: string) => void;
  readonly projectName: string;
  readonly rootPath: string;
  readonly workspaceMutationId: string | null;
}) {
  const entriesQuery = useProjectEntriesQuery(props.environmentId, props.cwd, props.directoryPath);
  useWorkspaceMutationRefresh({
    mutationId: props.workspaceMutationId,
    refresh: entriesQuery.refresh,
    resourceKey: `files:${props.environmentId}:${props.cwd}`,
  });
  const { resolvedTheme } = useTheme();
  const entries = entriesQuery.data?.entries ?? [];
  const entriesTruncated = entriesQuery.data?.truncated ?? false;
  const children = useMemo(
    () => fileBreadcrumbChildren(entries, props.directoryPath),
    [entries, props.directoryPath],
  );
  const directoryAvailable = entriesQuery.data !== null;
  const parentPath = fileBreadcrumbParent(props.directoryPath);
  const canGoBack =
    props.directoryPath !== props.rootPath &&
    parentPath !== null &&
    (props.rootPath === "" ||
      parentPath === props.rootPath ||
      parentPath.startsWith(`${props.rootPath}/`));

  return (
    <MenuPopup
      align="start"
      side="bottom"
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" || !canGoBack || parentPath === null) return;
        event.preventDefault();
        event.stopPropagation();
        props.onDirectoryChange(parentPath);
      }}
    >
      {canGoBack && parentPath !== null ? (
        <>
          <MenuItem closeOnClick={false} onClick={() => props.onDirectoryChange(parentPath)}>
            <ArrowLeftIcon />
            <span className="truncate">Back to {pathLabel(parentPath, props.projectName)}</span>
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuGroup key={props.directoryPath}>
        {entriesQuery.isPending && entriesQuery.data === null ? (
          <MenuItem disabled>
            <Spinner />
            Loading folder…
          </MenuItem>
        ) : entriesQuery.error && entriesQuery.data === null ? (
          <MenuItem closeOnClick={false} onClick={entriesQuery.refresh}>
            <RefreshIcon refreshing={entriesQuery.isPending} />
            <span className="min-w-0 flex-1 truncate">Retry loading folder</span>
          </MenuItem>
        ) : !directoryAvailable && !entriesTruncated ? (
          <MenuItem disabled>This folder is no longer available.</MenuItem>
        ) : children.length === 0 ? (
          <MenuItem disabled>
            {entriesTruncated
              ? "No entries from this folder are available in the partial workspace index."
              : "This folder is empty."}
          </MenuItem>
        ) : (
          // Files form a radio group keyed by path so the open file is marked as checked;
          // directories only navigate the menu, so they stay plain items.
          <MenuRadioGroup
            value={props.currentFilePath}
            onValueChange={(path) => {
              props.onOpenChange(false);
              props.onOpenFile(path);
            }}
          >
            {children.map((entry) => {
              const isCurrentFile = entry.kind === "file" && entry.path === props.currentFilePath;
              const row = (
                <>
                  <PierreEntryIcon pathValue={entry.path} kind={entry.kind} theme={resolvedTheme} />
                  <Tooltip>
                    <TooltipTrigger
                      render={
                        <span
                          className={cn(
                            "min-w-0 flex-1 truncate",
                            entry.ignored && "text-muted-foreground",
                          )}
                        />
                      }
                    >
                      {entry.label}
                    </TooltipTrigger>
                    <TooltipPopup side="right">{entry.path}</TooltipPopup>
                  </Tooltip>
                </>
              );
              return entry.kind === "directory" ? (
                <MenuItem
                  key={entry.path}
                  closeOnClick={false}
                  onClick={() => props.onDirectoryChange(entry.path)}
                >
                  {row}
                  <ChevronRightIcon />
                </MenuItem>
              ) : (
                <MenuRadioItem
                  key={entry.path}
                  value={entry.path}
                  closeOnClick
                  aria-current={isCurrentFile ? "page" : undefined}
                >
                  <span className="flex min-w-0 items-center gap-2">{row}</span>
                </MenuRadioItem>
              );
            })}
          </MenuRadioGroup>
        )}
      </MenuGroup>
      {entriesQuery.error && entriesQuery.data !== null ? (
        <>
          <MenuSeparator />
          <MenuItem closeOnClick={false} onClick={entriesQuery.refresh}>
            <RefreshIcon refreshing={entriesQuery.isPending} />
            Refresh failed — retry
          </MenuItem>
        </>
      ) : null}
      {entriesTruncated ? (
        <>
          <MenuSeparator />
          <MenuItem disabled>Some workspace entries are not shown.</MenuItem>
        </>
      ) : null}
    </MenuPopup>
  );
}

/** The chevron after a folder crumb lists that folder's entries. */
function FolderContentsMenu(props: FileBreadcrumbsProps & { readonly crumb: FileBreadcrumb }) {
  const [open, setOpen] = useState(false);
  const [directoryPath, setDirectoryPath] = useState(props.crumb.path);

  useEffect(() => {
    setOpen(false);
    setDirectoryPath(props.crumb.path);
  }, [props.crumb.path, props.relativePath]);

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setDirectoryPath(props.crumb.path);
  };

  return (
    <Menu open={open} onOpenChange={handleOpenChange}>
      <MenuTrigger
        render={
          <button
            type="button"
            aria-label={`Browse ${props.crumb.label}`}
            className="relative mx-0.5 flex h-5 w-4 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground/60 outline-none pointer-coarse:after:absolute pointer-coarse:after:-inset-3 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
          />
        }
      >
        <ChevronRightIcon className="size-3.5" />
      </MenuTrigger>
      {open ? (
        <BreadcrumbMenuContent
          cwd={props.cwd}
          currentFilePath={props.relativePath}
          directoryPath={directoryPath}
          environmentId={props.environmentId}
          onDirectoryChange={setDirectoryPath}
          onOpenChange={handleOpenChange}
          onOpenFile={props.onOpenFile}
          projectName={props.projectName}
          rootPath={props.crumb.path}
          workspaceMutationId={props.workspaceMutationId}
        />
      ) : null}
    </Menu>
  );
}

function FolderBreadcrumb(props: {
  readonly crumb: FileBreadcrumb;
  /** Below the current folder, kept from where the browser came from. */
  readonly descendant: boolean;
  readonly onNavigate: (path: string) => void;
  readonly projectName: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            onClick={() => props.onNavigate(props.crumb.path)}
            className={cn(
              "relative block max-w-40 cursor-pointer rounded-sm px-0.5 text-left outline-none pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-3 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              props.descendant ? "text-muted-foreground/70" : "text-muted-foreground",
            )}
          />
        }
      >
        <span className="block truncate">{props.crumb.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.crumb.path || props.projectName}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Each folder crumb moves the browser to that folder, and the chevron after it
 * lists the folder's entries. A host path outside the workspace has no contents
 * menu: the browser below already lists the folder it moves to.
 */
export function FileBreadcrumbs(props: FileBreadcrumbsProps) {
  const hostPath = isAbsolutePath(props.relativePath);
  const breadcrumbs = useMemo(
    () => fileBreadcrumbs(props.projectName, props.trail),
    [props.projectName, props.trail],
  );
  const currentIndex = breadcrumbs.findIndex((crumb) => crumb.path === props.relativePath);

  return (
    <nav aria-label="File path" className="flex h-full">
      <ol className="flex items-center">
        {breadcrumbs.map((crumb, index) => {
          const current = index === currentIndex;
          return (
            <li
              key={crumb.path || "project"}
              className="flex min-w-0 shrink-0 items-center"
              data-file-crumb
              data-current-file-crumb={current}
            >
              {current ? (
                <span aria-current="page">
                  <BreadcrumbLabel
                    current
                    label={crumb.label}
                    pathLabel={crumb.path || props.projectName}
                  />
                </span>
              ) : hostPath && !isListableHostFolder(crumb.path) ? (
                <BreadcrumbLabel label={crumb.label} pathLabel={crumb.path} />
              ) : (
                <FolderBreadcrumb
                  crumb={crumb}
                  descendant={index > currentIndex}
                  onNavigate={props.onNavigateFolder}
                  projectName={props.projectName}
                />
              )}
              {index === breadcrumbs.length - 1 ? null : hostPath ? (
                <ChevronRightIcon
                  aria-hidden
                  className="mx-1 size-3.5 shrink-0 text-muted-foreground/60"
                />
              ) : (
                <FolderContentsMenu {...props} crumb={crumb} />
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
