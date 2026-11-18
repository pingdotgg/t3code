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
import {
  emptySelection,
  isSelected,
  changeBatches,
  selectionChanges,
  toggleOnlySelection,
  toggleSelection,
} from "@t3tools/client-runtime/pull-request-selection";
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { msg, useGT, useMessages } from "gt-react";
import { useEffect, useEffectEvent, useState } from "react";

import { m, type MessageResolver } from "~/i18n/messages";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../ui/toast";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { readableFailure } from "./pullRequestDetail.logic";

const TRUNCATED_LABELS: Record<
  ReviewerTruncation,
  (error: string | null, resolve: MessageResolver) => string
> = {
  unsearchable: (_error, resolve) =>
    resolve(
      msg(
        "This repository has more people with access than are listed here. Ask for the rest on the host.",
      ),
    ),
  searchable: (_error, resolve) =>
    resolve(
      msg("This repository has more people with access than are listed here. Search to find them."),
    ),
  "search-failed": (error, resolve) =>
    resolve(
      msg("Only the people already listed are matched: the host search failed. {error}", {
        error: error ?? "",
      }),
    ),
  "search-truncated": (_error, resolve) =>
    resolve(msg("More people match than the host returned. Keep typing to narrow it down.")),
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
  const gt = useGT();
  const resolve = useMessages();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(emptySelection<PullRequestReviewerCandidate>);
  const [sending, setSending] = useState(false);

  const candidatesQuery = useEnvironmentQuery(
    open ? pullRequestEnvironment.reviewerCandidates({ environmentId, input: reference }) : null,
    resolve,
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

  const send = async (people: ReadonlyArray<PullRequestReviewerCandidate>, requested: boolean) => {
    for (const batch of changeBatches(people)) await sendBatch(batch, requested);
  };
  const sendBatch = async (
    people: ReadonlyArray<PullRequestReviewerCandidate>,
    requested: boolean,
  ) => {
    const result = await requestReviewers({
      environmentId,
      input: {
        ...reference,
        reviewers: people.map(({ id, kind }) => ({ id, kind })),
        requested,
      },
    });
    if (result._tag === "Success") return;
    const logins = people.map((person) => person.login).join(", ");
    toastManager.add({
      type: "error",
      title: requested
        ? m(msg("Could not ask {logins} for a review", { logins }))
        : m(msg("Could not take back the review request to {logins}", { logins })),
      description: readableFailure(
        squashAtomCommandFailure(result),
        m(
          msg(
            "The host refused it. Check that you have write access on this repository, and that they still have access to it.",
          ),
        ),
      ),
    });
  };

  // Loaded rows first: they carry the request state mutations update.
  const latest = [
    ...(candidatesQuery.data?.candidates ?? []),
    ...(searchResult.data?.candidates ?? []),
  ];
  const single = candidatesQuery.data?.multiple === false;

  const commit = async () => {
    const { add, remove } = selectionChanges(
      draft,
      (key, person) =>
        latest.find((entry) => `${entry.kind}:${entry.id}` === key)?.isRequested ??
        person.isRequested,
    );
    if (add.length + remove.length === 0) {
      setDraft(emptySelection());
      return;
    }
    // The draft holds until the writes settle, so reopening never shows the old reviewers.
    setSending(true);
    // Removing first lets a host that keeps one reviewer take the new one.
    await send(remove, false);
    await send(add, true);
    setDraft(emptySelection());
    setSending(false);
    // A search result is keyed by what was typed, so the writes do not reach it on their own.
    if (hostQuery !== null) searchResult.refresh();
  };
  const commitOnUnmount = useEffectEvent(() => {
    if (open && !sending) void commit();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- leaving the page with the picker open still sends the picks
  useEffect(() => () => commitOnUnmount(), []);

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (!nextOpen && !sending) void commit();
  };

  return (
    <PullRequestCandidatePicker
      icon={<UserPlusIcon className="size-3.5" />}
      label={gt("Request a review")}
      allowed={allowed}
      disabledReason={gt("Asking someone to review needs write access on this repository")}
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel={gt("Search people with access")}
      isPending={(candidatesQuery.isPending && candidatesQuery.data === null) || searchPending}
      error={
        candidatesQuery.data === null
          ? candidatesQuery.error
          : candidates.length === 0
            ? searchError
            : null
      }
      candidates={candidates}
      emptyLabel={gt("Nobody else has access to this repository.")}
      noMatchLabel={gt("Nobody with access matches that.")}
      errorLabel={gt("The people with access could not be read.")}
      truncated={truncation !== null}
      truncatedLabel={truncation === null ? "" : TRUNCATED_LABELS[truncation](searchError, resolve)}
      candidateKey={(candidate) => `${candidate.kind}:${candidate.id}`}
      onSelect={(candidate) => {
        const key = `${candidate.kind}:${candidate.id}`;
        setDraft((current) =>
          single
            ? toggleOnlySelection(
                current,
                key,
                candidate,
                candidate.isRequested,
                latest.map((entry) => ({
                  key: `${entry.kind}:${entry.id}`,
                  item: entry,
                  hostSelected: entry.isRequested,
                })),
              )
            : toggleSelection(current, key, candidate, candidate.isRequested),
        );
      }}
      disabled={sending}
    >
      {(candidate) => (
        <>
          <PullRequestActorLabel actor={candidate} className="flex-1" />
          {candidate.kind === "team" ? (
            <span className="shrink-0 text-muted-foreground">team</span>
          ) : null}
          {isSelected(draft, `${candidate.kind}:${candidate.id}`, candidate.isRequested) ? (
            <CheckIcon aria-label={gt("Already asked")} className="size-3.5 shrink-0" />
          ) : null}
        </>
      )}
    </PullRequestCandidatePicker>
  );
}
