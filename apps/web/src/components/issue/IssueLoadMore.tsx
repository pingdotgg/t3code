import { useEffect, useRef } from "react";

import type { IssuePagedView } from "~/state/issues";

import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";

export function IssueScrollSentinel({
  hasMore,
  isPending,
  error,
  loadMore,
}: Pick<IssuePagedView<unknown>, "hasMore" | "isPending" | "error" | "loadMore">) {
  const sentinel = useRef<HTMLDivElement>(null);
  const retryRequested = useRef(false);
  useEffect(() => {
    retryRequested.current = false;
    if (!hasMore || isPending || error !== null || sentinel.current === null) return;
    let active = true;
    let requested = false;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!active || requested || !entries.some((entry) => entry.isIntersecting)) return;
        requested = true;
        loadMore();
      },
      { rootMargin: "160px" },
    );
    observer.observe(sentinel.current);
    return () => {
      active = false;
      observer.disconnect();
    };
  }, [hasMore, isPending, error, loadMore]);

  return (
    <>
      {error !== null ? (
        <div className="space-y-1 text-center">
          <p role="alert" className="text-xs text-muted-foreground">
            More items could not be read. {error}
          </p>
          {hasMore ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={isPending}
              onClick={() => {
                if (retryRequested.current) return;
                retryRequested.current = true;
                loadMore();
              }}
            >
              Retry
            </Button>
          ) : null}
        </div>
      ) : null}
      {hasMore ? <div ref={sentinel} className="h-px" aria-hidden /> : null}
      {isPending ? (
        <div role="status" className="flex justify-center">
          <Spinner aria-hidden size="sm" />
          <span className="sr-only">Loading more items</span>
        </div>
      ) : null}
    </>
  );
}

export function IssueLoadMore({
  page,
  label,
}: {
  page: Pick<
    IssuePagedView<unknown>,
    "hasMore" | "isPending" | "truncated" | "loadMore" | "items" | "error"
  >;
  label: string;
}) {
  return (
    <div aria-label={label} className="space-y-2">
      <IssueScrollSentinel
        hasMore={page.hasMore}
        isPending={page.isPending}
        error={page.error}
        loadMore={page.loadMore}
      />
      {page.truncated ? (
        <p className="text-center text-2xs text-muted-foreground">
          The tracker returned part of this list. Open it on the host for the rest.
        </p>
      ) : null}
    </div>
  );
}
