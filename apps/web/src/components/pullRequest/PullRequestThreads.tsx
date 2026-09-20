import type { ComponentProps, ReactNode } from "react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PullRequestThreadCard } from "./PullRequestReviewAnnotation";
import { pullRequestFindingKey, type PullRequestFinding } from "./pullRequestDetail.logic";

function ThreadResult({ visible, children }: { visible: boolean; children: ReactNode }) {
  const [visited, setVisited] = useState(visible);
  if (visible && !visited) setVisited(true);
  return visited || visible ? <div hidden={!visible}>{children}</div> : null;
}

export function PullRequestThreads({
  detail,
  pendingFinding,
  fixFindingLabel,
  onFixFinding,
  ...props
}: Omit<
  ComponentProps<typeof PullRequestThreadCard>,
  "thread" | "onFix" | "fixPending" | "fixLabel"
> & {
  pendingFinding?: string | null | undefined;
  fixFindingLabel?: string | undefined;
  onFixFinding?: ((finding: PullRequestFinding) => void) | undefined;
}) {
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");
  const [limit, setLimit] = useState(10);
  const open = detail.reviewThreads.filter((thread) => !thread.isResolved).length;
  const filtered = detail.reviewThreads.filter(
    (thread) =>
      filter === "all" || (filter === "resolved" ? thread.isResolved : !thread.isResolved),
  );
  const visible = new Set(filtered.slice(0, limit).map((thread) => thread.id));
  return (
    <div className="space-y-3">
      <ToggleGroup
        aria-label="Filter review threads"
        variant="segmented"
        value={[filter]}
        onValueChange={(values) => {
          const value = values[0];
          if (value !== "all" && value !== "open" && value !== "resolved") return;
          setFilter(value);
          setLimit(10);
        }}
      >
        <Toggle value="open">
          Open <span className="tabular-nums">{open}</span>
        </Toggle>
        <Toggle value="resolved">
          Resolved <span className="tabular-nums">{detail.reviewThreads.length - open}</span>
        </Toggle>
        <Toggle value="all">
          All <span className="tabular-nums">{detail.reviewThreads.length}</span>
        </Toggle>
      </ToggleGroup>
      {filtered.length === 0 ? (
        <p className="py-2 text-xs text-muted-foreground">
          {filter === "open"
            ? "No open threads."
            : filter === "resolved"
              ? "No resolved threads."
              : "No review threads yet."}
        </p>
      ) : null}
      {detail.reviewThreads.map((thread) => (
        <ThreadResult key={thread.id} visible={visible.has(thread.id)}>
          <PullRequestThreadCard
            {...props}
            className="m-0"
            detail={detail}
            thread={thread}
            {...(fixFindingLabel ? { fixLabel: fixFindingLabel } : {})}
            fixPending={pendingFinding === pullRequestFindingKey({ kind: "thread", thread })}
            {...(onFixFinding && !thread.isResolved
              ? { onFix: () => onFixFinding({ kind: "thread", thread }) }
              : {})}
          />
        </ThreadResult>
      ))}
      {filtered.length > limit ? (
        <Button
          size="sm"
          variant="outline"
          className="w-full"
          onClick={() => setLimit((count) => count + 10)}
        >
          Show {Math.min(10, filtered.length - limit)} more threads ({filtered.length - limit}{" "}
          remaining)
        </Button>
      ) : null}
    </div>
  );
}
