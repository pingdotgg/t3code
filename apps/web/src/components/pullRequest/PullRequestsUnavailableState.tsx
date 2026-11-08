import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ExternalLinkIcon } from "lucide-react";

import { useNowAfter } from "../../hooks/useDeadline";
import { usePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import {
  describeSourceControlRateLimitError,
  sourceControlRateLimitResumeDeadlineMs,
} from "./pullRequestDiffError";
import { PullRequestGlyph } from "./pullRequestIcons";

export function PullRequestsUnavailableState({
  title = "Could not load pull requests",
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
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const nowMs = useNowAfter(sourceControlRateLimitResumeDeadlineMs(error));
  const description = describeSourceControlRateLimitError(error, timestampFormat, nowMs);

  return (
    <Empty className="scrollbar-gutter-both min-h-0 justify-center-safe overflow-y-auto [&>*]:shrink-0">
      <EmptyMedia variant="icon">
        <PullRequestGlyph.pullRequest />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      {onRetry || host ? (
        <div className="flex flex-wrap justify-center gap-2">
          {onRetry ? (
            <Button
              size="sm"
              variant="outline"
              onClick={onRetry}
              disabled={refreshing}
              aria-busy={refreshing}
            >
              <RefreshIcon size="sm" refreshing={refreshing} />
              Retry
            </Button>
          ) : null}
          {host ? (
            <Button
              size="sm"
              variant="outline"
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
