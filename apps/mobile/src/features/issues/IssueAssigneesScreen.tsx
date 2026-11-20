import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useAtom } from "@effect/atom-react";
import {
  issueAssigneeHeld,
  issueAssigneesAfterPicks,
  issuePicksAfterFailedWrite,
  issuePicksFor,
  issueWriteAfterPicks,
  noIssuePicks,
} from "@t3tools/client-runtime/issue-selection";
import { isSelected, toggleSelection } from "@t3tools/client-runtime/pull-request-selection";
import type { IssueAssigneeCandidate } from "@t3tools/contracts";
import { msg, useGT } from "gt-react-native";
import { useEffect, useState } from "react";

import { m } from "../../i18n/messages";
import * as Dialog from "../../components/ui/Dialog";
import { issueEnvironment, refreshIssueLists } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestAvatar } from "../pull-requests/PullRequestPresentation";
import { IssueCandidatesSheet } from "./IssueCandidatesSheet";
import { issueParamsKey, issueTarget, type IssueParams } from "./issueParams";
import { issueAssigneePicksFamily } from "./issuePicks";
import { issueCommandError, useIssueAccess } from "./issuePresentation";

export function IssueAssigneesScreen({ route }: StaticScreenProps<IssueParams>) {
  const gt = useGT();
  const navigation = useNavigation();
  const target = issueTarget(route.params);
  const detail = useEnvironmentQuery(issueEnvironment.detail(target)).data;
  const access = useIssueAccess(route.params, detail);
  const result = useEnvironmentQuery(issueEnvironment.candidates(target));
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const [query, setQuery] = useState("");
  // The atom carries a closed sheet's picks to the next one; this sheet's own live here.
  const [stored, setStored] = useAtom(issueAssigneePicksFamily(issueParamsKey(route.params)));
  // Picks against an older read are dropped once, when the sheet opens.
  const [picks, setPicks] = useState(() =>
    detail ? issuePicksFor(stored, detail, false) : noIssuePicks<IssueAssigneeCandidate>(),
  );
  const own = detail ? issuePicksFor(picks, detail, true) : noIssuePicks<IssueAssigneeCandidate>();
  // What was last sent is read from the atom, so a write that fails while this sheet is open is
  // sent again when it closes.
  const current = { ...own, written: stored.basis === detail ? stored.written : null };
  const draft = current.draft;
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
        if (!detail) return;
        const assignees = issueWriteAfterPicks(
          issueAssigneesAfterPicks(detail, draft),
          detail.assignees.map((actor) => actor.login),
          current.written,
        );
        if (assignees === null) return;
        const sent = { ...current, written: assignees };
        setStored(sent);
        void update({ ...target, input: { ...target.input, assignees } }).then((response) => {
          const failure = issueCommandError(response);
          if (failure === null) return refreshIssueLists(target.environmentId);
          // Picks made after this write was sent are kept.
          setStored((latest) => issuePicksAfterFailedWrite(latest, sent));
          Dialog.alert(m(msg("Couldn't change assignees")), failure);
        });
      }),
    [navigation, detail, draft, current, setStored, update, target],
  );
  return (
    <IssueCandidatesSheet
      title={gt("Assignees")}
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
          ? (access?.blocked ?? gt("Changing assignees needs triage access on this tracker."))
          : null
      }
      pending={result.isPending && !result.data}
      loadError={result.data ? null : result.error}
      onRetry={result.refresh}
      truncated={result.data?.truncated === true}
      onToggle={(id) => {
        const candidate = candidates.find((entry) => entry.id === id);
        if (candidate) {
          setPicks({ ...current, draft: toggleSelection(draft, id, candidate, held(candidate)) });
        }
      }}
    />
  );
}
