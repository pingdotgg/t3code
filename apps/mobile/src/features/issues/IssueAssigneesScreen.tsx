import type { StaticScreenProps } from "@react-navigation/native";
import { useRef, useState } from "react";

import { issueEnvironment } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestAvatar } from "../pull-requests/PullRequestPresentation";
import { IssueCandidatesSheet } from "./IssueCandidatesSheet";
import { issueTarget, type IssueParams } from "./issueParams";
import { issueCommandError, useIssueAccess } from "./issuePresentation";

export function IssueAssigneesScreen({ route }: StaticScreenProps<IssueParams>) {
  const target = issueTarget(route.params);
  const detail = useEnvironmentQuery(issueEnvironment.detail(target)).data;
  const access = useIssueAccess(route.params, detail);
  const result = useEnvironmentQuery(issueEnvironment.candidates(target));
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<{ readonly id: string; readonly assigned: boolean }>();
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const allowed = access?.assignees === true;
  const assigned = new Set(detail?.assignees.map((actor) => actor.login.toLowerCase()));
  const needle = query.trim().toLowerCase();
  const candidates = (result.data?.assignees ?? []).filter((candidate) =>
    `${candidate.login} ${candidate.name ?? ""}`.toLowerCase().includes(needle),
  );
  const toggle = async (id: string) => {
    const candidate = candidates.find((entry) => entry.id === id);
    if (!detail || !candidate || !allowed || inFlight.current) return;
    inFlight.current = true;
    const login = candidate.login.toLowerCase();
    setPending({ id, assigned: !assigned.has(login) });
    setError(null);
    // The whole set is written: people already assigned by login, the new one by tracker id.
    const assignees = assigned.has(login)
      ? detail.assignees
          .filter((actor) => actor.login.toLowerCase() !== login)
          .map((actor) => actor.login)
      : [...detail.assignees.map((actor) => actor.login), candidate.id];
    const failure = issueCommandError(
      await update({ ...target, input: { ...target.input, assignees } }),
    );
    inFlight.current = false;
    setPending(undefined);
    setError(failure);
  };
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
        selected:
          pending?.id === candidate.id
            ? pending.assigned
            : assigned.has(candidate.login.toLowerCase()),
      }))}
      allowed={allowed}
      notice={
        detail && !allowed
          ? (access?.blocked ?? "Changing assignees needs triage access on this tracker.")
          : null
      }
      error={error}
      pending={result.isPending && !result.data}
      loadError={result.data ? null : result.error}
      onRetry={result.refresh}
      truncated={result.data?.truncated === true}
      onToggle={(id) => void toggle(id)}
    />
  );
}
