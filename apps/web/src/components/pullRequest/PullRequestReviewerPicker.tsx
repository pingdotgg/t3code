import { useAtomCommand } from "~/state/use-atom-command";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewerCandidate,
  SourceControlProviderKind,
} from "@t3tools/contracts";
import { mergeReviewerCandidates } from "@t3tools/client-runtime/pull-request-reviewers";
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../ui/toast";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { readableFailure } from "./pullRequestDetail.logic";

export function PullRequestReviewerPicker({
  environmentId,
  reference,
  allowed,
  provider,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  allowed: boolean;
  provider: SourceControlProviderKind;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.reviewerCandidates({ environmentId, input: reference }) : null,
  );
  // Past the first page the host is asked, since what was loaded cannot answer for the rest.
  const searchQuery = useDebouncedValue(query.trim(), 250);
  const supportsSearch = provider === "github" || provider === "gitlab";
  const searchesHost =
    supportsSearch && candidatesQuery.data?.truncated === true && searchQuery.length > 0;
  // Only once the debounce has caught up, or rows matching the previous text would linger.
  const searched = searchesHost && searchQuery === query.trim();
  const searchResult = useEnvironmentQuery(
    open && searchesHost
      ? pullRequestEnvironment.reviewerSearch({
          environmentId,
          input: { ...reference, query: searchQuery },
        })
      : null,
  );
  const requestReviewers = useAtomCommand(pullRequestEnvironment.requestReviewers, {
    reportFailure: false,
  });

  const candidates = mergeReviewerCandidates(
    candidatesQuery.data?.candidates ?? [],
    searched ? (searchResult.data?.candidates ?? []) : [],
    query,
  );

  const toggle = async (candidate: PullRequestReviewerCandidate) => {
    if (pending !== null) return;
    setPending(candidate.id);
    const result = await requestReviewers({
      environmentId,
      input: {
        ...reference,
        reviewers: [{ id: candidate.id, kind: candidate.kind }],
        requested: !candidate.isRequested,
      },
    });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: candidate.isRequested
          ? `Could not take back the review request to ${candidate.login}`
          : `Could not ask ${candidate.login} for a review`,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have write access on this repository, and that they still have access to it.",
        ),
      });
      return;
    }
    // The command reads the loaded list again only for somebody it lacked, and a search result
    // is keyed by what was typed, so the one on screen is read here or it keeps the old request.
    if (searchesHost) searchResult.refresh();
    toastManager.add({
      type: "success",
      title: candidate.isRequested
        ? `Review request to ${candidate.login} taken back`
        : `Review requested from ${candidate.login}`,
    });
  };

  return (
    <PullRequestCandidatePicker
      icon={<UserPlusIcon className="size-3.5" />}
      label="Request a review"
      allowed={allowed}
      disabledReason="Asking someone to review needs write access on this repository"
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      searchLabel="Search people with access"
      isPending={
        (candidatesQuery.isPending && candidatesQuery.data === null) ||
        // Nothing loaded matches yet, and the host has not answered: not a "nobody matches".
        (candidates.length === 0 &&
          supportsSearch &&
          candidatesQuery.data?.truncated === true &&
          query.trim().length > 0 &&
          (searchQuery !== query.trim() || searchResult.isPending))
      }
      error={
        candidatesQuery.data === null
          ? candidatesQuery.error
          : searched && candidates.length === 0
            ? searchResult.error
            : null
      }
      candidates={candidates}
      emptyLabel="Nobody else has access to this repository."
      noMatchLabel="Nobody with access matches that."
      errorLabel="The people with access could not be read."
      truncated={
        candidatesQuery.data?.truncated === true &&
        (!supportsSearch ||
          query.trim().length === 0 ||
          (searched && (searchResult.error !== null || searchResult.data?.truncated === true)))
      }
      truncatedLabel={
        !supportsSearch
          ? "The provider has more reviewers than are listed here. Find additional reviewers on the provider."
          : searched && searchResult.error !== null
            ? `Only the people already listed are matched: the host search failed. ${searchResult.error}`
            : searched
              ? "More people match than the host returned. Keep typing to narrow it down."
              : "This repository has more people with access than are listed here. Search to find them."
      }
      candidateKey={(candidate) => `${candidate.kind}:${candidate.id}`}
      disabled={pending !== null}
      onSelect={(candidate) => void toggle(candidate)}
    >
      {(candidate) => (
        <>
          <PullRequestActorLabel actor={candidate} className="flex-1" />
          {candidate.kind === "team" ? (
            <span className="shrink-0 text-muted-foreground">team</span>
          ) : null}
          {candidate.isRequested ? (
            <CheckIcon aria-label="Already asked" className="size-3.5 shrink-0" />
          ) : null}
        </>
      )}
    </PullRequestCandidatePicker>
  );
}
