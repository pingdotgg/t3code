import type { GitRewriteableCommit } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import { ScrollArea } from "./ui/scroll-area";

export function CommitRangePicker({
  commits,
  startIndex,
  endIndex,
  onRangeChange,
  onReset,
}: {
  readonly commits: ReadonlyArray<GitRewriteableCommit>;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly onReset: () => void;
  readonly onRangeChange: (startIndex: number, endIndex: number) => void;
}) {
  const selectedCount = Math.max(0, endIndex - startIndex + 1);
  return (
    <div className="overflow-hidden rounded-md border border-input">
      <div className="flex items-center justify-between gap-3 border-b border-input px-3 py-2">
        <div className="text-xs">
          <p aria-live="polite" className="font-medium">
            {selectedCount} {selectedCount === 1 ? "commit" : "commits"} selected
          </p>
          <p className="text-muted-foreground">Oldest to newest · both ends included</p>
        </div>
        <Button variant="ghost" size="xs" onClick={onReset}>
          All commits
        </Button>
      </div>
      <ScrollArea className="h-72">
        <ol aria-label="Commit range">
          {commits.map((commit, index) => {
            const selected = index >= startIndex && index <= endIndex;
            const isStart = index === startIndex;
            const isEnd = index === endIndex;
            return (
              <li key={commit.sha} className={cn("flex gap-3 px-3", selected && "bg-primary/8")}>
                <div aria-hidden="true" className="relative w-3 shrink-0">
                  {index > 0 && (
                    <span
                      className={cn(
                        "absolute top-0 left-1/2 h-1/2 w-0.5 -translate-x-1/2",
                        index > startIndex && index <= endIndex ? "bg-primary" : "bg-border",
                      )}
                    />
                  )}
                  {index < commits.length - 1 && (
                    <span
                      className={cn(
                        "absolute bottom-0 left-1/2 h-1/2 w-0.5 -translate-x-1/2",
                        index >= startIndex && index < endIndex ? "bg-primary" : "bg-border",
                      )}
                    />
                  )}
                  <span
                    className={cn(
                      "absolute top-1/2 left-1/2 size-2.5 -translate-1/2 rounded-full",
                      selected ? "bg-primary" : "bg-border",
                    )}
                  />
                </div>
                <div className="min-w-0 flex-1 space-y-1 py-2.5">
                  <p className="break-words text-sm font-medium">{commit.subject}</p>
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      {commit.shortSha}
                    </span>
                    <div className="flex gap-1">
                      <Button
                        variant={isStart ? "default" : "ghost-muted"}
                        size="xs"
                        aria-label={`Start at ${commit.shortSha}: ${commit.subject}`}
                        aria-pressed={isStart}
                        onClick={() => onRangeChange(index, Math.max(index, endIndex))}
                      >
                        {isStart ? "Start" : "Start here"}
                      </Button>
                      <Button
                        variant={isEnd ? "default" : "ghost-muted"}
                        size="xs"
                        aria-label={`End at ${commit.shortSha}: ${commit.subject}`}
                        aria-pressed={isEnd}
                        onClick={() => onRangeChange(Math.min(index, startIndex), index)}
                      >
                        {isEnd ? "End" : "End here"}
                      </Button>
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      </ScrollArea>
    </div>
  );
}
