import { Branch, T } from "gt-react";

import { RefreshIcon } from "~/components/ui/refresh-icon";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";

import type { ChangeRequestTermKind } from "./changeRequestTerm";

export function PullRequestActivityUnavailableState({
  error,
  term,
  onRetry,
  compact = false,
}: {
  error: string;
  term: ChangeRequestTermKind;
  onRetry: () => void;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 text-center",
        compact ? "py-3" : "min-h-48 px-4 py-10",
      )}
    >
      <p className="text-sm font-medium text-foreground">
        <T>
          Could not load{" "}
          <Branch branch={term} mr="merge request" cr="change request">
            pull request
          </Branch>{" "}
          activity
        </T>
      </p>
      <p className="max-w-md text-xs text-muted-foreground">{error}</p>
      <Button size="sm" variant="outline" onClick={onRetry}>
        <RefreshIcon aria-hidden size="sm" />
        <T>Retry</T>
      </Button>
    </div>
  );
}
