import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import {
  applyRemoteRunStatus,
  indexActivityByIssueId,
  mergeLinearActivity,
  remoteRunEnvironmentsKey,
} from "@t3tools/client-runtime/linear/activity";
import {
  resolveLinearDegradation,
  type LinearDegradation,
} from "@t3tools/client-runtime/linear/degradation";
import { LINEAR_POLL_INTERVAL_MS } from "@t3tools/client-runtime/state/linear";
import type {
  EnvironmentId,
  LinearConnectionStatus,
  LinearIssueActivity,
  LinearIssueFilter,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useAppActive } from "../../lib/appState";
import { useNowAfter } from "../../lib/clock";
import { useEnvironments } from "../../state/environments";
import { linearEnvironment, linearEnvironmentIdAtom } from "../../state/linear";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

/** Linear is read through one connected environment (see `resolveLinearEnvironmentId`). */
export function useLinearEnvironmentId(): EnvironmentId | null {
  return useAtomValue(linearEnvironmentIdAtom);
}

export function useLinearStatus(
  environmentId: EnvironmentId | null,
): EnvironmentQueryView<LinearConnectionStatus> {
  return useEnvironmentQuery(
    environmentId === null ? null : linearEnvironment.status({ environmentId, input: {} }),
  );
}

export function useLinearTeamMetadata(
  environmentId: EnvironmentId | null,
  teamId: string | undefined,
) {
  return useEnvironmentQuery(
    environmentId === null || teamId === undefined
      ? null
      : linearEnvironment.teamMetadata({ environmentId, input: { teamId } }),
  );
}

export function useLinearProjects(
  environmentId: EnvironmentId | null,
  teamId: string | undefined,
  enabled = true,
) {
  return useEnvironmentQuery(
    environmentId === null || !enabled
      ? null
      : linearEnvironment.projects({
          environmentId,
          input: teamId === undefined ? {} : { teamId },
        }),
  );
}

export function useLinearMilestones(
  environmentId: EnvironmentId | null,
  projectId: string | undefined,
) {
  return useEnvironmentQuery(
    environmentId === null || projectId === undefined
      ? null
      : linearEnvironment.milestones({ environmentId, input: { projectId } }),
  );
}

export function useLinearIssues(
  environmentId: EnvironmentId | null,
  filter: LinearIssueFilter | null,
) {
  return useEnvironmentQuery(
    environmentId === null || filter === null
      ? null
      : linearEnvironment.issues({ environmentId, input: filter }),
  );
}

export function useLinearIssueDetail(
  environmentId: EnvironmentId | null,
  issueId: string | undefined,
) {
  return useEnvironmentQuery(
    environmentId === null || issueId === undefined
      ? null
      : linearEnvironment.issueDetail({ environmentId, input: { issueId } }),
  );
}

export function useLinearSubIssues(
  environmentId: EnvironmentId | null,
  issueId: string | undefined,
) {
  return useEnvironmentQuery(
    environmentId === null || issueId === undefined
      ? null
      : linearEnvironment.subIssues({ environmentId, input: { issueId } }),
  );
}

export function useLinearViews(environmentId: EnvironmentId | null, enabled = true) {
  return useEnvironmentQuery(
    environmentId === null || !enabled
      ? null
      : linearEnvironment.views({ environmentId, input: {} }),
  );
}

export function useLinearSearchIssues(environmentId: EnvironmentId | null, term: string) {
  const trimmed = term.trim();
  return useEnvironmentQuery(
    environmentId === null || trimmed.length === 0
      ? null
      : linearEnvironment.search({ environmentId, input: { term: trimmed.slice(0, 200) } }),
  );
}

const EMPTY_ACTIVITY: ReadonlyArray<LinearIssueActivity> = [];

/**
 * Reads the T3 activity of linked issues; `enabled` stays false while Linear is not connected.
 * Machines connected to the same Linear workspace add their own activity, and runs on other
 * machines show live state while this app is connected to them.
 */
export function useLinearActivity(environmentId: EnvironmentId | null, enabled = true) {
  const { environments } = useEnvironments();
  const query = useEnvironmentQuery(
    environmentId === null || !enabled
      ? null
      : linearEnvironment.activity({ environmentId, input: {} }),
  );
  const connectedPeers = environments
    .filter(
      (environment) =>
        environment.environmentId !== environmentId && environment.connection.phase === "connected",
    )
    .map((environment) => environment.environmentId);
  const peers = useAtomValue(
    linearEnvironment.peerActivity(
      environmentId === null || !enabled || query.data === null
        ? ""
        : [environmentId, ...connectedPeers].join("\n"),
    ),
  );
  const merged = mergeLinearActivity({ primary: query.data?.issues ?? EMPTY_ACTIVITY, peers });
  const liveRuns = useAtomValue(
    serverEnvironment.pipelineLiveRunsAtom(remoteRunEnvironmentsKey(merged, connectedPeers)),
  );
  const issues = applyRemoteRunStatus(merged, liveRuns);
  return { ...query, issues, byIssueId: indexActivityByIssueId(issues) };
}

const RETURN_REFRESH_MIN_GAP_MS = 15_000;

/**
 * Re-reads the given queries of the focused Linear screen when it comes into view or the app
 * returns to the foreground, then every 60s while it stays that way. Screens left underneath in
 * the stack, hidden tabs and the background never poll; server pushes still reach every query.
 */
export function useLinearAutoRefresh(
  visible: boolean,
  queries: ReadonlyArray<{ readonly refresh: () => void }>,
) {
  const focused = useIsFocused();
  const appActive = useAppActive();
  const enabled = visible && focused && appActive;
  // Mounting already reads every query, so the first poll waits for a later return.
  const [mountedAt] = useState(Date.now);
  const lastPollAt = useRef<number | null>(null);
  const poll = useEffectEvent(() => {
    lastPollAt.current = Date.now();
    for (const query of queries) query.refresh();
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that re-reads this screen's queries while it is focused and the app is foregrounded
  useEffect(() => {
    if (!enabled) return;
    // Focus and AppState changes arrive in bursts (Control Center, app switching).
    if (Date.now() - (lastPollAt.current ?? mountedAt) >= RETURN_REFRESH_MIN_GAP_MS) poll();
    const interval = setInterval(poll, LINEAR_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled, mountedAt]);
}

/** Commands bound to the Linear environment. */
function useLinearCommands(environmentId: EnvironmentId | null) {
  const refresh = useAtomCommand(linearEnvironment.refresh, { reportFailure: false });
  return {
    environmentId,
    // The server pushes a refresh afterwards, which re-reads every mounted query.
    refresh: () =>
      environmentId === null ? Promise.resolve(null) : refresh({ environmentId, input: {} }),
  };
}

/** Manual refresh: drops the server's Linear caches, then every mounted read re-runs. */
export function useLinearRefresh(environmentId: EnvironmentId | null) {
  const commands = useLinearCommands(environmentId);
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
  environmentId: EnvironmentId | null,
  failures: ReadonlyArray<unknown>,
  stale: boolean,
): LinearDegradation | null {
  const status = useLinearStatus(environmentId);
  const rateLimitedUntil = status.data?.rateLimitedUntil;
  const now = useNowAfter(rateLimitedUntil == null ? null : Date.parse(rateLimitedUntil));
  return resolveLinearDegradation({
    failures: status.failure === null ? failures : [...failures, status.failure],
    stale,
    status: status.data,
    now,
  });
}
