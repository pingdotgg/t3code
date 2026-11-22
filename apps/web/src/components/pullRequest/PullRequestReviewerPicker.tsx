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
  toggleSelection,
} from "@t3tools/client-runtime/pull-request-selection";
import { CheckIcon, UserPlusIcon } from "lucide-react";
import { RelativeTime } from "~/components/RelativeTime";
import { Badge } from "../ui/badge";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { useState } from "react";

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

  const onOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) return;
    // Loaded rows first: they carry the request state mutations update.
    const latest = [
      ...(candidatesQuery.data?.candidates ?? []),
      ...(searchResult.data?.candidates ?? []),
    ];
    const { add, remove } = selectionChanges(
      draft,
      (key, person) =>
        latest.find((entry) => `${entry.kind}:${entry.id}` === key)?.isRequested ??
        person.isRequested,
    );
    setDraft(emptySelection());
    // A search result is keyed by what was typed, so the writes do not reach it on their own.
    const refreshSearch =
      hostQuery !== null && add.length + remove.length > 0 ? searchResult.refresh : null;
    // Removing first lets a host that keeps one reviewer take the new one.
    void send(remove, false)
      .then(() => send(add, true))
      .then(() => refreshSearch?.());
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
      popupWidth="reviewers"
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
      onSelect={(candidate) =>
        setDraft((current) =>
          toggleSelection(
            current,
            `${candidate.kind}:${candidate.id}`,
            candidate,
            candidate.isRequested,
          ),
        )
      }
      groupLabel={
        hasGroups
          ? (candidate) =>
              candidate.isRequested
                ? gt("Already asked")
                : candidate.suggestion !== undefined
                  ? gt("Suggested", { $context: "group of suggested reviewers" })
                  : gt("Everyone with access")
          : undefined
      }
    >
      {(candidate) => {
        const selected = isSelected(
          draft,
          `${candidate.kind}:${candidate.id}`,
          candidate.isRequested,
        );
        const reason = candidate.isRequested ? (
          candidate.requestedAt ? (
            <T>
              requested{" "}
              <Var>
                <RelativeTime timestamp={candidate.requestedAt} />
              </Var>
            </T>
          ) : null
        ) : (
          (candidate.suggestion ?? null)
        );
        return (
          <>
            <PullRequestActorLabel actor={candidate} className="shrink-0" />
            <span className="min-w-0 flex-1 truncate text-muted-foreground">{reason}</span>
            {selected && candidate.isRequested ? (
              <Badge variant="warning">{gt("Pending", { $context: "review state" })}</Badge>
            ) : selected ? (
              <CheckIcon
                aria-label={gt("Asking", { $context: "reviewer is being asked" })}
                className="size-3.5 shrink-0 opacity-60"
              />
            ) : null}
          </>
        );
      }}
    </PullRequestCandidatePicker>
  );
}
