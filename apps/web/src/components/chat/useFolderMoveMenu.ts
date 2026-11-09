import {
  filterFilesystemBrowseEntries,
  getFilesystemBrowsePath,
} from "@t3tools/client-runtime/state/filesystem";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type { EnvironmentId, FilesystemBrowseEntry } from "@t3tools/contracts";

import { useProjects, useThreadShells } from "~/state/entities";
import { filesystemEnvironment, useFilesystemReadAccess } from "~/state/filesystem";
import { useEnvironmentPresentation } from "~/state/presentation";
import { useEnvironmentQuery } from "~/state/query";
import { getEnvironmentBrowsePlatform } from "../CommandPalette.logic";
import type { ComposerCommandItem } from "./ComposerCommandMenu";
import {
  folderMoveFolderRows,
  folderMoveNoMatchText,
  folderMoveProjectRows,
  folderMoveQueryPath,
} from "./folderMoveDestinations";

const NO_ENTRIES: ReadonlyArray<FilesystemBrowseEntry> = [];

/**
 * The `/cd` destination pane: the environment's projects for an empty or a name query, and the
 * folders under the typed path for a path query. `query` is null while the pane is closed.
 */
export function useFolderMoveMenu(input: {
  readonly query: string | null;
  readonly environmentId: EnvironmentId;
  /** The thread's working folder: the folder a relative path starts from. */
  readonly currentFolder: string | null;
  readonly inNoProject: boolean;
  readonly disabledReason: string | null;
}) {
  const active = input.query !== null && input.disabledReason === null;
  const projects = useProjects();
  const threads = useThreadShells(active);
  const { presentation } = useEnvironmentPresentation(input.environmentId);
  const platform = getEnvironmentBrowsePlatform(
    presentation?.serverConfig?.environment.platform.os,
  );
  const typed = folderMoveQueryPath(input.query ?? "");
  const browse = getFilesystemBrowsePath(typed, platform, active);
  const access = useFilesystemReadAccess(browse.isBrowsing ? input.environmentId : null);
  const listing = useEnvironmentQuery(
    access.canReadFiles && browse.isBrowsing && browse.directoryPath.length > 0
      ? filesystemEnvironment.browse({
          environmentId: input.environmentId,
          input: {
            partialPath: browse.directoryPath,
            ...(input.currentFolder ? { cwd: input.currentFolder } : {}),
          },
        })
      : null,
  );
  const entries = listing.data
    ? filterFilesystemBrowseEntries(listing.data.entries, browse.filterQuery).visibleEntries
    : NO_ENTRIES;
  // An older server omits the flag and lists a folder it may not read as an empty one.
  const unreadable = listing.data?.unreadable === true;
  const scratchRoot = presentation?.serverConfig?.scratchWorkspaceRoot ?? null;
  const environmentProjects = projects.filter(
    (project) =>
      project.environmentId === input.environmentId && !isScratchProject(project, scratchRoot),
  );
  const rows = !active
    ? []
    : browse.isBrowsing
      ? listing.data
        ? folderMoveFolderRows({
            projects: environmentProjects,
            currentFolder: input.currentFolder,
            query: input.query ?? "",
            platform,
            directoryFullPath: listing.data.parentPath,
            entries,
            unreadable,
          })
        : []
      : folderMoveProjectRows({
          projects: environmentProjects,
          threads: threads.filter((thread) => thread.environmentId === input.environmentId),
          currentFolder: input.currentFolder,
          inNoProject: input.inNoProject,
          query: input.query ?? "",
        });
  const cannotRead =
    browse.isBrowsing && (unreadable || listing.error !== null || access.error !== null);
  const cannotReadText = `Cannot read ${listing.data?.parentPath ?? browse.directoryPath}.`;
  const noMatch = active
    ? folderMoveNoMatchText({
        query: input.query ?? "",
        platform,
        directoryFullPath: listing.data?.parentPath ?? null,
        entries,
        rowCount: rows.length,
      })
    : null;
  return {
    items: rows.map((row): ComposerCommandItem => ({
      ...row,
      type: "folder-destination" as const,
    })),
    isLoading: browse.isBrowsing && !cannotRead && listing.data === null && rows.length === 0,
    emptyState:
      input.disabledReason ??
      (cannotRead
        ? cannotReadText
        : (noMatch ??
          (browse.isBrowsing
            ? "No matching folders."
            : "No other project. Type a path to move to a folder."))),
    /** A message below the rows. The menu shows `emptyState` instead when it has no row. */
    footer: rows.length === 0 ? null : cannotRead ? cannotReadText : noMatch,
    /** The folders the typed name matches, for Tab completion. */
    entries,
    platform,
    /** True for a path query, which lists folders. False for a project-name query. */
    isBrowsing: browse.isBrowsing,
  };
}
