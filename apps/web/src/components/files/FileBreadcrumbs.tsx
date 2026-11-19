import { InlineButton } from "~/components/ui/button";
import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

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
import { cn } from "~/lib/utils";
import { isHostPath } from "@t3tools/shared/path";

import {
  breadcrumbPathOf,
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
  readonly isFolder: boolean;
  /** Navigates to a folder; an empty path is the workspace root. */
  readonly onNavigateFolder: (relativePath: string) => void;
  readonly onOpenFile: (relativePath: string) => void;
  readonly projectName: string;
  /** Current path; an empty path is the workspace root. */
  readonly relativePath: string;
  /** Deepest visible path, including descendants retained after navigating up. */
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
              "block max-w-40 truncate rounded-kbd px-0.5",
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
  const messages = useMessages();
  const entriesQuery = useProjectEntriesQuery(
    props.environmentId,
    props.cwd,
    props.directoryPath,
    props.workspaceMutationId,
    messages,
  );
  const gt = useGT();
  const { resolvedTheme } = useTheme();
  const entries = entriesQuery.data?.entries ?? [];
  const entriesTruncated = entriesQuery.data?.truncated ?? false;
  const children = fileBreadcrumbChildren(entries, props.directoryPath);
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
            <span className="truncate">
              <T>
                Back to <Var>{pathLabel(parentPath, props.projectName)}</Var>
              </T>
            </span>
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
      <MenuGroup key={props.directoryPath}>
        {entriesQuery.isPending && entriesQuery.data === null ? (
          <MenuItem disabled>
            <Spinner />
            <T>Loading folder…</T>
          </MenuItem>
        ) : entriesQuery.error && entriesQuery.data === null ? (
          <MenuItem closeOnClick={false} onClick={entriesQuery.refresh}>
            <RefreshIcon refreshing={entriesQuery.isPending} />
            <span className="min-w-0 flex-1 truncate">
              <T>Retry loading folder</T>
            </span>
          </MenuItem>
        ) : !directoryAvailable && !entriesTruncated ? (
          <MenuItem disabled>
            <T>This folder is no longer available.</T>
          </MenuItem>
        ) : children.length === 0 ? (
          <MenuItem disabled>
            {entriesTruncated
              ? gt("No entries from this folder are available in the partial workspace index.")
              : gt("This folder is empty.")}
          </MenuItem>
        ) : (
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
            <T>Refresh failed. Retry</T>
          </MenuItem>
        </>
      ) : null}
      {entriesTruncated ? (
        <>
          <MenuSeparator />
          <MenuItem disabled>
            <T>Some workspace entries are not shown.</T>
          </MenuItem>
        </>
      ) : null}
    </MenuPopup>
  );
}

function FolderContentsMenu(props: FileBreadcrumbsProps & { readonly crumb: FileBreadcrumb }) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [directoryPath, setDirectoryPath] = useState(props.crumb.path);
  const [shownFor, setShownFor] = useState({
    crumbPath: props.crumb.path,
    relativePath: props.relativePath,
  });
  if (shownFor.crumbPath !== props.crumb.path || shownFor.relativePath !== props.relativePath) {
    setShownFor({ crumbPath: props.crumb.path, relativePath: props.relativePath });
    setOpen(false);
    setDirectoryPath(props.crumb.path);
  }

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
            aria-label={gt("Browse {folder}", { folder: props.crumb.label })}
            className="relative mx-0.5 flex h-5 w-4 shrink-0 cursor-pointer items-center justify-center rounded-kbd text-dim-foreground outline-none pointer-coarse:after:absolute pointer-coarse:after:-inset-3 hover:surface-ghost-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:surface-selected data-popup-open:text-foreground"
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
  /** Whether this crumb is below the current folder. */
  readonly descendant: boolean;
  readonly onNavigate: (path: string) => void;
  readonly projectName: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <InlineButton
            tone={props.descendant ? "ghost-dim" : "ghost"}
            onClick={() => props.onNavigate(props.crumb.path)}
            className="relative block max-w-40 text-left pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 pointer-coarse:after:-inset-y-3"
          />
        }
      >
        <span className="block truncate">{props.crumb.label}</span>
      </TooltipTrigger>
      <TooltipPopup side="top">{props.crumb.path || props.projectName}</TooltipPopup>
    </Tooltip>
  );
}

/** Host paths outside the workspace omit contents menus; the browser already lists their destination. */
export function FileBreadcrumbs(props: FileBreadcrumbsProps) {
  const { resolvedTheme } = useTheme();
  const hostPath = isHostPath(props.relativePath);
  const breadcrumbs = fileBreadcrumbs(props.projectName, props.trail);
  const currentPath = breadcrumbPathOf(props.relativePath);
  const currentIndex = breadcrumbs.findIndex((crumb) => crumb.path === currentPath);
  const gt = useGT();

  return (
    <nav aria-label={gt("File path")} className="flex h-full">
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
                <span aria-current="page" className="flex min-w-0 items-center gap-1">
                  {!props.isFolder && crumb.kind === "file" ? (
                    <PierreEntryIcon
                      pathValue={crumb.path}
                      kind="file"
                      theme={resolvedTheme}
                      className="size-3.5"
                    />
                  ) : null}
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
                  className="mx-1 size-3.5 shrink-0 text-dim-foreground"
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
