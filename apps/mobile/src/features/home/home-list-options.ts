import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import {
  DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
  DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
} from "@t3tools/contracts";
import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useMemo,
  useState,
  type PropsWithChildren,
  type Dispatch,
  type SetStateAction,
} from "react";

import type { HomeProjectSortOrder } from "./homeThreadList";

export interface HomeListOptions {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectSortOrder: HomeProjectSortOrder;
  readonly threadSortOrder: SidebarThreadSortOrder;
}

export interface ResolvedHomeListOptions extends HomeListOptions {
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

export function resolveProjectGroupingMode(
  projectGroupingEnabled: boolean | undefined,
): SidebarProjectGroupingMode {
  return projectGroupingEnabled === false ? "separate" : "repository";
}

export const PROJECT_SORT_OPTIONS: ReadonlyArray<{
  readonly value: HomeProjectSortOrder;
  readonly label: string;
}> = [
  { value: "updated_at", label: "Last user message" },
  { value: "created_at", label: "Created at" },
];

export const THREAD_SORT_OPTIONS: ReadonlyArray<{
  readonly value: SidebarThreadSortOrder;
  readonly label: string;
}> = [
  { value: "updated_at", label: "Last user message" },
  { value: "created_at", label: "Created at" },
];

function defaultHomeListOptions(): HomeListOptions {
  return {
    selectedEnvironmentId: null,
    projectSortOrder:
      DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
        ? "updated_at"
        : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
    threadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
  };
}

interface HomeListOptionsContextValue {
  readonly options: HomeListOptions;
  readonly setOptions: Dispatch<SetStateAction<HomeListOptions>>;
  readonly projectGroupingMode: SidebarProjectGroupingMode;
}

const HomeListOptionsContext = createContext<HomeListOptionsContextValue | null>(null);

/** Keeps list preferences stable while the app moves between compact and split shells. */
export function HomeListOptionsProvider({
  children,
  projectGroupingMode,
}: PropsWithChildren<{ readonly projectGroupingMode: SidebarProjectGroupingMode }>) {
  const [options, setOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const value = useMemo(
    () => ({ options, setOptions, projectGroupingMode }),
    [options, projectGroupingMode],
  );
  return createElement(HomeListOptionsContext, { value }, children);
}

export function hasCustomHomeListOptions(
  options: HomeListOptions & {
    readonly selectedProjectKey?: string | null;
  },
): boolean {
  const defaultProjectSortOrder =
    DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
      ? "updated_at"
      : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER;
  return (
    options.selectedEnvironmentId !== null ||
    (options.selectedProjectKey !== null && options.selectedProjectKey !== undefined) ||
    options.projectSortOrder !== defaultProjectSortOrder ||
    options.threadSortOrder !== DEFAULT_SIDEBAR_THREAD_SORT_ORDER
  );
}

export function useHomeListOptions(availableEnvironmentIds: ReadonlySet<EnvironmentId>) {
  const shared = useContext(HomeListOptionsContext);
  const [localOptions, setLocalOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const options = shared?.options ?? localOptions;
  const setOptions = shared?.setOptions ?? setLocalOptions;
  const selectedEnvironmentId =
    options.selectedEnvironmentId !== null &&
    availableEnvironmentIds.has(options.selectedEnvironmentId)
      ? options.selectedEnvironmentId
      : null;
  const availableOptions =
    selectedEnvironmentId === options.selectedEnvironmentId
      ? options
      : { ...options, selectedEnvironmentId };
  const resolvedOptions: ResolvedHomeListOptions = {
    ...availableOptions,
    projectGroupingMode: shared?.projectGroupingMode ?? "repository",
  };

  const setSelectedEnvironmentId = useCallback((value: EnvironmentId | null) => {
    setOptions((current) => ({ ...current, selectedEnvironmentId: value }));
  }, []);
  const setProjectSortOrder = useCallback((value: HomeProjectSortOrder) => {
    setOptions((current) => ({ ...current, projectSortOrder: value }));
  }, []);
  const setThreadSortOrder = useCallback((value: SidebarThreadSortOrder) => {
    setOptions((current) => ({ ...current, threadSortOrder: value }));
  }, []);
  return {
    options: resolvedOptions,
    setSelectedEnvironmentId,
    setProjectSortOrder,
    setThreadSortOrder,
  } as const;
}
