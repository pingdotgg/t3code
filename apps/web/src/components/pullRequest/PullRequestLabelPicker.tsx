import { useAtomCommand } from "~/state/use-atom-command";
import type { EnvironmentId, PullRequestLabelCandidate, PullRequestRef } from "@t3tools/contracts";
import { CheckIcon, TagIcon } from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
import { useState } from "react";
import { searchItems, SEARCH_SECONDARY_FIELD_WEIGHT } from "@t3tools/shared/searchRanking";

import { m } from "~/i18n/messages";

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

export function PullRequestLabelPicker({
  environmentId,
  reference,
  allowed,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  allowed: boolean;
}) {
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(emptySelection<PullRequestLabelCandidate>);

  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.labelCandidates({ environmentId, input: reference }) : null,
    useMessages(),
  );
  const setLabels = useAtomCommand(pullRequestEnvironment.setLabels, {
    reportFailure: false,
  });

  const candidates = searchItems(candidatesQuery.data?.candidates ?? [], query, (entry) => [
    entry.name,
    { value: entry.description ?? "", weight: SEARCH_SECONDARY_FIELD_WEIGHT, fuzzy: false },
  ]);

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
        ? m(msg("Could not put {names} on", { names: names.join(", ") }))
        : m(msg("Could not take {names} off", { names: names.join(", ") })),
      description: readableFailure(
        squashAtomCommandFailure(result),
        m(msg("The host refused it. Check that you have triage access on this repository.")),
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
      label={gt("Change labels")}
      allowed={allowed}
      disabledReason={gt("Changing labels needs triage access on this repository")}
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel={gt("Search labels")}
      isPending={candidatesQuery.isPending && candidatesQuery.data === null}
      error={candidatesQuery.data === null ? candidatesQuery.error : null}
      candidates={candidates}
      emptyLabel={gt("This repository has no labels.")}
      noMatchLabel={gt("No label matches that.")}
      errorLabel={gt("The labels could not be read.")}
      truncated={candidatesQuery.data?.truncated === true}
      truncatedLabel={gt(
        "This repository has more labels than are listed here. Apply the rest on the host.",
      )}
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
              <CheckIcon
                aria-label={gt("Applied", { $context: "label is applied" })}
                className="size-3.5 shrink-0"
              />
            ) : null}
          </>
        );
      }}
    </PullRequestCandidatePicker>
  );
}
