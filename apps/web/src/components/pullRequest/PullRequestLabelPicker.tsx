import { useAtomCommand } from "~/state/use-atom-command";
import type { EnvironmentId, PullRequestLabelCandidate, PullRequestRef } from "@t3tools/contracts";
import {
  hostLabelQuery,
  labelCandidateView,
  type LabelTruncation,
} from "@t3tools/client-runtime/pull-request-labels";
import { CheckIcon, TagIcon } from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
import { useState } from "react";

import { m, type MessageResolver } from "~/i18n/messages";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
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

const TRUNCATED_LABELS: Record<
  LabelTruncation,
  (error: string | null, resolve: MessageResolver) => string
> = {
  unsearchable: (_error, resolve) =>
    resolve(
      msg("This repository has more labels than are listed here. Apply the rest on the host."),
    ),
  searchable: (_error, resolve) =>
    resolve(msg("This repository has more labels than are listed here. Search to find them.")),
  "search-failed": (error, resolve) =>
    resolve(
      msg("Only the labels already listed are matched: the host search failed. {error}", {
        error: error ?? "",
      }),
    ),
  "search-truncated": (_error, resolve) =>
    resolve(msg("More labels match than the host returned. Keep typing to narrow it down.")),
};

export function PullRequestLabelPicker({
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
  const gt = useGT();
  const resolve = useMessages();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(emptySelection<PullRequestLabelCandidate>);

  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.labelCandidates({ environmentId, input: reference }) : null,
    resolve,
  );
  // Past the first page the host is asked, since what was loaded cannot answer for the rest.
  const debouncedQuery = useDebouncedValue(query.trim(), 250);
  const searchInput = { loaded: candidatesQuery.data, searchable, query, debouncedQuery };
  const hostQuery = hostLabelQuery(searchInput);
  const searchResult = useEnvironmentQuery(
    open && hostQuery !== null
      ? pullRequestEnvironment.labelSearch({
          environmentId,
          input: { ...reference, query: hostQuery },
        })
      : null,
  );
  const setLabels = useAtomCommand(pullRequestEnvironment.setLabels, {
    reportFailure: false,
  });

  const { candidates, searchPending, searchError, truncation } = labelCandidateView({
    ...searchInput,
    search: searchResult,
  });

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
    // Loaded rows first: they carry the applied state mutations update.
    const latest = [
      ...(candidatesQuery.data?.candidates ?? []),
      ...(searchResult.data?.candidates ?? []),
    ];
    const { add, remove } = selectionChanges(
      draft,
      (name, label) => latest.find((entry) => entry.name === name)?.isApplied ?? label.isApplied,
    );
    setDraft(emptySelection());
    // A search result is keyed by what was typed, so the writes do not reach it on their own.
    const refreshSearch =
      hostQuery !== null && add.length + remove.length > 0 ? searchResult.refresh : null;
    // Adding first keeps the Labels row from showing empty between the two writes.
    void send(add, true)
      .then(() => send(remove, false))
      .then(() => refreshSearch?.());
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
      isPending={(candidatesQuery.isPending && candidatesQuery.data === null) || searchPending}
      error={
        candidatesQuery.data === null
          ? candidatesQuery.error
          : candidates.length === 0
            ? searchError
            : null
      }
      candidates={candidates}
      emptyLabel={gt("This repository has no labels.")}
      noMatchLabel={gt("No label matches that.")}
      errorLabel={gt("The labels could not be read.")}
      truncated={truncation !== null}
      truncatedLabel={truncation === null ? "" : TRUNCATED_LABELS[truncation](searchError, resolve)}
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
