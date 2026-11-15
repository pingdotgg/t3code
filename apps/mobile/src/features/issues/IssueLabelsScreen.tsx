import type { StaticScreenProps } from "@react-navigation/native";
import { useRef, useState } from "react";

import { issueEnvironment } from "../../state/issues";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { PullRequestLabelDot } from "../pull-requests/PullRequestLabelDot";
import { pullRequestLabelColor } from "../pull-requests/pullRequestList";
import { IssueCandidatesSheet } from "./IssueCandidatesSheet";
import { issueTarget, type IssueParams } from "./issueParams";
import { issueCommandError, useIssueAccess } from "./issuePresentation";

export function IssueLabelsScreen({ route }: StaticScreenProps<IssueParams>) {
  const target = issueTarget(route.params);
  const detail = useEnvironmentQuery(issueEnvironment.detail(target)).data;
  const access = useIssueAccess(route.params, detail);
  const result = useEnvironmentQuery(issueEnvironment.candidates(target));
  const update = useAtomCommand(issueEnvironment.update, { reportFailure: false });
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<{ readonly name: string; readonly applied: boolean }>();
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const allowed = access?.labels === true;
  const applied = new Set(detail?.labels.map((label) => label.name));
  const needle = query.trim().toLowerCase();
  // Host order, not applied-first: re-sorting on toggle would move the row out from under a tap.
  const candidates = (result.data?.labels ?? []).filter((label) =>
    `${label.name} ${label.description ?? ""}`.toLowerCase().includes(needle),
  );
  const toggle = async (name: string) => {
    if (!detail || !allowed || inFlight.current) return;
    inFlight.current = true;
    setPending({ name, applied: !applied.has(name) });
    setError(null);
    // The tracker takes the whole set, so the change is written against what the detail holds.
    const labels = applied.has(name)
      ? detail.labels.filter((label) => label.name !== name).map((label) => label.name)
      : [...applied, name];
    const failure = issueCommandError(
      await update({ ...target, input: { ...target.input, labels } }),
    );
    inFlight.current = false;
    setPending(undefined);
    setError(failure);
  };
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
        // The change shows as soon as it is tapped; a failure puts the tracker's answer back.
        selected: pending?.name === label.name ? pending.applied : applied.has(label.name),
      }))}
      allowed={allowed}
      notice={
        detail && !allowed
          ? (access?.blocked ?? "Changing labels needs triage access on this tracker.")
          : null
      }
      error={error}
      pending={result.isPending && !result.data}
      loadError={result.data ? null : result.error}
      onRetry={result.refresh}
      truncated={result.data?.truncated === true}
      onToggle={(name) => void toggle(name)}
    />
  );
}
