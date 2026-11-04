import { useAtomCommand } from "~/state/use-atom-command";
import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestReviewerCandidate,
} from "@t3tools/contracts";
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../ui/toast";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { readableFailure } from "./pullRequestDetail.logic";

function matches(candidate: PullRequestReviewerCandidate, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    candidate.login.toLowerCase().includes(needle) ||
    (candidate.name ?? "").toLowerCase().includes(needle)
  );
}

export function PullRequestReviewerPicker({
  environmentId,
  reference,
  allowed,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  allowed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.reviewerCandidates({ environmentId, input: reference }) : null,
  );
  const requestReviewers = useAtomCommand(pullRequestEnvironment.requestReviewers, {
    reportFailure: false,
  });

  const send = async (
    reviewers: ReadonlyArray<PullRequestReviewerCandidate>,
    requested: boolean,
  ): Promise<boolean> => {
    if (reviewers.length === 0) return true;
    const logins = reviewers.map((reviewer) => reviewer.login).join(", ");
    const result = await requestReviewers({
      environmentId,
      input: {
        ...reference,
        reviewers: reviewers.map((reviewer) => ({ id: reviewer.id, kind: reviewer.kind })),
        requested,
      },
    });
    if (result._tag === "Failure") {
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
      isPending={candidatesQuery.isPending && candidatesQuery.data === null}
      error={candidatesQuery.data === null ? candidatesQuery.error : null}
      candidates={candidatesQuery.data?.candidates ?? []}
      matches={matches}
      isSelected={(candidate) => candidate.isRequested}
      single={candidatesQuery.data?.multiple === false}
      emptyLabel="Nobody else has access to this repository."
      noMatchLabel="Nobody with access matches that."
      errorLabel="The people with access could not be read."
      truncated={candidatesQuery.data?.truncated === true}
      truncatedLabel="This repository has more people with access than are listed here. Ask for the rest on the host."
      candidateKey={(candidate) => `${candidate.kind}:${candidate.id}`}
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
