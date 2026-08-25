/**
 * What a conversation about a report needs from PostHog: the report rendered
 * as markdown for the first message, and the branch name a worktree for it
 * should use.
 *
 * Returns nulls for threads that are not about a report, so the chat view can
 * call it unconditionally.
 */
import { PostHogReportId, type EnvironmentId } from "@t3tools/contracts";
import { renderReportPrompt } from "@t3tools/shared/posthogReportPrompt";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { postHogEnvironment, reportsListAtom } from "../../state/posthog";
import { useEnvironmentQuery } from "../../state/query";
import { primaryServerSettingsAtom } from "../../state/server";
import { vcsEnvironment } from "../../state/vcs";

/** The branch a report's worktree wants, before collisions are resolved. */
export function reportBranchName(reportId: string): string {
  return `posthog/${reportId.slice(0, 8)}`;
}

/**
 * `posthog/<report>`, or the first free `-2`, `-3`, ... variant. Git's
 * `worktree add -b` fails outright when the branch already exists, so the
 * name has to be free before the call.
 */
export function resolveReportBranchName(
  base: string,
  existingBranchNames: ReadonlyArray<string>,
): string {
  const existing = new Set(existingBranchNames.map((name) => name.toLowerCase()));
  if (!existing.has(base.toLowerCase())) return base;
  let suffix = 2;
  while (existing.has(`${base}-${suffix}`.toLowerCase())) suffix += 1;
  return `${base}-${suffix}`;
}

export interface ReportThreadContext {
  /** The report and its artefacts as markdown, or null while it loads. */
  readonly reportPrompt: string | null;
  /** What the message's report chip reads. */
  readonly reportTitle: string | null;
  /** `posthog/<report>` with a numeric suffix when that branch already exists. */
  readonly worktreeBranchName: string | null;
}

const EMPTY_CONTEXT: ReportThreadContext = {
  reportPrompt: null,
  reportTitle: null,
  worktreeBranchName: null,
};

export function useReportThreadContext({
  environmentId,
  reportId,
  projectCwd,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly reportId: string | null;
  readonly projectCwd: string | null;
}): ReportThreadContext {
  const active = environmentId !== null && reportId !== null;
  const serverSettings = useAtomValue(primaryServerSettingsAtom);
  const reportsQuery = useEnvironmentQuery(active ? reportsListAtom(environmentId) : null);
  const artefactsQuery = useEnvironmentQuery(
    active
      ? postHogEnvironment.artefacts({
          environmentId,
          input: { reportId: PostHogReportId.make(reportId) },
        })
      : null,
  );
  const baseBranch = reportId === null ? null : reportBranchName(reportId);
  // Local branches whose name starts with the report branch tell us which
  // suffix is free. `-b` fails outright when the branch already exists.
  const refsQuery = useEnvironmentQuery(
    active && projectCwd !== null && baseBranch !== null
      ? vcsEnvironment.listRefs({
          environmentId,
          input: { cwd: projectCwd, query: baseBranch, refKind: "local", limit: 20 },
        })
      : null,
  );

  const report = useMemo(
    () => reportsQuery.data?.reports.find((entry) => entry.id === reportId) ?? null,
    [reportId, reportsQuery.data],
  );

  return useMemo(() => {
    if (!active) return EMPTY_CONTEXT;
    const reportPrompt =
      report === null
        ? null
        : renderReportPrompt(report, artefactsQuery.data?.artefacts ?? [], {
            host: serverSettings.posthog.host,
            projectId: serverSettings.posthog.projectId,
          });
    const worktreeBranchName =
      baseBranch === null
        ? null
        : resolveReportBranchName(
            baseBranch,
            (refsQuery.data?.refs ?? []).map((ref) => ref.name),
          );
    return { reportPrompt, reportTitle: report?.title ?? null, worktreeBranchName };
  }, [
    active,
    artefactsQuery.data,
    baseBranch,
    refsQuery.data,
    report,
    serverSettings.posthog.host,
    serverSettings.posthog.projectId,
  ]);
}
