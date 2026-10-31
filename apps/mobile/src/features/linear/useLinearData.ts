import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import { indexActivityByIssueId } from "@t3tools/client-runtime/linear/activity";
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
import { useEffect, useState } from "react";

import { useAppActive } from "../../lib/appState";
import { useNowAfter } from "../../lib/clock";
import { appAtomRegistry } from "../../state/atom-registry";
import {
  linearEnvironment,
  linearEnvironmentIdAtom,
  linearSelectedEnvironmentIdAtom,
} from "../../state/linear";
import { useEnvironmentQuery, type EnvironmentQueryView } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

/** Linear is read through one connected environment (see `resolveLinearEnvironmentId`). */
export function useLinearEnvironmentId(): EnvironmentId | null {
  return useAtomValue(linearEnvironmentIdAtom);
}

/**
 * A pushed Linear screen names its environment in its route; the launch flows read the shared
 * pick, so a deep link to another environment makes it the pick.
 */
export function useAdoptLinearEnvironment(environmentId: EnvironmentId) {
  const current = useLinearEnvironmentId();
  const select = useAtomSet(linearSelectedEnvironmentIdAtom);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a route's environment becomes the session's Linear environment pick
  useEffect(() => {
    if (current !== environmentId) select(environmentId);
  }, [current, environmentId, select]);
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

/** Reads the T3 activity of linked issues; `enabled` stays false while Linear is not connected. */
export function useLinearActivity(environmentId: EnvironmentId | null, enabled = true) {
  const query = useEnvironmentQuery(
    environmentId === null || !enabled
      ? null
      : linearEnvironment.activity({ environmentId, input: {} }),
  );
  const issues = query.data?.issues ?? EMPTY_ACTIVITY;
  return { ...query, issues, byIssueId: indexActivityByIssueId(issues) };
}

let lastPollBumpAt = 0;

function bumpLinearPollTick() {
  lastPollBumpAt = Date.now();
  appAtomRegistry.update(linearEnvironment.pollTick, (tick) => tick + 1);
}

const RETURN_REFRESH_MIN_GAP_MS = 15_000;

/**
 * Re-reads Linear when the screen comes into view or the app returns to the foreground, then
 * every 60s while it stays that way. Nothing runs in the background or on a hidden tab.
 */
export function useLinearAutoRefresh(visible: boolean) {
  const focused = useIsFocused();
  const appActive = useAppActive();
  const enabled = visible && focused && appActive;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that bumps the shared poll tick while the Linear screen is visible and the app is foregrounded
  useEffect(() => {
    if (!enabled) return;
    // Focus and AppState changes arrive in bursts (Control Center, app switching).
    if (Date.now() - lastPollBumpAt >= RETURN_REFRESH_MIN_GAP_MS) bumpLinearPollTick();
    const interval = setInterval(bumpLinearPollTick, LINEAR_POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [enabled]);
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
