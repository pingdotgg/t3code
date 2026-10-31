import { useAtomCommand } from "~/state/use-atom-command";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewerCandidate,
} from "@t3tools/contracts";
import {
  hostReviewerQuery,
  reviewerCandidateView,
  type ReviewerTruncation,
} from "@t3tools/client-runtime/pull-request-reviewers";
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { RelativeTime } from "~/components/RelativeTime";
import { Badge } from "../ui/badge";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../ui/toast";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { readableFailure } from "./pullRequestDetail.logic";

const TRUNCATED_LABELS: Record<ReviewerTruncation, (error: string | null) => string> = {
  unsearchable: () =>
    "This repository has more people with access than are listed here. Ask for the rest on the host.",
  searchable: () =>
    "This repository has more people with access than are listed here. Search to find them.",
  "search-failed": (error) =>
    `Only the people already listed are matched: the host search failed. ${error ?? ""}`,
  "search-truncated": () =>
    "More people match than the host returned. Keep typing to narrow it down.",
};

export function PullRequestReviewerPicker({
  environmentId,
  reference,
  allowed,
  searchable,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  allowed: boolean;
  searchable: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.reviewerCandidates({ environmentId, input: reference }) : null,
  );
  // Past the first page the host is asked, since what was loaded cannot answer for the rest.
  const debouncedQuery = useDebouncedValue(query.trim(), 250);
  const searchInput = { loaded: candidatesQuery.data, searchable, query, debouncedQuery };
  const hostQuery = hostReviewerQuery(searchInput);
  const searchResult = useEnvironmentQuery(
    open && hostQuery !== null
      ? pullRequestEnvironment.reviewerSearch({
          environmentId,
          input: { ...reference, query: hostQuery },
        })
      : null,
  );
  const requestReviewers = useAtomCommand(pullRequestEnvironment.requestReviewers, {
    reportFailure: false,
  });

  const {
    candidates: narrowed,
    searchPending,
    searchError,
    truncation,
  } = reviewerCandidateView({
    ...searchInput,
    search: searchResult,
  });
  // Suggested people first, then who has already been asked, then everyone else with access.
  const candidates = [
    ...narrowed.filter((entry) => entry.suggestion !== undefined && !entry.isRequested),
    ...narrowed.filter((entry) => entry.isRequested),
    ...narrowed.filter((entry) => entry.suggestion === undefined && !entry.isRequested),
  ];
  const hasGroups = candidates.some((entry) => entry.isRequested || entry.suggestion !== undefined);

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
    if (hostQuery !== null) searchResult.refresh();
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
      isPending={(candidatesQuery.isPending && candidatesQuery.data === null) || searchPending}
      error={
        candidatesQuery.data === null
          ? candidatesQuery.error
          : candidates.length === 0
            ? searchError
            : null
      }
      candidates={candidates}
      emptyLabel="Nobody else has access to this repository."
      noMatchLabel="Nobody with access matches that."
      errorLabel="The people with access could not be read."
      truncated={truncation !== null}
      truncatedLabel={truncation === null ? "" : TRUNCATED_LABELS[truncation](searchError)}
      candidateKey={(candidate) => `${candidate.kind}:${candidate.id}`}
      disabled={pending !== null}
      onSelect={(candidate) => void toggle(candidate)}
      groupLabel={
        hasGroups
          ? (candidate) =>
              candidate.isRequested
                ? "Already asked"
                : candidate.suggestion !== undefined
                  ? "Suggested"
                  : "Everyone with access"
          : undefined
      }
    >
      {(candidate) => {
        const reason = candidate.isRequested ? (
          candidate.requestedAt ? (
            <>
              requested <RelativeTime timestamp={candidate.requestedAt} />
            </>
          ) : null
        ) : (
          (candidate.suggestion ?? null)
        );
        return (
          <>
            <PullRequestActorLabel actor={candidate} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{reason}</span>
            {candidate.isRequested ? (
              <Badge variant="warning">Pending</Badge>
            ) : pending === candidate.id ? (
              <CheckIcon aria-label="Asking" className="size-3.5 shrink-0 opacity-60" />
            ) : null}
          </>
        );
      }}
    </PullRequestCandidatePicker>
  );
}
