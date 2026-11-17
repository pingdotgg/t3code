import { useAtomCommand } from "~/state/use-atom-command";
import type { EnvironmentId, PullRequestLabelCandidate, PullRequestRef } from "@t3tools/contracts";
import { CheckIcon, TagIcon } from "lucide-react";
import { useState } from "react";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  emptySelection,
  isSelected,
  changeBatches,
  selectionChanges,
  toggleSelection,
} from "@t3tools/client-runtime/pull-request-selection";

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
  const [draft, setDraft] = useState(emptySelection<PullRequestLabelCandidate>);

  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.labelCandidates({ environmentId, input: reference }) : null,
  );
  const setLabels = useAtomCommand(pullRequestEnvironment.setLabels, {
    reportFailure: false,
  });

  const candidates = (candidatesQuery.data?.candidates ?? []).filter((entry) =>
    matches(entry, query),
  );

  const send = async (labels: ReadonlyArray<PullRequestLabelCandidate>, applied: boolean) => {
    for (const batch of changeBatches(labels)) await sendBatch(batch, applied);
  };
  const sendBatch = async (labels: ReadonlyArray<PullRequestLabelCandidate>, applied: boolean) => {
    const names = labels.map((label) => label.name);
    const result = await setLabels({
      environmentId,
      input: { ...reference, labels: names, applied },
    });
    if (result._tag === "Success") return;
    toastManager.add({
      type: "error",
      title: applied
        ? `Could not put ${names.join(", ")} on`
        : `Could not take ${names.join(", ")} off`,
      description: readableFailure(
        squashAtomCommandFailure(result),
        "The host refused it. Check that you have triage access on this repository.",
      ),
    });
  };

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) return;
    const latest = candidatesQuery.data?.candidates ?? [];
    const { add, remove } = selectionChanges(
      draft,
      (name, label) => latest.find((entry) => entry.name === name)?.isApplied ?? label.isApplied,
    );
    setDraft(emptySelection());
    // Adding first keeps the Labels row from showing empty between the two writes.
    void send(add, true).then(() => send(remove, false));
  };

  return (
    <PullRequestCandidatePicker
      icon={<TagIcon className="size-3.5" />}
      label="Change labels"
      allowed={allowed}
      disabledReason="Changing labels needs triage access on this repository"
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel="Search labels"
      isPending={candidatesQuery.isPending && candidatesQuery.data === null}
      error={candidatesQuery.data === null ? candidatesQuery.error : null}
      candidates={candidates}
      emptyLabel="This repository has no labels."
      noMatchLabel="No label matches that."
      errorLabel="The labels could not be read."
      truncated={candidatesQuery.data?.truncated === true}
      truncatedLabel="This repository has more labels than are listed here. Apply the rest on the host."
      candidateKey={(candidate) => candidate.name}
      onSelect={(candidate) =>
        setDraft((current) =>
          toggleSelection(current, candidate.name, candidate, candidate.isApplied),
        )
      }
    >
      {(candidate) => {
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
            {isSelected(draft, candidate.name, candidate.isApplied) ? (
              <CheckIcon aria-label="Applied" className="size-3.5 shrink-0" />
            ) : null}
          </>
        );
      }}
    </PullRequestCandidatePicker>
  );
}
