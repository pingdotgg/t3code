import { useAtom } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { IssueCandidatesTarget } from "@t3tools/client-runtime/state/issues";
import { useGT } from "gt-react-native";
import { useState } from "react";

import { refreshIssueFilterCandidates, useIssueFilterCandidates } from "../../state/issues";
import { PullRequestLabelDot } from "../pull-requests/PullRequestLabelDot";
import { PullRequestAvatar } from "../pull-requests/PullRequestPresentation";
import { pullRequestLabelColor } from "../pull-requests/pullRequestList";
import { IssueCandidatesSheet } from "./IssueCandidatesSheet";
import { issueListFiltersAtom, unofferedIssueFilters } from "./issueListFilters";

const matches = (needle: string, ...fields: ReadonlyArray<string | null | undefined>) =>
  needle.length === 0 || fields.some((field) => field?.toLowerCase().includes(needle));

/** Searches every listed scope's labels or people for the issue list's filter. */
export function IssueFilterSearchScreen({
  route,
}: StaticScreenProps<{
  readonly kind: "labels" | "assignee";
  readonly scopes: ReadonlyArray<IssueCandidatesTarget>;
}>) {
  const gt = useGT();
  const navigation = useNavigation();
  const { kind, scopes } = route.params;
  const known = useIssueFilterCandidates(scopes);
  const [filters, setFilters] = useAtom(issueListFiltersAtom);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const labels = kind === "labels";
  const unoffered = unofferedIssueFilters(filters, known);
  const candidates = labels
    ? [
        ...unoffered.labels.map((name) => ({ name, description: null, color: null })),
        ...known.labels,
      ]
        .filter((label) => matches(needle, label.name, label.description))
        .map((label) => ({
          key: label.name,
          title: label.name,
          ...(label.description ? { subtitle: label.description } : {}),
          leading: <PullRequestLabelDot color={pullRequestLabelColor(label.color)} />,
          selected: filters.labels.includes(label.name),
        }))
    : [
        ...(unoffered.assignee ? [{ ...unoffered.assignee, avatarUrl: null }] : []),
        ...known.assignees,
      ]
        .filter((actor) => matches(needle, actor.login, actor.name))
        .map((actor) => ({
          key: actor.login,
          title: actor.login,
          ...(actor.name ? { subtitle: actor.name } : {}),
          leading: <PullRequestAvatar actor={actor} size={24} />,
          selected: filters.assignee?.login === actor.login,
        }));
  const loaded = labels ? known.labels.length > 0 : known.assignees.length > 0;
  return (
    <IssueCandidatesSheet
      title={labels ? gt("Filter by label") : gt("Filter by assignee")}
      noun={labels ? "labels" : "people"}
      query={query}
      onQueryChange={setQuery}
      candidates={candidates}
      allowed
      notice={candidates.length > 0 ? known.error : null}
      pending={known.isPending && !loaded}
      loadError={known.error}
      onRetry={() => refreshIssueFilterCandidates(scopes)}
      truncated={known.truncated}
      onToggle={(key) => {
        if (labels) {
          setFilters({
            ...filters,
            labels: filters.labels.includes(key)
              ? filters.labels.filter((name) => name !== key)
              : [...filters.labels, key].slice(0, 20),
          });
          return;
        }
        const actor = known.assignees.find((candidate) => candidate.login === key);
        setFilters({
          ...filters,
          assignee:
            filters.assignee?.login === key || !actor
              ? null
              : { login: actor.login, name: actor.name },
        });
        navigation.goBack();
      }}
    />
  );
}
