import { useAtomCommand } from "~/state/use-atom-command";
import {
  PULL_REQUEST_REVIEWER_CHANGE_LIMIT,
  type EnvironmentId,
  type PullRequestRef,
  type PullRequestReviewerCandidate,
} from "@t3tools/contracts";
import {
  hostReviewerQuery,
  reviewerCandidateView,
  type ReviewerTruncation,
} from "@t3tools/client-runtime/pull-request-reviewers";
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

const candidateKey = (candidate: PullRequestReviewerCandidate) =>
  `${candidate.kind}:${candidate.id}`;

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

  const { candidates, searchPending, searchError, truncation } = reviewerCandidateView({
    ...searchInput,
    search: searchResult,
  });
  const shownKeys = new Set(candidates.map(candidateKey));
  // The draft spans every loaded row, so a single-reviewer swap clears one the query hides.
  const pool = [
    ...candidates,
    ...(candidatesQuery.data?.candidates ?? []).filter(
      (candidate) => !shownKeys.has(candidateKey(candidate)),
    ),
  ];

  const send = async (
    reviewers: ReadonlyArray<PullRequestReviewerCandidate>,
    requested: boolean,
  ): Promise<boolean> => {
    if (reviewers.length === 0) return true;
    for (let start = 0; start < reviewers.length; start += PULL_REQUEST_REVIEWER_CHANGE_LIMIT) {
      const result = await requestReviewers({
        environmentId,
        input: {
          ...reference,
          reviewers: reviewers
            .slice(start, start + PULL_REQUEST_REVIEWER_CHANGE_LIMIT)
            .map((reviewer) => ({ id: reviewer.id, kind: reviewer.kind })),
          requested,
        },
      });
      if (result._tag !== "Failure") continue;
      const logins = reviewers
        .slice(start)
        .map((reviewer) => reviewer.login)
        .join(", ");
      toastManager.add({
        type: "error",
        title: requested
          ? `Could not ask ${logins} for a review`
          : `Could not take back the review request to ${logins}`,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have write access on this repository, and that they still have access to it.",
        ),
      });
      return false;
    }
    // The command reads the loaded list again only for somebody it lacked, and a search result
    // is keyed by what was typed, so the one on screen is read here or it keeps the old request.
    if (hostQuery !== null) searchResult.refresh();
    return true;
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
      candidates={pool}
      matches={(candidate) => shownKeys.has(candidateKey(candidate))}
      isSelected={(candidate) => candidate.isRequested}
      single={candidatesQuery.data?.multiple === false}
      emptyLabel="Nobody else has access to this repository."
      noMatchLabel="Nobody with access matches that."
      errorLabel="The people with access could not be read."
      truncated={truncation !== null}
      truncatedLabel={truncation === null ? "" : TRUNCATED_LABELS[truncation](searchError)}
      candidateKey={candidateKey}
      onCommit={async ({ add, remove }) => {
        // Removals go first: a host that keeps one reviewer ignores an add while one is set.
        if (await send(remove, false)) await send(add, true);
      }}
    >
      {(candidate, selected) => (
        <>
          <PullRequestActorLabel actor={candidate} className="flex-1" />
          {candidate.kind === "team" ? (
            <span className="shrink-0 text-muted-foreground">team</span>
          ) : null}
          {selected ? <CheckIcon aria-label="Asked" className="size-3.5 shrink-0" /> : null}
        </>
      )}
    </PullRequestCandidatePicker>
  );
}
