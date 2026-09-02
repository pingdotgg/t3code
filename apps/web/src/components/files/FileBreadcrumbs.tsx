import type { EnvironmentId } from "@t3tools/contracts";
import { ArrowLeftIcon, ChevronRightIcon, LoaderCircleIcon, RotateCwIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { PierreEntryIcon } from "~/components/chat/PierreEntryIcon";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuPopup,
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
} from "./filePath";
import { useProjectEntriesQuery } from "./projectFilesQueryState";

interface FileBreadcrumbsProps {
  readonly cwd: string;
  readonly environmentId: EnvironmentId;
  readonly onOpenFile: (relativePath: string) => void;
  readonly projectName: string;
  readonly relativePath: string;
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
      <TooltipPopup side="top" className="max-w-80">
        {props.pathLabel}
      </TooltipPopup>
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
  const entriesQuery = useProjectEntriesQuery(props.environmentId, props.cwd);
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
  const directoryAvailable =
    props.directoryPath === "" ||
    entries.some((entry) => entry.kind === "directory" && entry.path === props.directoryPath);
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
      className="w-max min-w-32 max-w-[min(19rem,var(--available-width))]"
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
            <LoaderCircleIcon className="animate-spin" />
            Loading folder…
          </MenuItem>
        ) : entriesQuery.error && entriesQuery.data === null ? (
          <MenuItem closeOnClick={false} onClick={entriesQuery.refresh}>
            <RotateCwIcon />
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
          children.map((entry) => {
            const isCurrentFile = entry.kind === "file" && entry.path === props.currentFilePath;
            return (
              <MenuItem
                key={entry.path}
                closeOnClick={entry.kind === "file"}
                aria-current={isCurrentFile ? "page" : undefined}
                className={cn(isCurrentFile && "bg-foreground/[0.08]")}
                onClick={() => {
                  if (entry.kind === "directory") {
                    props.onDirectoryChange(entry.path);
                    return;
                  }
                  props.onOpenChange(false);
                  props.onOpenFile(entry.path);
                }}
              >
                <PierreEntryIcon pathValue={entry.path} kind={entry.kind} theme={resolvedTheme} />
                <Tooltip>
                  <TooltipTrigger render={<span className="min-w-0 flex-1 truncate" />}>
                    {entry.label}
                  </TooltipTrigger>
                  <TooltipPopup side="right" className="max-w-80">
                    {entry.path}
                  </TooltipPopup>
                </Tooltip>
                {entry.kind === "directory" ? <ChevronRightIcon /> : null}
              </MenuItem>
            );
          })
        )}
      </MenuGroup>
      {entriesQuery.error && entriesQuery.data !== null ? (
        <>
          <MenuSeparator />
          <MenuItem closeOnClick={false} onClick={entriesQuery.refresh}>
            <RotateCwIcon />
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

function DirectoryBreadcrumb(props: FileBreadcrumbsProps & { readonly crumb: FileBreadcrumb }) {
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
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <button
                  type="button"
                  aria-label={`Browse ${props.crumb.label}`}
                  className="relative block max-w-40 cursor-pointer rounded-sm px-0.5 text-left text-muted-foreground outline-none pointer-coarse:after:-inset-y-3 pointer-coarse:after:absolute pointer-coarse:after:inset-x-0 hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-accent data-popup-open:text-foreground"
                />
              }
            />
          }
        >
          <span className="block truncate">{props.crumb.label}</span>
        </TooltipTrigger>
        <TooltipPopup side="top" className="max-w-80">
          {props.crumb.path || props.projectName}
        </TooltipPopup>
      </Tooltip>
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

export function FileBreadcrumbs(props: FileBreadcrumbsProps) {
  const hostPath = isAbsolutePath(props.relativePath);
  const breadcrumbs = useMemo(
    () => fileBreadcrumbs(props.projectName, props.relativePath),
    [props.projectName, props.relativePath],
  );

  return breadcrumbs.map((crumb, index) => (
    <div
      key={crumb.path || "project"}
      className="flex min-w-0 shrink-0 items-center"
      data-current-file-crumb={crumb.kind === "file"}
    >
      {index > 0 ? (
        <ChevronRightIcon className="mx-1 size-3.5 shrink-0 text-muted-foreground/60" />
      ) : null}
      {crumb.kind === "file" ? (
        <span aria-current="page">
          <BreadcrumbLabel current label={crumb.label} pathLabel={crumb.path} />
        </span>
      ) : hostPath ? (
        <BreadcrumbLabel label={crumb.label} pathLabel={crumb.path} />
      ) : (
        <DirectoryBreadcrumb {...props} crumb={crumb} />
      )}
    </div>
  ));
}
