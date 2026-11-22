import { RefreshIcon } from "~/components/ui/refresh-icon";
import { T, useGT } from "gt-react";
import { ExternalLinkIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { PullRequestGlyph } from "./pullRequestIcons";

export function PullRequestsUnavailableState({
  title,
  error,
  onRetry,
  refreshing = false,
  host,
}: {
  title?: string;
  error: string;
  onRetry?: () => void;
  refreshing?: boolean;
  host?: { readonly url: string; readonly openLabel: string };
}) {
  const gt = useGT();
  return (
    <Empty className="scrollbar-gutter-both min-h-0 justify-center-safe overflow-y-auto [&>*]:shrink-0">
      <EmptyMedia variant="icon">
        <PullRequestGlyph.pullRequest />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title ?? gt("Could not load pull requests")}</EmptyTitle>
        <EmptyDescription>{error}</EmptyDescription>
      </EmptyHeader>
      {onRetry || host ? (
        <div className="flex flex-wrap justify-center gap-2">
          {onRetry ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={onRetry}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              <RefreshIcon size="sm" refreshing={refreshing} />
              <T>Retry</T>
            </Button>
          ) : null}
          {host ? (
            <Button
              size="sm"
              variant="secondary"
              render={<a href={host.url} target="_blank" rel="noopener noreferrer" />}
            >
              <ExternalLinkIcon aria-hidden className="size-3.5" />
              {host.openLabel}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Empty>
  );
}
