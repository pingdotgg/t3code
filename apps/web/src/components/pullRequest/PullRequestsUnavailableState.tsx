import { RefreshIcon } from "~/components/ui/refresh-icon";
import { ExternalLinkIcon } from "lucide-react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "../ui/empty";
import { describeSourceControlRateLimitError } from "./pullRequestDiffError";
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
  const description = describeSourceControlRateLimitError(error, timestampFormat);
  const resumeIndex = description.lastIndexOf("Resumes ");
  const resumeOnly = resumeIndex >= 0 ? description.slice(resumeIndex) : null;
  const preface =
    resumeOnly !== null && resumeIndex > 0 ? description.slice(0, resumeIndex).trim() : null;

  return (
    <Empty className="scrollbar-gutter-both min-h-0 justify-center-safe overflow-y-auto [&>*]:shrink-0">
      <EmptyMedia variant="icon">
        <PullRequestGlyph.pullRequest />
      </EmptyMedia>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        {resumeOnly !== null ? (
          <>
            {preface ? <EmptyDescription>{preface}</EmptyDescription> : null}
            <p className="mt-1 text-sm text-foreground">{resumeOnly.replace(/\.$/u, "")}</p>
          </>
        ) : (
          <EmptyDescription>{description}</EmptyDescription>
        )}
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
