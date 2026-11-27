import type { PullRequestContextMetadata } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { useGT, useMessages } from "gt-react";
import { ArrowRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";

import { changeRequestTermKind } from "./pullRequest/changeRequestTerm";
import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";

export function PullRequestContextDetails({ metadata }: { metadata: PullRequestContextMetadata }) {
  const gt = useGT();
  const messages = useMessages();
  const state = resolvePullRequestState(metadata, messages);
  // A context chip carries the change request's URL alone, so the URL names its host.
  const term = changeRequestTermKind(
    (
      sourceControlClients.findByChangeRequestUrl(metadata.url) ??
      sourceControlClients.get(undefined)
    ).changeRequest,
  );
  return (
    <div className="max-w-80 space-y-1 overflow-hidden py-0.5 text-left">
      <div className="flex items-center gap-1.5 text-xs font-medium">
        <state.Icon className={cn("size-3.5 shrink-0", state.toneClassName)} />
        <span className="text-foreground">
          {gt(
            "{term, select, mr {Merge request} cr {Change request} other {Pull request}} #{number}",
            { term, number: metadata.number },
          )}
        </span>
        <span className={state.toneClassName}>{state.label}</span>
      </div>
      <div className="wrap-break-word text-foreground">{metadata.title}</div>
      <div className="flex min-w-0 items-center gap-1 text-secondary-label text-3xs">
        <code className="truncate">{metadata.headBranch}</code>
        <ArrowRightIcon className="size-3 shrink-0" aria-hidden="true" />
        <code className="truncate">{metadata.baseBranch}</code>
      </div>
    </div>
  );
}
