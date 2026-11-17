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
import type { TFunction } from "i18next";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { pullRequestEnvironment } from "~/state/pullRequests";
import { useEnvironmentQuery } from "~/state/query";
import { useDebouncedValue } from "~/state/queries";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";

import { toastManager } from "../ui/toast";
import { PullRequestCandidatePicker } from "./PullRequestCandidatePicker";
import { PullRequestActorLabel } from "./pullRequestPresentation";
import { readableFailure } from "./pullRequestDetail.logic";

const TRUNCATED_LABELS: Record<ReviewerTruncation, (t: Translate, error: string | null) => string> =
  {
    unsearchable: (t) => t("pullRequest:picker.overflowAsk"),
    searchable: (t) => t("pullRequest:picker.overflowHint"),
    "search-failed": (t, error) => t("pullRequest:picker.searchFailed", { error: error ?? "" }),
    "search-truncated": (t) => t("pullRequest:picker.tooManyMatches"),
  };

type Translate = TFunction<["pullRequest", "pullRequest"]>;

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
  const [draft, setDraft] = useState(emptySelection<PullRequestReviewerCandidate>);
  const { t } = useTranslation("pullRequest");

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
        ? `Could not ask ${logins} for a review`
        : `Could not take back the review request to ${logins}`,
      description: readableFailure(
        squashAtomCommandFailure(result),
        "The host refused it. Check that you have write access on this repository, and that they still have access to it.",
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
      label={t("picker.requestReview")}
      allowed={allowed}
      disabledReason={t("picker.needsWriteAccess")}
      open={open}
      onOpenChange={onOpenChange}
      query={query}
      onQueryChange={setQuery}
      searchLabel={t("picker.searchPeople")}
      isPending={(candidatesQuery.isPending && candidatesQuery.data === null) || searchPending}
      error={
        candidatesQuery.data === null
          ? candidatesQuery.error
          : candidates.length === 0
            ? searchError
            : null
      }
      candidates={candidates}
      emptyLabel={t("picker.nobodyElse")}
      noMatchLabel={t("picker.noMatch")}
      errorLabel={t("picker.readFailed")}
      truncated={truncation !== null}
      truncatedLabel={truncation === null ? "" : TRUNCATED_LABELS[truncation](t, searchError)}
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
    >
      {(candidate) => (
        <>
          <PullRequestActorLabel actor={candidate} className="flex-1" />
          {candidate.kind === "team" ? (
            <span className="shrink-0 text-muted-foreground">{t("picker.team")}</span>
          ) : null}
          {isSelected(draft, `${candidate.kind}:${candidate.id}`, candidate.isRequested) ? (
            <CheckIcon aria-label={t("picker.alreadyAsked")} className="size-3.5 shrink-0" />
          ) : null}
        </>
      )}
    </PullRequestCandidatePicker>
  );
}
