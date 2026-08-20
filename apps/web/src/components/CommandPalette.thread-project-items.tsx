import type { Project } from "../types";
import {
  buildProjectActionItems,
  buildThreadActionItems,
  type BuildProjectActionItemsInput,
  type BuildThreadActionItemsInput,
  type BuildThreadActionItemsThread,
  type CommandPaletteActionItem,
} from "./CommandPalette.logic";
import { filterVisibleSidebarThreads } from "./Sidebar.logic";
import {
  ProjectCommandSubtitle,
  projectCommandLocationSearchTerms,
  type ProjectCommandLocation,
} from "./ThreadCommandSubtitle";

export function buildLocationAwareProjectActionItems(
  input: Omit<BuildProjectActionItemsInput, "renderDescription" | "searchTerms"> & {
    readonly getLocation: (project: Project) => ProjectCommandLocation | undefined;
    readonly searchTerms?: (project: Project) => ReadonlyArray<string>;
  },
): CommandPaletteActionItem[] {
  const { getLocation, searchTerms, ...actionInput } = input;

  return buildProjectActionItems({
    ...actionInput,
    searchTerms: (project) => [
      ...(searchTerms?.(project) ?? []),
      ...projectCommandLocationSearchTerms(
        getLocation(project) ?? { kind: "remote", label: "Remote" },
      ),
    ],
    renderDescription: (project) => (
      <ProjectCommandSubtitle
        location={getLocation(project) ?? { kind: "remote", label: "Remote" }}
        workspaceRoot={project.workspaceRoot}
      />
    ),
  });
}

export function buildVisibleThreadActionItems<TThread extends BuildThreadActionItemsThread>(
  input: Omit<BuildThreadActionItemsInput<TThread>, "threads"> & {
    readonly threads: ReadonlyArray<TThread>;
    readonly optimisticallyArchivedThreadKeys: ReadonlySet<string>;
  },
): CommandPaletteActionItem[] {
  const { optimisticallyArchivedThreadKeys, threads, ...actionInput } = input;

  return buildThreadActionItems({
    ...actionInput,
    threads: filterVisibleSidebarThreads(threads, optimisticallyArchivedThreadKeys),
  });
}
