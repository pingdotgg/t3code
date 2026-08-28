import { RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";

export function UnavailableState({
  icon,
  title,
  error,
  onRetry,
  action,
}: {
  /** The surface's own glyph, so a failed list still looks like the list it failed to be. */
  icon: ReactNode;
  title: string;
  error: string;
  onRetry?: (() => void) | undefined;
  action?: ReactNode;
}) {
  return (
    <Empty className="px-4 py-16 md:px-4">
      <EmptyMedia variant="icon">{icon}</EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {/* The caller names the fix — update the environment, install gh, sign in — so this
            shows its message rather than trying to infer one from the failure text. */}
        <EmptyDescription>{error}</EmptyDescription>
      </EmptyHeader>
      {onRetry || action ? (
        <EmptyContent className="flex-row flex-wrap justify-center gap-2">
          {onRetry ? (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RefreshCwIcon className="size-3.5" />
              Retry
            </Button>
          ) : null}
          {action}
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
