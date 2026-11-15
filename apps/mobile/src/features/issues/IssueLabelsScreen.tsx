import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { issueLabelsAfterPicks } from "@t3tools/client-runtime/issue-selection";
import {
  emptySelection,
  isSelected,
  toggleSelection,
} from "@t3tools/client-runtime/pull-request-selection";
import type { IssueLabelCandidate } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { issueEnvironment } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestLabelDot } from "../pull-requests/PullRequestLabelDot";
import { pullRequestLabelColor } from "../pull-requests/pullRequestList";
import { IssueCandidatesSheet } from "./IssueCandidatesSheet";
import { issueTarget, type IssueParams } from "./issueParams";
import { issueCommandError, useIssueAccess } from "./issuePresentation";

export function IssueLabelsScreen({ route }: StaticScreenProps<IssueParams>) {
  const navigation = useNavigation();
  const target = issueTarget(route.params);
  const detail = useEnvironmentQuery(issueEnvironment.detail(target)).data;
  const access = useIssueAccess(route.params, detail);
  const result = useEnvironmentQuery(issueEnvironment.candidates(target));
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(emptySelection<IssueLabelCandidate>);
  const allowed = access?.labels === true;
  const applied = new Set(detail?.labels.map((label) => label.name));
  const needle = query.trim().toLowerCase();
  // Host order, not applied-first: re-sorting on toggle would move the row out from under a tap.
  const candidates = (result.data?.labels ?? []).filter((label) =>
    `${label.name} ${label.description ?? ""}`.toLowerCase().includes(needle),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- picks are sent when the sheet leaves the navigation stack, however it is dismissed
  useEffect(
    () =>
      navigation.addListener("beforeRemove", () => {
        const labels = detail ? issueLabelsAfterPicks(detail, draft) : null;
        if (labels === null) return;
        void update({ ...target, input: { ...target.input, labels } }).then((response) => {
          const failure = issueCommandError(response);
          if (failure !== null) Dialog.alert("Couldn't change labels", failure);
        });
      }),
    [navigation, detail, draft, update, target],
  );
  return (
    <IssueCandidatesSheet
      title="Labels"
      noun="labels"
      query={query}
      onQueryChange={setQuery}
      candidates={candidates.map((label) => ({
        key: label.name,
        title: label.name,
        ...(label.description ? { subtitle: label.description } : {}),
        leading: <PullRequestLabelDot color={pullRequestLabelColor(label.color)} />,
        // Sent when the sheet closes; a failure puts the tracker's answer back.
        selected: isSelected(draft, label.name, applied.has(label.name)),
      }))}
      allowed={allowed}
      notice={
        detail && !allowed
          ? (access?.blocked ?? "Changing labels needs triage access on this tracker.")
          : null
      }
      pending={result.isPending && !result.data}
      loadError={result.data ? null : result.error}
      onRetry={result.refresh}
      truncated={result.data?.truncated === true}
      onToggle={(name) => {
        const label = candidates.find((entry) => entry.name === name);
        if (label) setDraft((current) => toggleSelection(current, name, label, applied.has(name)));
      }}
    />
  );
}
