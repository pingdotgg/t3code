/**
 * Resolves Tempo capacity (spec §10.2) for the backlog dashboard: picks the
 * capacity sprint window (selected, else active), the assignee account set, and
 * the dominant project key, then queries useTempoCapacity. Only enabled for the
 * planning-space view. Split out of t3work-ProjectDashboardBacklogView.tsx.
 */

import { useMemo } from "react";

import { useTempoCapacity } from "~/t3work/hooks/t3work-useTempoCapacity";
import type { ProjectTicket } from "~/t3work/t3work-types";

interface CapacitySprint {
  readonly id: string;
  readonly state?: string | null | undefined;
  readonly startDate?: string | null | undefined;
  readonly endDate?: string | null | undefined;
}

export function useProjectDashboardBacklogCapacity(input: {
  tickets: readonly ProjectTicket[];
  sprints: readonly CapacitySprint[];
  selectedSprintId: string | undefined;
  enabled: boolean;
  projectAccountId: string | undefined;
}): ReturnType<typeof useTempoCapacity> {
  const { tickets, sprints, selectedSprintId, enabled, projectAccountId } = input;

  // The selected sprint's date window bounds the availability query; without a
  // selection, the active sprint's window is used.
  const capacitySprint = useMemo(() => {
    const selected = selectedSprintId
      ? sprints.find((sprint) => sprint.id === selectedSprintId)
      : undefined;
    return selected ?? sprints.find((sprint) => sprint.state?.toLowerCase() === "active");
  }, [sprints, selectedSprintId]);

  const sprintAccountIds = useMemo(
    () => [
      ...new Set(
        tickets
          .map((ticket) => ticket.assigneeAccountId)
          .filter((accountId): accountId is string => Boolean(accountId)),
      ),
    ],
    [tickets],
  );

  // Project key (e.g. "IES") = dominant ticket key prefix; lets the server
  // classify Tempo plans on other projects' issues as unavailability.
  const projectKey = useMemo(() => {
    const counts = new Map<string, number>();
    for (const ticket of tickets) {
      const prefix = ticket.ref.displayId.split("-")[0];
      if (prefix) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }, [tickets]);

  return useTempoCapacity({
    enabled,
    accountIds: sprintAccountIds,
    from: capacitySprint?.startDate?.slice(0, 10),
    to: capacitySprint?.endDate?.slice(0, 10),
    projectKey,
    atlassianAccountId: projectAccountId,
  });
}
