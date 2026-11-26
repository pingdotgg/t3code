import type { ScopedThreadRef, SourceControlProviderKind } from "@t3tools/contracts";
import { T, useMessages, Var } from "gt-react";
import { ExternalLinkIcon, TriangleAlertIcon } from "lucide-react";

import { useOpenLink } from "~/browser/useOpenLink";
import { getSourceControlPresentationForKind } from "~/sourceControlPresentation";

import { Button } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { RefreshIcon } from "../ui/refresh-icon";
import { changeRequestTermKind } from "./changeRequestTerm";
import { describePullRequestDiffError } from "./pullRequestDiffError";

export function PullRequestDiffUnavailableState({
  error,
  provider,
  url,
  threadRef,
  onRetry,
}: {
  error: string;
  provider: SourceControlProviderKind;
  url: string;
  threadRef: ScopedThreadRef | null;
  onRetry: () => void;
}) {
  const m = useMessages();
  const openLink = useOpenLink(threadRef);
  const { providerName, terminology } = getSourceControlPresentationForKind(provider);
  const { title, description } = describePullRequestDiffError(
    error,
    providerName,
    changeRequestTermKind(terminology),
    m,
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
          <T>Try again</T>
        </Button>
        <Button
          size="sm"
          variant="outline"
          render={<a href={url} target="_blank" rel="noopener noreferrer" />}
          onClick={(event) => {
            event.preventDefault();
            void openLink(url, { event }).catch(console.error);
          }}
        >
          <ExternalLinkIcon aria-hidden />
          <T>
            Open on <Var>{providerName}</Var>
          </T>
        </Button>
      </div>
      <details className="w-full max-w-lg text-xs text-muted-foreground">
        <summary className="mx-auto w-fit cursor-pointer rounded-sm -outline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <T>Technical details</T>
        </summary>
        <pre className="scrollbar-gutter-both mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-muted/40 p-3 text-left font-mono text-xs">
          {error}
        </pre>
      </details>
    </Empty>
  );
}
