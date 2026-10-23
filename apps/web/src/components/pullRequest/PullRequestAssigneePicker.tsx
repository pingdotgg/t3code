import { useAtomCommand } from "~/state/use-atom-command";
/**
 * Assigning someone, from the row that says who is already assigned. The people who may be
 * assigned are read only once this menu opens, for the same reason as the reviewer picker.
 */
import type {
  EnvironmentId,
  PullRequestAssigneeCandidate,
  PullRequestRef,
} from "@t3tools/contracts";
import { mergeAssigneeCandidates } from "@t3tools/client-runtime/pull-request-assignees";
import { CheckIcon, UserRoundPlusIcon } from "lucide-react";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../ui/toast";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { readableFailure } from "./pullRequestDetail.logic";

export function PullRequestAssigneePicker({
  environmentId,
  reference,
  allowed,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  /** False where the host would refuse this account, shown disabled with the reason. */
  allowed: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.assigneeCandidates({ environmentId, input: reference }) : null,
  );
  // Past the first page the host is asked, since what was loaded cannot answer for the rest.
  const searchQuery = useDebouncedValue(query.trim(), 250);
  const searchesHost = candidatesQuery.data?.truncated === true && searchQuery.length > 0;
  // Only once the debounce has caught up, or rows matching the previous text would linger.
  const searched = searchesHost && searchQuery === query.trim();
  const searchResult = useEnvironmentQuery(
    open && searchesHost
      ? pullRequestEnvironment.assigneeSearch({
          environmentId,
          input: { ...reference, query: searchQuery },
        })
      : null,
  );
  const setAssignees = useAtomCommand(pullRequestEnvironment.setAssignees, {
    reportFailure: false,
  });

  const candidates = mergeAssigneeCandidates(
    candidatesQuery.data?.candidates ?? [],
    searched ? (searchResult.data?.candidates ?? []) : [],
    query,
  );

  const toggle = async (candidate: PullRequestAssigneeCandidate) => {
    if (pending !== null) return;
    setPending(candidate.id);
    const result = await setAssignees({
      environmentId,
      input: { ...reference, assignees: [candidate.id], assigned: !candidate.isAssigned },
    });
    setPending(null);
    if (result._tag === "Failure") {
      toastManager.add({
        type: "error",
        title: candidate.isAssigned
          ? `Could not unassign ${candidate.login}`
          : `Could not assign ${candidate.login}`,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have triage access on this repository, and that they still have access to it.",
        ),
      });
      return;
    }
    // The command reads the loaded list again, but a search result is keyed by what was typed, so
    // the one on screen is read here or it keeps showing the old assignment.
    if (searchesHost) searchResult.refresh();
    toastManager.add({
      type: "success",
      title: candidate.isAssigned ? `Unassigned ${candidate.login}` : `Assigned ${candidate.login}`,
    });
  };

  return (
    <PullRequestCandidatePicker
      icon={<UserRoundPlusIcon className="size-3.5" />}
      label="Assign someone"
      allowed={allowed}
      disabledReason="Assigning someone needs triage access on this repository"
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      searchLabel="Search people who can be assigned"
      isPending={
        (candidatesQuery.isPending && candidatesQuery.data === null) ||
        // Nothing loaded matches yet, and the host has not answered: not a "nobody matches".
        (candidates.length === 0 &&
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
      emptyLabel="Nobody can be assigned on this repository."
      noMatchLabel="Nobody who can be assigned matches that."
      errorLabel="The people who can be assigned could not be read."
      truncated={
        candidatesQuery.data?.truncated === true &&
        (query.trim().length === 0 ||
          (searched && (searchResult.error !== null || searchResult.data?.truncated === true)))
      }
      truncatedLabel={
        searched && searchResult.error !== null
          ? `Only the people already listed are matched: the host search failed. ${searchResult.error}`
          : searched
            ? "More people match than the host returned. Keep typing to narrow it down."
            : "This repository has more people who can be assigned than are listed here. Search to find them."
      }
      candidateKey={(candidate) => candidate.id}
      disabled={pending !== null}
      onSelect={(candidate) => void toggle(candidate)}
    >
      {(candidate) => (
        <>
          <PullRequestActorLabel actor={candidate} className="flex-1" />
          {candidate.isAssigned ? (
            <CheckIcon aria-label="Assigned" className="size-3.5 shrink-0" />
          ) : null}
        </>
      )}
    </PullRequestCandidatePicker>
  );
}
