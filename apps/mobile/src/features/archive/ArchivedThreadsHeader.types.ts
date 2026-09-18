import type { EnvironmentId } from "@t3tools/contracts";
import type { ArchivedThreadSortOrder } from "./archivedThreadList";

export interface ArchivedThreadsHeaderEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface ArchivedThreadsHeaderProps {
  readonly environments: ReadonlyArray<ArchivedThreadsHeaderEnvironment>;
  readonly searchQuery: string;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly sortOrder: ArchivedThreadSortOrder;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onRefresh: () => void;
  readonly onSearchQueryChange: (query: string) => void;
  readonly onSortOrderChange: (sortOrder: ArchivedThreadSortOrder) => void;
}
