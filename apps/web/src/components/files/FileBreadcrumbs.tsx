import { RefreshIcon } from "~/components/ui/refresh-icon";
import { Spinner } from "~/components/ui/spinner";
import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import { Button, InlineButton } from "~/components/ui/button";
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
  /**
   * Only the file, for a panel tab ("Files › file.tsx", pen r7Vc3). It opens
   * its folder's menu, which climbs to the parents.
   */
  readonly compact?: boolean;
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly isFolder?: boolean;
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
  readonly onNavigateFolder?: (path: string) => void;
  readonly projectName: string;
  readonly rootPath: string;
  readonly workspaceMutationId: string | null;
}) {
  const entriesQuery = useProjectEntriesQuery(
    props.environmentId,
    props.cwd,
    props.directoryPath,
    props.workspaceMutationId,
  );
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
      {props.onNavigateFolder ? (
        <>
          <MenuItem
            onClick={() => {
              props.onOpenChange(false);
              props.onNavigateFolder?.(props.directoryPath);
            }}
          >
            Open folder
          </MenuItem>
          <MenuSeparator />
        </>
      ) : null}
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
            Refresh failed. Retry
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

function FolderContentsMenu(
  props: FileBreadcrumbsProps & {
    readonly crumb: FileBreadcrumb;
    /** Shown instead of the folder's name, with its own tooltip. */
    readonly label?: { readonly content: ReactNode; readonly tooltip: string };
  },
) {
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
      {props.label ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={
                  <button
                    type="button"
                    aria-label={`Browse ${props.crumb.label}`}
                    className="relative block min-w-0 max-w-40 cursor-pointer rounded-kbd px-0.5 text-left text-muted-foreground outline-none data-[current]:max-w-56 data-[current]:text-foreground pointer-coarse:after:-inset-y-3 pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 hover:surface-ghost-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:surface-selected data-popup-open:text-foreground"
                    data-current={props.label ? "" : undefined}
                  />
                }
              />
            }
          >
            {props.label ? (
              props.label.content
            ) : (
              <span className="block truncate">{props.crumb.label}</span>
            )}
          </TooltipTrigger>
          <TooltipPopup side="top">
            {props.label?.tooltip ?? (props.crumb.path || props.projectName)}
          </TooltipPopup>
        </Tooltip>
      ) : (
        <MenuTrigger
          render={
            <Button
              size="icon-micro"
              variant="ghost-muted"
              aria-label={`Browse ${props.crumb.label}`}
            />
          }
        >
          <ChevronRightIcon className="size-3.5" />
        </MenuTrigger>
      )}
      {open && props.label && isHostPath(props.relativePath) ? (
        <MenuPopup align="start" side="bottom">
          {fileBreadcrumbs(props.projectName, props.trail)
            .filter(
              (crumb) =>
                crumb.path !== breadcrumbPathOf(props.relativePath) &&
                isListableHostFolder(crumb.path),
            )
            .map((crumb) => (
              <MenuItem
                key={crumb.path}
                onClick={() => {
                  handleOpenChange(false);
                  props.onNavigateFolder(crumb.path);
                }}
              >
                {crumb.label}
              </MenuItem>
            ))}
        </MenuPopup>
      ) : open ? (
        <BreadcrumbMenuContent
          cwd={props.cwd}
          currentFilePath={props.relativePath}
          directoryPath={directoryPath}
          environmentId={props.environmentId}
          onDirectoryChange={setDirectoryPath}
          onOpenChange={handleOpenChange}
          onOpenFile={(path) => {
            if (
              breadcrumbPathOf(props.trail) !== breadcrumbPathOf(props.relativePath) &&
              breadcrumbPathOf(path) === breadcrumbPathOf(props.trail)
            ) {
              props.onNavigateFolder(path);
            } else {
              props.onOpenFile(path);
            }
          }}
          {...(props.label ? { onNavigateFolder: props.onNavigateFolder } : {})}
          projectName={props.projectName}
          rootPath={props.label ? "" : props.crumb.path}
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

  if (props.compact) {
    const file = breadcrumbs[currentIndex];
    if (!file) return null;
    const folder = props.isFolder ? file : breadcrumbs[currentIndex - 1];
    const content = (
      <span className="flex min-w-0 items-center gap-1">
        <PierreEntryIcon
          pathValue={file.path}
          kind={props.isFolder || file.kind === "project" ? "directory" : "file"}
          theme={resolvedTheme}
          className="size-3.5"
        />
        <span className="block min-w-0 truncate">{file.label}</span>
      </span>
    );
    if (!folder) {
      return (
        <span aria-current="page" className="flex min-w-0 items-center text-foreground">
          {content}
        </span>
      );
    }
    return <FolderContentsMenu {...props} crumb={folder} label={{ content, tooltip: file.path }} />;
  }

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
