import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { useLocalStorage } from "../../../hooks/useLocalStorage";
import { resolveProjectExpanded } from "../../../uiStateStore";
import type { SidebarProjectSnapshot } from "../../../sidebarProjectGrouping";
import { groupSidebarThreadsByProject, sidebarFolderExpansionKeys } from "../../Sidebar.logic";
import {
  arrangeDetailedFolder,
  detailedFolderShows,
  workersByParent,
} from "./sidebarVariant.logic";

const PARKED_OPEN_KEY = "t3code:sidebar:detailed-parked-open";
const ParkedOpenKeys = Schema.Array(Schema.String);
const keepEveryGroup = () => true;

/** Detailed keeps each project's threads in its folder, so it arranges pinned and parked rows too. */
export function useDetailedFolders(
  input: {
    readonly groups: readonly SidebarProjectSnapshot[];
    readonly threads: readonly EnvironmentThreadShell[];
    readonly pinned: readonly EnvironmentThreadShell[];
    readonly active: readonly EnvironmentThreadShell[];
    readonly snoozed: readonly EnvironmentThreadShell[];
    readonly settled: readonly EnvironmentThreadShell[];
    readonly projectExpandedById: Readonly<Record<string, boolean>>;
    readonly routeRowKey: string | null;
    readonly routeThreadKey: string | null;
    readonly keepEmpty: (group: SidebarProjectSnapshot) => boolean;
  } | null,
) {
  const [workerFold, setWorkerFold] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [parkedOpenKeys, setParkedOpenKeys] = useLocalStorage(
    PARKED_OPEN_KEY,
    [] as readonly string[],
    ParkedOpenKeys,
  );
  if (input === null) return null;

  const workers = workersByParent(input.threads);
  const inGroups = (list: readonly EnvironmentThreadShell[]) =>
    new Map(
      groupSidebarThreadsByProject(input.groups, list, keepEveryGroup).map((entry) => [
        entry.group.projectKey,
        entry.threads,
      ]),
    );
  const pinned = inGroups(input.pinned);
  const active = inGroups(input.active);
  const snoozed = inGroups(input.snoozed);
  const settled = inGroups(input.settled);

  const folders = input.groups.flatMap((group) => {
    const key = group.projectKey;
    const lists = {
      pinned: pinned.get(key) ?? [],
      active: active.get(key) ?? [],
      snoozed: snoozed.get(key) ?? [],
      settled: settled.get(key) ?? [],
    };
    if (!detailedFolderShows(lists, input.keepEmpty(group))) return [];
    const collapsed = !resolveProjectExpanded(
      input.projectExpandedById,
      sidebarFolderExpansionKeys(group),
    );
    return [
      {
        group,
        collapsed,
        ...arrangeDetailedFolder({
          ...lists,
          collapsed,
          workers,
          workerFold,
          parkedOpen: parkedOpenKeys.includes(key),
          routeRowKey: input.routeRowKey,
          routeThreadKey: input.routeThreadKey,
        }),
      },
    ];
  });

  return {
    folders,
    orderedThreads: folders.flatMap((folder) =>
      folder.items.flatMap((item) => (item.kind === "thread" ? [item.thread] : [])),
    ),
    toggleWorkers: (parentKey: string, open: boolean) =>
      setWorkerFold((current) => new Map(current).set(parentKey, !open)),
    toggleParked: (projectKey: string) =>
      setParkedOpenKeys((current) =>
        current.includes(projectKey)
          ? current.filter((key) => key !== projectKey)
          : [...current, projectKey],
      ),
  };
}
