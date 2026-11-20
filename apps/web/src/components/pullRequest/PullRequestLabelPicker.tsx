import { useAtomCommand } from "~/state/use-atom-command";
/**
 * Putting labels on, and taking them off, from the row that says which it already wears. Presses
 * only tick the boxes; the changes are sent together when the menu closes.
 */
import type { EnvironmentId, PullRequestLabelCandidate, PullRequestRef } from "@t3tools/contracts";
import { TagIcon } from "lucide-react";
import { msg, T, useGT, useMessages } from "gt-react";
import { useState } from "react";

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

import { Checkbox } from "../ui/checkbox";
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
  text,
}: {
  environmentId: EnvironmentId;
  reference: PullRequestRef;
  allowed: boolean;
  text?: string | undefined;
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

  const all = candidatesQuery.data?.candidates ?? [];
  const candidates = all.filter((entry) => matches(entry, query));
  const isChecked = (candidate: PullRequestLabelCandidate) =>
    isSelected(draft, candidate.name, candidate.isApplied);
  const appliedCount = all.filter(isChecked).length;

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
    setQuery("");
    // Adding first keeps the Labels row from showing empty between the two writes.
    void send(add, true).then(() => send(remove, false));
  };

  return (
    <PullRequestCandidatePicker
      icon={<TagIcon className="size-3.5" />}
      label={gt("Change labels")}
      text={text}
      allowed={allowed}
      disabledReason={gt("Changing labels needs triage access on this repository")}
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel={gt("Search labels")}
      popupWidth="labels"
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
      footer={
        candidatesQuery.data ? (
          <span className="flex flex-col gap-0.5">
            <span>
              {gt("{count, plural, other {{formatted} applied}}", {
                count: appliedCount,
                formatted: appliedCount.toLocaleString(),
              })}
            </span>
            <span>
              <T>Changes save when you close</T>
            </span>
          </span>
        ) : null
      }
    >
      {(candidate) => {
        const dot = pullRequestLabelColor(candidate.color);
        return (
          <>
            {/* The row is the control; the box only shows its state. */}
            <span aria-hidden className="pointer-events-none flex shrink-0">
              <Checkbox checked={isChecked(candidate)} tabIndex={-1} />
            </span>
            <span
              aria-hidden
              className="size-2 shrink-0 rounded-full bg-muted-foreground"
              {...(dot ? { style: { backgroundColor: dot } } : {})}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate">{candidate.name}</span>
              {candidate.description ? (
                <span className="block truncate text-muted-foreground">
                  {candidate.description}
                </span>
              ) : null}
            </span>
            <span className="sr-only">
              {isChecked(candidate)
                ? gt("Applied", { $context: "label is applied" })
                : gt("Not applied", { $context: "label is applied" })}
            </span>
          </>
        );
      }}
    </PullRequestCandidatePicker>
  );
}
