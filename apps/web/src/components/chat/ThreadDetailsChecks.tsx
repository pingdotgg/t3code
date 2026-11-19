import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { findProjectForChangeRequest } from "@t3tools/client-runtime/change-request-links";
import { resolvePullRequestDetailChecks } from "@t3tools/client-runtime/pull-request-checks";
import type { ScopedThreadRef, PullRequestRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { useProjects, useQuietThreadShell, useServerConfigs } from "../../state/entities";
import { pullRequestEnvironment } from "../../state/pullRequests";
import { useEnvironmentQuery, useEnvironmentQueryIsNewer } from "../../state/query";
import { usePullRequestChecksRefresh } from "../../hooks/usePullRequestChecksRefresh";
import { useThreadDisplayedPullRequest } from "../ThreadStatusIndicators";
import { PullRequestChecksBody } from "../pullRequest/PullRequestChecksPopover";
import { ThreadDetailsSection } from "./ThreadDetailsSection";

export function ThreadDetailsChecks({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const thread = useQuietThreadShell(threadRef);
  const displayed = useThreadDisplayedPullRequest(threadRef.environmentId, thread);
  const projects = useProjects();
  const supportsChecks =
    useServerConfigs().get(threadRef.environmentId)?.environment.capabilities.pullRequestChecks ===
    true;
  const parsed = displayed.url
    ? sourceControlClients.parseChangeRequestUrl(displayed.url)?.link
    : null;
  const environmentProjects = projects.filter(
    (entry) => entry.environmentId === threadRef.environmentId,
  );
  const project = parsed
    ? (findProjectForChangeRequest(environmentProjects, parsed) ??
      environmentProjects.find((entry) => entry.id === thread?.projectId) ??
      null)
    : null;
  const reference: PullRequestRef | null =
    supportsChecks && parsed && project
      ? {
          host: parsed.host,
          repository: parsed.repository,
          number: parsed.number,
          projectId: project.id,
        }
      : null;
  const detailAtom = reference
    ? pullRequestEnvironment.detail({ environmentId: threadRef.environmentId, input: reference })
    : null;
  const checksAtom = reference
    ? pullRequestEnvironment.checks({ environmentId: threadRef.environmentId, input: reference })
    : null;
  const detailQuery = useEnvironmentQuery(detailAtom);
  const checksQuery = useEnvironmentQuery(checksAtom);
  const newer = useEnvironmentQueryIsNewer(checksAtom, detailAtom);
  const detail = resolvePullRequestDetailChecks(detailQuery.data, checksQuery.data, newer);
  const checks = detail?.checks ?? checksQuery.data?.checks ?? [];
  usePullRequestChecksRefresh({
    refresh: () => {
      if (!checksQuery.isPending) checksQuery.refresh();
    },
    enabled: reference !== null && (detail?.state ?? displayed.pr?.state) === "open",
    key: `details-checks:${threadRef.environmentId}:${reference?.host}:${reference?.repository}:${reference?.number}`,
    checks,
  });
  if (reference === null || checks.length === 0) return null;
  const passed = checks.filter((check) => check.status === "success").length;
  return (
    <ThreadDetailsSection
      headingId="thread-details-checks-heading"
      title={gt("Checks")}
      actions={
        <span className="pr-2 text-xs text-muted-foreground tabular-nums">
          {passed}/{checks.length} <T>passed</T>
        </span>
      }
    >
      <div data-thread-details-checks className="px-2.5 py-1">
        <PullRequestChecksBody checks={checks} threadRef={threadRef} />
      </div>
    </ThreadDetailsSection>
  );
}
