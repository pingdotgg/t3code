import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  issueAssigneeHeld,
  issueAssigneesAfterPicks,
} from "@t3tools/client-runtime/issue-selection";
import {
  emptySelection,
  isSelected,
  toggleSelection,
} from "@t3tools/client-runtime/pull-request-selection";
import type { IssueAssigneeCandidate } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import * as Dialog from "../../components/ui/Dialog";
import { issueEnvironment } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestAvatar } from "../pull-requests/PullRequestPresentation";
import { IssueCandidatesSheet } from "./IssueCandidatesSheet";
import { issueTarget, type IssueParams } from "./issueParams";
import { issueCommandError, useIssueAccess } from "./issuePresentation";

export function IssueAssigneesScreen({ route }: StaticScreenProps<IssueParams>) {
  const navigation = useNavigation();
  const target = issueTarget(route.params);
  const detail = useEnvironmentQuery(issueEnvironment.detail(target)).data;
  const access = useIssueAccess(route.params, detail);
  const result = useEnvironmentQuery(issueEnvironment.candidates(target));
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(emptySelection<IssueAssigneeCandidate>);
  const allowed = access?.assignees === true;
  const held = (candidate: IssueAssigneeCandidate) =>
    detail ? issueAssigneeHeld(detail, candidate) : false;
  const needle = query.trim().toLowerCase();
  const candidates = (result.data?.assignees ?? []).filter((candidate) =>
    `${candidate.login} ${candidate.name ?? ""}`.toLowerCase().includes(needle),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- picks are sent when the sheet leaves the navigation stack, however it is dismissed
  useEffect(
    () =>
      navigation.addListener("beforeRemove", () => {
        const assignees = detail ? issueAssigneesAfterPicks(detail, draft) : null;
        if (assignees === null) return;
        void update({ ...target, input: { ...target.input, assignees } }).then((response) => {
          const failure = issueCommandError(response);
          if (failure !== null) Dialog.alert("Couldn't change assignees", failure);
        });
      }),
    [navigation, detail, draft, update, target],
  );
  return (
    <IssueCandidatesSheet
      title="Assignees"
      noun="people"
      query={query}
      onQueryChange={setQuery}
      candidates={candidates.map((candidate) => ({
        key: candidate.id,
        title: candidate.login,
        ...(candidate.name ? { subtitle: candidate.name } : {}),
        leading: <PullRequestAvatar actor={candidate} size={24} />,
        // Sent when the sheet closes; a failure puts the tracker's answer back.
        selected: isSelected(draft, candidate.id, held(candidate)),
      }))}
      allowed={allowed}
      notice={
        detail && !allowed
          ? (access?.blocked ?? "Changing assignees needs triage access on this tracker.")
          : null
      }
      pending={result.isPending && !result.data}
      loadError={result.data ? null : result.error}
      onRetry={result.refresh}
      truncated={result.data?.truncated === true}
      onToggle={(id) => {
        const candidate = candidates.find((entry) => entry.id === id);
        if (candidate)
          setDraft((current) => toggleSelection(current, id, candidate, held(candidate)));
      }}
    />
  );
}
