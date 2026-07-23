import type {
  EnvironmentId,
  SidebarProjectGroupingMode,
  SidebarThreadSortOrder,
} from "@t3tools/contracts";
import {
  DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE,
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
  readonly projectGroupingMode: SidebarProjectGroupingMode;
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

export const PROJECT_GROUPING_OPTIONS: ReadonlyArray<{
  readonly value: SidebarProjectGroupingMode;
  readonly label: string;
  readonly subtitle: string;
}> = [
  {
    value: "repository",
    label: "Group by repository",
    subtitle: "Combine matching repositories across environments",
  },
  {
    value: "repository_path",
    label: "Group by repository path",
    subtitle: "Combine only matching paths within a repository",
  },
  {
    value: "separate",
    label: "Keep separate",
    subtitle: "Show every project path separately",
  },
];

function defaultHomeListOptions(): HomeListOptions {
  return {
    selectedEnvironmentId: null,
    projectSortOrder:
      DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
        ? "updated_at"
        : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER,
    threadSortOrder: DEFAULT_SIDEBAR_THREAD_SORT_ORDER,
    projectGroupingMode: DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE,
  };
}

interface HomeListOptionsContextValue {
  readonly options: HomeListOptions;
  readonly setOptions: Dispatch<SetStateAction<HomeListOptions>>;
}

const HomeListOptionsContext = createContext<HomeListOptionsContextValue | null>(null);

/** Keeps list preferences stable while the app moves between compact and split shells. */
export function HomeListOptionsProvider({ children }: PropsWithChildren) {
  const [options, setOptions] = useState<HomeListOptions>(defaultHomeListOptions);
  const value = useMemo(() => ({ options, setOptions }), [options]);
  return createElement(HomeListOptionsContext, { value }, children);
}

export function hasCustomHomeListOptions(
  options: HomeListOptions & { readonly selectedProjectKey?: string | null },
): boolean {
  const defaultProjectSortOrder =
    DEFAULT_SIDEBAR_PROJECT_SORT_ORDER === "manual"
      ? "updated_at"
      : DEFAULT_SIDEBAR_PROJECT_SORT_ORDER;
  return (
    options.selectedEnvironmentId !== null ||
    (options.selectedProjectKey !== null && options.selectedProjectKey !== undefined) ||
    options.projectSortOrder !== defaultProjectSortOrder ||
    options.threadSortOrder !== DEFAULT_SIDEBAR_THREAD_SORT_ORDER ||
    options.projectGroupingMode !== DEFAULT_SIDEBAR_PROJECT_GROUPING_MODE
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
  const resolvedOptions =
    selectedEnvironmentId === options.selectedEnvironmentId
      ? options
      : { ...options, selectedEnvironmentId };

  const setSelectedEnvironmentId = useCallback((value: EnvironmentId | null) => {
    setOptions((current) => ({ ...current, selectedEnvironmentId: value }));
  }, []);
  const setProjectSortOrder = useCallback((value: HomeProjectSortOrder) => {
    setOptions((current) => ({ ...current, projectSortOrder: value }));
  }, []);
  const setThreadSortOrder = useCallback((value: SidebarThreadSortOrder) => {
    setOptions((current) => ({ ...current, threadSortOrder: value }));
  }, []);
  const setProjectGroupingMode = useCallback((value: SidebarProjectGroupingMode) => {
    setOptions((current) => ({ ...current, projectGroupingMode: value }));
  }, []);

  return {
    options: resolvedOptions,
    setSelectedEnvironmentId,
    setProjectSortOrder,
    setThreadSortOrder,
    setProjectGroupingMode,
  } as const;
}
