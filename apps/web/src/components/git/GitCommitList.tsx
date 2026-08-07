/**
 * Recent commits for the Git panel.
 *
 * Virtualized because a long-lived repository has tens of thousands of
 * commits, and paged on demand: the panel asks for the next page only when the
 * user scrolls near the end.
 */
import { LegendList } from "@legendapp/list/react";
import type { VcsCommit } from "@t3tools/contracts";
import { useCallback } from "react";

import { cn } from "~/lib/utils";
import { orderCommitRefNames } from "./GitPanel.logic";

const ROW_ESTIMATED_HEIGHT = 44;

function CommitRefPill({ name }: { name: string }) {
  const isTag = name.startsWith("tag: ");
  return (
    <span
      className={cn(
        "shrink-0 truncate rounded-full px-1.5 py-px text-[10px] font-medium",
        isTag ? "bg-warning/15 text-warning-foreground" : "bg-info/15 text-info-foreground",
      )}
      title={name}
    >
      {isTag ? name.slice("tag: ".length) : name}
    </span>
  );
}

function CommitRow({ commit }: { commit: VcsCommit }) {
  const refNames = orderCommitRefNames(commit.refNames);
  return (
    <div className="flex items-center gap-2 px-3 py-1.5">
      <span
        aria-hidden
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          commit.isHead ? "bg-info" : "bg-muted-foreground/40",
        )}
      />
      <span className="min-w-0 flex-1 truncate text-xs" title={commit.subject}>
        {commit.subject.length > 0 ? commit.subject : commit.shortSha}
      </span>
      {commit.authorName.length > 0 ? (
        <span className="shrink-0 truncate text-[10px] text-muted-foreground uppercase max-w-24">
          {commit.authorName}
        </span>
      ) : null}
      {refNames.slice(0, 2).map((name) => (
        <CommitRefPill key={name} name={name} />
      ))}
    </div>
  );
}

export function GitCommitList({
  commits,
  hasMore,
  isLoadingMore,
  onLoadMore,
}: {
  commits: ReadonlyArray<VcsCommit>;
  hasMore: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}) {
  const renderItem = useCallback(
    ({ item }: { item: VcsCommit }) => <CommitRow commit={item} />,
    [],
  );
  const keyExtractor = useCallback((commit: VcsCommit) => commit.sha, []);
  const handleEndReached = useCallback(() => {
    if (hasMore && !isLoadingMore) onLoadMore();
  }, [hasMore, isLoadingMore, onLoadMore]);

  if (commits.length === 0) {
    return <p className="px-3 py-4 text-center text-xs text-muted-foreground">No commits yet.</p>;
  }

  return (
    <LegendList<VcsCommit>
      data={commits as VcsCommit[]}
      keyExtractor={keyExtractor}
      renderItem={renderItem}
      estimatedItemSize={ROW_ESTIMATED_HEIGHT}
      onEndReached={handleEndReached}
      onEndReachedThreshold={0.5}
      style={{ flex: 1, minHeight: 0 }}
    />
  );
}
