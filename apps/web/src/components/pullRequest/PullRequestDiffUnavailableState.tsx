import type { SourceControlProviderKind } from "@t3tools/contracts";
import { ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";

import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { Button, InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { describePullRequestDiffError } from "./pullRequestDiffError";

export function PullRequestDiffUnavailableState({
  error,
  provider,
  url,
  onRetry,
}: {
  error: string;
  provider: SourceControlProviderKind;
  url: string;
  onRetry: () => void;
}) {
  const { providerName, terminology } = getSourceControlPresentationForKind(provider);
  const { title, description } = describePullRequestDiffError(
    error,
    providerName,
    terminology.singular,
  );

  return (
    <Empty size="compact" className="min-h-full" role="status">
      <div className="flex size-11 items-center justify-center rounded-full bg-warning-surface text-warning">
        <TriangleAlertIcon aria-hidden className="size-5" />
      </div>
      <EmptyHeader>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
      <div className="flex flex-wrap justify-center gap-2">
        <Button size="sm" variant="default" onClick={onRetry}>
          <RefreshIcon />
          Try again
        </Button>
        <Button
          size="sm"
          variant="secondary"
          render={<a href={url} target="_blank" rel="noopener noreferrer" />}
        >
          <ExternalLinkIcon aria-hidden />
          Open on {providerName}
        </Button>
      </div>
      <details className="w-full max-w-lg text-meta text-muted-foreground">
        <InlineButton tone="muted" render={<summary />} className="mx-auto w-fit list-item">
          Technical details
        </InlineButton>
        <pre className="scrollbar-gutter-both mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 text-left font-mono text-meta">
          {error}
        </pre>
      </details>
    </Empty>
  );
}
