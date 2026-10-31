import type {
  EnvironmentId,
  LinearConnectionStatus,
  LinearIssueFilter,
  LinearIssueActivity,
  PipelineDefinition,
} from "@t3tools/contracts";
import { LINEAR_POLL_INTERVAL_MS } from "@t3tools/client-runtime/state/linear";
import { useEffect, useState } from "react";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { linearEnvironment } from "../../state/linear";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  resolveLinearDegradation,
  type LinearDegradation,
} from "@t3tools/client-runtime/linear/degradation";
import { indexActivityByIssueId } from "@t3tools/client-runtime/linear/activity";

/** Linear is read through the primary environment only. */
export const useLinearEnvironmentId = usePrimaryEnvironmentId;

export function useLinearStatus(): EnvironmentQueryView<LinearConnectionStatus> {
  const environmentId = useLinearEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null ? null : linearEnvironment.status({ environmentId, input: {} }),
  );
}

export function useLinearTeamMetadata(teamId: string | undefined) {
  const environmentId = useLinearEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || teamId === undefined
      ? null
      : linearEnvironment.teamMetadata({ environmentId, input: { teamId } }),
  );
}

export function useLinearProjects(teamId: string | undefined, enabled = true) {
  const environmentId = useLinearEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || !enabled
      ? null
      : linearEnvironment.projects({
          environmentId,
          input: teamId === undefined ? {} : { teamId },
        }),
  );
}

export function useLinearMilestones(projectId: string | undefined) {
  const environmentId = useLinearEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || projectId === undefined
      ? null
      : linearEnvironment.milestones({ environmentId, input: { projectId } }),
  );
}

export function useLinearIssues(filter: LinearIssueFilter | null) {
  const environmentId = useLinearEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || filter === null
      ? null
      : linearEnvironment.issues({ environmentId, input: filter }),
  );
}

export function useLinearIssueDetail(issueId: string | undefined) {
  const environmentId = useLinearEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || issueId === undefined
      ? null
      : linearEnvironment.issueDetail({ environmentId, input: { issueId } }),
  );
}

export function useLinearSubIssues(issueId: string | undefined) {
  const environmentId = useLinearEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || issueId === undefined
      ? null
      : linearEnvironment.subIssues({ environmentId, input: { issueId } }),
  );
}

export function useLinearViews(enabled = true) {
  const environmentId = useLinearEnvironmentId();
  return useEnvironmentQuery(
    environmentId === null || !enabled
      ? null
      : linearEnvironment.views({ environmentId, input: {} }),
  );
}

export function useLinearSearchIssues(term: string) {
  const environmentId = useLinearEnvironmentId();
  const trimmed = term.trim();
  return useEnvironmentQuery(
    environmentId === null || trimmed.length === 0
      ? null
      : linearEnvironment.search({ environmentId, input: { term: trimmed.slice(0, 200) } }),
  );
}

/** Reads the T3 activity of linked issues; `enabled` stays false while Linear is not connected. */
export function useLinearActivity(enabled = true) {
  const environmentId = useLinearEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null || !enabled
      ? null
      : linearEnvironment.activity({ environmentId, input: {} }),
  );
  const issues: ReadonlyArray<LinearIssueActivity> = query.data?.issues ?? EMPTY_ACTIVITY;
  const byIssueId = indexActivityByIssueId(issues);
  return { ...query, issues, byIssueId };
}

const EMPTY_ACTIVITY: ReadonlyArray<LinearIssueActivity> = [];

/** Saved pipelines of the primary environment, for the "Run pipeline" menu. */
export function useLinearPipelines() {
  const environmentId = useLinearEnvironmentId();
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.pipelinesLive({ environmentId, input: {} }),
  );
  return query.data?.pipelines ?? EMPTY_PIPELINES;
}

const EMPTY_PIPELINES: ReadonlyArray<PipelineDefinition> = [];

function bumpLinearPollTick() {
  appAtomRegistry.update(linearEnvironment.pollTick, (tick) => tick + 1);
}

const RETURN_REFRESH_MIN_GAP_MS = 15_000;

/** Re-reads Linear every 60s while the page is visible and when the window regains focus. */
export function useLinearPolling(enabled: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timers and window listeners that bump the shared poll tick while the Linear page is mounted
  useEffect(() => {
    if (!enabled) return;
    let lastBumpAt = Date.now();
    const bump = () => {
      lastBumpAt = Date.now();
      bumpLinearPollTick();
    };
    const refreshIfVisible = () => {
      if (document.visibilityState === "visible") bump();
    };
    // Focus and visibilitychange both fire on one return, and app switching refocuses often.
    const refreshOnReturn = () => {
      if (Date.now() - lastBumpAt >= RETURN_REFRESH_MIN_GAP_MS) refreshIfVisible();
    };
    const interval = window.setInterval(refreshIfVisible, LINEAR_POLL_INTERVAL_MS);
    window.addEventListener("focus", refreshOnReturn);
    document.addEventListener("visibilitychange", refreshOnReturn);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refreshOnReturn);
      document.removeEventListener("visibilitychange", refreshOnReturn);
    };
  }, [enabled]);
}

/** Commands bound to the primary environment. */
export function useLinearCommands() {
  const environmentId = useLinearEnvironmentId();
  const refresh = useAtomCommand(linearEnvironment.refresh, { reportFailure: false });
  const resync = useAtomCommand(linearEnvironment.resync, { reportFailure: false });
  const connect = useAtomCommand(linearEnvironment.connect, { reportFailure: false });
  const disconnect = useAtomCommand(linearEnvironment.disconnect, { reportFailure: false });
  const recordLaunch = useAtomCommand(linearEnvironment.recordLaunch, { reportFailure: false });
  const withEnvironment = <T>(run: (environmentId: EnvironmentId) => Promise<T>) =>
    environmentId === null ? Promise.resolve(null) : run(environmentId);
  return {
    environmentId,
    // The server pushes a refresh after both, which re-reads every mounted query.
    refresh: () => withEnvironment((id) => refresh({ environmentId: id, input: {} })),
    resync: () => withEnvironment((id) => resync({ environmentId: id, input: {} })),
    connect: (apiKey: string) =>
      withEnvironment((id) => connect({ environmentId: id, input: { apiKey } })),
    disconnect: () => withEnvironment((id) => disconnect({ environmentId: id, input: {} })),
    recordLaunch: (input: Parameters<typeof recordLaunch>[0]["input"]) =>
      withEnvironment((id) => recordLaunch({ environmentId: id, input })),
  };
}

/** Manual refresh: drops the server's Linear caches, then every mounted read re-runs. */
export function useLinearRefresh() {
  const commands = useLinearCommands();
  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    if (refreshing) return;
    setRefreshing(true);
    void commands.refresh().finally(() => setRefreshing(false));
  };
  return { refresh, refreshing };
}

/** One banner for every panel: any failed or stale read, or a rate limit the server reports. */
export function useLinearDegradation(
  failures: ReadonlyArray<unknown>,
  stale: boolean,
): LinearDegradation | null {
  const status = useLinearStatus();
  return resolveLinearDegradation({
    failures: status.failure === null ? failures : [...failures, status.failure],
    stale,
    status: status.data,
    now: status.dataUpdatedAt,
  });
}
