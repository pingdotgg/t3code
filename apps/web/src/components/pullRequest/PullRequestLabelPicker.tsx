import { useAtomCommand } from "~/state/use-atom-command";
import {
  PULL_REQUEST_LABEL_CHANGE_LIMIT,
  type EnvironmentId,
  type PullRequestLabelCandidate,
  type PullRequestRef,
} from "@t3tools/contracts";
import { CheckIcon, TagIcon } from "lucide-react";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../ui/toast";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { readableFailure } from "./pullRequestDetail.logic";
import { pullRequestLabelColor } from "./pullRequestList.logic";

function matches(candidate: PullRequestLabelCandidate, query: string): boolean {
  if (query.length === 0) return true;
  const needle = query.toLowerCase();
  return (
    candidate.name.toLowerCase().includes(needle) ||
    (candidate.description ?? "").toLowerCase().includes(needle)
  );
}

export function PullRequestLabelPicker({
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
    open ? pullRequestEnvironment.labelCandidates({ environmentId, input: reference }) : null,
  );
  const setLabels = useAtomCommand(pullRequestEnvironment.setLabels, {
    reportFailure: false,
  });

  const send = async (
    labels: ReadonlyArray<PullRequestLabelCandidate>,
    applied: boolean,
    // Removals that wait on this add and are dropped when it fails.
    skipped: ReadonlyArray<PullRequestLabelCandidate> = [],
  ) => {
    if (labels.length === 0) return true;
    const names = labels.map((label) => label.name);
    for (let start = 0; start < names.length; start += PULL_REQUEST_LABEL_CHANGE_LIMIT) {
      const result = await setLabels({
        environmentId,
        input: {
          ...reference,
          labels: names.slice(start, start + PULL_REQUEST_LABEL_CHANGE_LIMIT),
          applied,
        },
      });
      if (result._tag !== "Failure") continue;
      toastManager.add({
        type: "error",
        title: `Could not ${applied ? "add" : "remove"} ${names.slice(start).join(", ")}${skipped.length > 0 ? ` or remove ${skipped.map((label) => label.name).join(", ")}` : ""}`,
        description: readableFailure(
          squashAtomCommandFailure(result),
          "The host refused it. Check that you have triage access on this repository.",
        ),
      });
      return false;
    }
    return true;
  };

  return (
    <PullRequestCandidatePicker
      icon={<TagIcon className="size-3.5" />}
      label="Change labels"
      allowed={allowed}
      disabledReason="Changing labels needs triage access on this repository"
      open={open}
      onOpenChange={setOpen}
      query={query}
      onQueryChange={setQuery}
      searchLabel="Search labels"
      isPending={candidatesQuery.isPending && candidatesQuery.data === null}
      error={candidatesQuery.data === null ? candidatesQuery.error : null}
      candidates={candidatesQuery.data?.candidates ?? []}
      matches={matches}
      isSelected={(candidate) => candidate.isApplied}
      single={false}
      emptyLabel="This repository has no labels."
      noMatchLabel="No label matches that."
      errorLabel="The labels could not be read."
      truncated={candidatesQuery.data?.truncated === true}
      truncatedLabel="This repository has more labels than are listed here. Apply the rest on the host."
      candidateKey={(candidate) => candidate.name}
      onCommit={async ({ add, remove }) => {
        // Adds first, so the row never shows empty between the two writes, or after a failed add.
        if (await send(add, true, remove)) await send(remove, false);
      }}
    >
      {(candidate, selected) => {
        const dot = pullRequestLabelColor(candidate.color);
        return (
          <>
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-muted-foreground"
              {...(dot ? { style: { backgroundColor: dot } } : {})}
            />
            <span className="min-w-0 flex-1 truncate">
              {candidate.name}
              {candidate.description ? (
                <span className="text-muted-foreground"> · {candidate.description}</span>
              ) : null}
            </span>
            {selected ? <CheckIcon aria-label="Applied" className="size-3.5 shrink-0" /> : null}
          </>
        );
      }}
    </PullRequestCandidatePicker>
  );
}
